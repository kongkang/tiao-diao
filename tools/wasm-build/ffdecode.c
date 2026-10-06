/**
 * ffdecode.c —— 最小化 FFmpeg WASM 解码垫片 v2（拉取式流式接口）
 *
 * v2 变化：一次性 ff_decode（整个输出在 wasm 堆里累积，堆膨胀后永不回缩）
 * 改为 ff_open / ff_pull / ff_pull_free 三段式：
 *   ff_open(字节, 长度)  打开+定位音频流，不读完全部数据（wasm 堆峰值 ≈ 输入文件大小）
 *   ff_pull(dst, max)    每次拷最多 max 个 float 到 dst，返回实际数；0=解完
 *   ff_close()           释放全部
 * 调用方在 JS 堆里累积 PCM，wasm 堆保持小体积（解决真机 worker 被杀的主因之一）。
 *
 * JS 调用协议：
 *   const p = malloc(bytes.length); heap.set(bytes, p);
 *   if (ff_open(p, len) === 0) {
 *     const chunk = malloc(CHUNK_FLOATS*4)
 *     while ((n = ff_pull(chunk, CHUNK_FLOATS)) > 0) { 读 memory 拷走 }
 *     ff_close()
 *   }
 *
 * 错误码（ff_err）：1=内存不足 2=容器打不开/损坏 3=无音频轨 4=解码器打不开(可能加密)
 *                  5=采样格式不支持 6=没解出数据 7=状态错误
 */

#include <stdlib.h>
#include <string.h>
#include <libavutil/mem.h>
#include <libavformat/avformat.h>
#include <libavcodec/avcodec.h>

static int g_rate = 0, g_channels = 0, g_err = 0;
static AVFormatContext *g_fmt = NULL;
static AVCodecContext *g_cdc = NULL;
static AVFrame *g_frame = NULL;
static AVPacket *g_pkt = NULL;
static AVIOContext *g_io = NULL;
static int g_stream = -1;
static int g_opened = 0;
static int g_frame_pos = 0;   // 当前帧内已消费的样本索引（交错计数）
static int g_eof_sent = 0;    // 已向解码器发送 NULL（冲刷信号）
static int g_pending = 0;     // g_pkt 里还有没送进解码器的包（输入满时暂存）

int ff_rate(void) { return g_rate; }
int ff_channels(void) { return g_channels; }
int ff_err(void) { return g_err; }

/** 容器声明的时长（秒，估计值，用于调用方预分配；拿不到返回 0） */
double ff_duration_sec(void) {
  if (!g_fmt || g_fmt->duration <= 0) return 0;
  return g_fmt->duration / 1000000.0;
}

typedef struct {
  const uint8_t *data;
  int size;
  int64_t pos;
} MemCtx;
static MemCtx g_memctx;

static int read_packet(void *opaque, uint8_t *buf, int buf_size) {
  MemCtx *c = (MemCtx *)opaque;
  int64_t n = c->size - c->pos;
  if (n <= 0) return AVERROR_EOF;
  if (n > buf_size) n = buf_size;
  memcpy(buf, c->data + c->pos, (size_t)n);
  c->pos += n;
  return (int)n;
}

static int64_t seek_cb(void *opaque, int64_t offset, int whence) {
  MemCtx *c = (MemCtx *)opaque;
  if (whence & AVSEEK_SIZE) return c->size;
  if (whence == SEEK_CUR) c->pos += offset;
  else if (whence == SEEK_SET) c->pos = offset;
  else if (whence == SEEK_END) c->pos = c->size + offset;
  else return -1;
  if (c->pos < 0) c->pos = 0;
  if (c->pos > c->size) c->pos = c->size;
  return c->pos;
}

void ff_close(void) {
  av_packet_free(&g_pkt);
  av_frame_free(&g_frame);
  avcodec_free_context(&g_cdc);
  if (g_fmt) avformat_close_input(&g_fmt);
  if (g_io) {          // open 成功后 pb 归 fmt 托管已释放；失败时由这里兜底
    if (g_io->buffer) { av_free(g_io->buffer); g_io->buffer = NULL; }
    avio_context_free(&g_io);
  }
  g_fmt = NULL;
  g_io = NULL;
  g_stream = -1;
  g_opened = 0;
  g_frame_pos = 0;
  g_eof_sent = 0;
  g_pending = 0;
}

/** 打开输入并定位音频流。返回 0 成功，-1 失败（看 ff_err） */
int ff_open(const uint8_t *in, int in_len) {
  ff_close();
  g_err = 0;
  g_rate = 0;
  g_channels = 0;

  uint8_t *avio_buf = av_malloc(64 * 1024);
  if (!avio_buf) { g_err = 1; goto fail; }
  g_io = avio_alloc_context(avio_buf, 64 * 1024, 0, NULL, read_packet, NULL, seek_cb);
  if (!g_io) { av_free(avio_buf); g_err = 1; goto fail; }

  g_memctx.data = in;
  g_memctx.size = in_len;
  g_memctx.pos = 0;
  g_io->opaque = &g_memctx;

  g_fmt = avformat_alloc_context();
  if (!g_fmt) { g_err = 1; goto fail; }
  g_fmt->pb = g_io;

  if (avformat_open_input(&g_fmt, NULL, NULL, NULL) < 0) {
    g_fmt = NULL;        // open 失败时 ffmpeg 已释放 fmt，pb 归还调用者
    g_io = NULL;         // 防止 ff_close 里二次释放（buffer 已随 open 失败释放）
    g_err = 2;
    goto fail;
  }
  // open 成功：pb 由 fmt 托管（close_input 会连 buffer 一起释放）
  g_io = NULL;

  if (avformat_find_stream_info(g_fmt, NULL) < 0) { g_err = 2; goto fail; }

  int si = av_find_best_stream(g_fmt, AVMEDIA_TYPE_AUDIO, -1, -1, NULL, 0);
  if (si < 0) { g_err = 3; goto fail; }
  g_stream = si;

  const AVCodec *dec = avcodec_find_decoder(g_fmt->streams[si]->codecpar->codec_id);
  if (!dec) { g_err = 3; goto fail; }
  g_cdc = avcodec_alloc_context3(dec);
  if (!g_cdc) { g_err = 1; goto fail; }
  if (avcodec_parameters_to_context(g_cdc, g_fmt->streams[si]->codecpar) < 0) { g_err = 1; goto fail; }
  if (avcodec_open2(g_cdc, dec, NULL) < 0) { g_err = 4; goto fail; }

  g_frame = av_frame_alloc();
  g_pkt = av_packet_alloc();
  if (!g_frame || !g_pkt) { g_err = 1; goto fail; }

  // 元数据先从流参数取（对外统一封顶 2 声道：drain 只输出前两路）；
  // 个别流要解出首帧才有 → ff_pull 里补
  if (g_cdc->sample_rate > 0) g_rate = g_cdc->sample_rate;
  if (g_cdc->ch_layout.nb_channels > 0) g_channels = g_cdc->ch_layout.nb_channels > 2 ? 2 : g_cdc->ch_layout.nb_channels;

  g_frame_pos = 0;
  g_eof_sent = 0;
  g_pending = 0;
  g_opened = 1;
  return 0;

fail:
  ff_close();
  return -1;
}

/** 把 frame 从 g_frame_pos 起的样本交错拷进 dst（多声道只取前两个），返回拷贝数 */
static int drain_frame(float *dst, int max_floats) {
  if (!g_frame->data[0]) return 0;
  int och = g_frame->ch_layout.nb_channels;   // 原始声道数（packed 格式跨步用）
  int ch = och > 2 ? 2 : och;
  int ns = g_frame->nb_samples;
  int copied = 0;

  if (g_frame->format == AV_SAMPLE_FMT_FLTP) {
    for (; g_frame_pos < ns && copied + ch <= max_floats; g_frame_pos++) {
      for (int c = 0; c < ch; c++) dst[copied++] = ((const float *)g_frame->data[c])[g_frame_pos];
    }
  } else if (g_frame->format == AV_SAMPLE_FMT_S16P) {
    for (; g_frame_pos < ns && copied + ch <= max_floats; g_frame_pos++) {
      for (int c = 0; c < ch; c++) dst[copied++] = ((const int16_t *)g_frame->data[c])[g_frame_pos] / 32768.0f;
    }
  } else if (g_frame->format == AV_SAMPLE_FMT_FLT) {
    const float *src = (const float *)g_frame->data[0];
    for (; g_frame_pos < ns && copied + ch <= max_floats; g_frame_pos++) {
      for (int c = 0; c < ch; c++) dst[copied++] = src[g_frame_pos * och + c];
    }
  } else if (g_frame->format == AV_SAMPLE_FMT_S16) {
    const int16_t *src = (const int16_t *)g_frame->data[0];
    for (; g_frame_pos < ns && copied + ch <= max_floats; g_frame_pos++) {
      for (int c = 0; c < ch; c++) dst[copied++] = src[g_frame_pos * och + c] / 32768.0f;
    }
  } else {
    return -1;   // 不支持的采样格式
  }
  return copied;
}

/** 解码下一帧到 g_frame（含冲刷逻辑）。返回 1 有帧 / 0 结束
 *
 * 关键：mp3/aac 等解码器有预缓冲，输入队列会满 ——
 * avcodec_send_packet 返回 EAGAIN 时包【没有】被消费，必须先把包留在
 * g_pkt（g_pending），收几帧腾出空间后再重发同一个包；
 * 文件读完后发 NULL 冲刷，若此刻输入仍满（EAGAIN），回外层收帧后重发 NULL。
 * 不处理 EAGAIN 会造成「收不到帧、发不进包」的死循环（mp3 真机复现过）。
 */
static int next_frame(void) {
  for (;;) {
    int ret = avcodec_receive_frame(g_cdc, g_frame);
    if (ret >= 0) { g_frame_pos = 0; return 1; }
    if (ret != AVERROR(EAGAIN)) return 0;          // EOF 或错误：结束
    if (g_eof_sent) return 0;                      // 冲刷信号已接受还 EAGAIN：防御性结束

    if (g_pending) {
      // 上次输入满没送进去的包：现在 receive 已腾过空间，重发
      ret = avcodec_send_packet(g_cdc, g_pkt);
      if (ret == 0) { g_pending = 0; av_packet_unref(g_pkt); continue; }
      if (ret != AVERROR(EAGAIN)) { g_pending = 0; av_packet_unref(g_pkt); continue; }
      continue;   // 仍满（理论不会）：回外层 receive
    }

    for (;;) {
      av_packet_unref(g_pkt);
      if (av_read_frame(g_fmt, g_pkt) < 0) {
        // 文件读完：发冲刷信号（一次成功即可；被 EAGAIN 顶掉就回外层收帧后再试）
        if (avcodec_send_packet(g_cdc, NULL) == 0) g_eof_sent = 1;
        break;
      }
      if (g_pkt->stream_index != g_stream) continue;   // 别的流（封面图等），跳过
      ret = avcodec_send_packet(g_cdc, g_pkt);
      if (ret == 0) break;                            // 喂进去了 → 回外层 receive
      if (ret == AVERROR(EAGAIN)) { g_pending = 1; break; }   // 输入满：包保留，回外层收帧
      // 其他错误（坏包）：丢弃，读下一个
    }
  }
}

/** 拉取最多 max_floats 个交错样本。返回实际数；0=解完；-1=错误 */
int ff_pull(float *dst, int max_floats) {
  if (!g_opened) { g_err = 7; return -1; }
  int filled = 0;
  while (filled < max_floats) {
    if (g_frame->data[0] && g_frame_pos < g_frame->nb_samples) {
      int n = drain_frame(dst + filled, max_floats - filled);
      if (n < 0) { g_err = 5; return -1; }
      if (n == 0) break;   // 剩余空间不足一个样本组或空帧：结束本次 pull（零进展会死循环）
      filled += n;
      if (g_frame->ch_layout.nb_channels > 0) {
        if (g_rate == 0) g_rate = g_frame->sample_rate;
        if (g_channels == 0) {
          int fc = g_frame->ch_layout.nb_channels;
          g_channels = fc > 2 ? 2 : fc;
        }
      }
      continue;
    }
    if (next_frame() == 0) break;   // 全部解完
  }
  return filled;
}
