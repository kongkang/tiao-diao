# FFmpeg WASM 解码器构建

产物：`miniprogram/wasm/ffdecode.wasm.br`（约 0.35MB Brotli）。
源码：`ffdecode.c`（薄垫片）+ FFmpeg 7.1.1 静态库。

## 一次性准备

推荐 Homebrew（已验证 2026-11-10）：

```bash
brew install --ignore-dependencies emscripten
# 可选：brew install node python3
```

或者官方 emsdk：

```bash
git clone --depth 1 https://github.com/emscripten-core/emsdk.git ~/Developer/emsdk
~/Developer/emsdk/emsdk install latest
~/Developer/emsdk/emsdk activate latest
```

FFmpeg 源码（脚本会自动下载，也可手动）：

```bash
git clone --depth 1 --branch n7.1.1 https://github.com/FFmpeg/FFmpeg.git ~/Developer/ffmpeg-wasm-src
```

## 构建

```bash
bash tools/wasm-build/build.sh
```

脚本做的事：
1. 校验/安装 emsdk（有系统 `emcc` 时直接用 Homebrew 版）；
2. `emconfigure ./configure --arch=wasm --target-os=none ...`，只开
   `asf/mp3/flac/wav/aac/mov` 容器和
   `wmav1,wmav2,mp3float,flac,aac,pcm_s16le,pcm_f32le,pcm_s24le,pcm_s32le` 解码器；
3. `emmake make` 编静态库，`emcc -Oz -s STANDALONE_WASM` 链接；
4. Brotli 压缩到 `miniprogram/wasm/ffdecode.wasm.br`。

## 导出接口

| 函数 | 说明 |
|---|---|
| `ff_open(ptr,len)` | 打开容器 + 找音频流，不整首解码 |
| `ff_pull(dst,max)` | 拉交错 float PCM；0=EOF；-1=错误 |
| `ff_seek(sec)` | `av_seek_frame(..., AVSEEK_FLAG_BACKWARD)` 随机定位 |
| `ff_tell()` | 当前下一个待拉样本的时间（秒），0 起；用于丢弃 seek pre-roll |
| `ff_close()` | 释放解码器/AVIO（不释放调用方的输入缓冲） |
| `ff_rate/ff_channels/ff_duration_sec/ff_err` | 元数据/错误码 |

错误码：1 内存不足 / 2 容器坏 / 3 无音频轨 / 4 解码器打不开 / 5 采样格式不支持 /
6 没解出数据 / 7 状态错误 / 8 定位失败。

支持的采样格式：`FLTP / S16P / FLT / S16 / S32P / S32`（24-bit FLAC/WAV 走 S32）。

## 验证

```bash
# Node 直接加载 wasm，测 open/pull/seek/tell 与多格式
node tools/autotest/test-worker-stream.js
node tools/autotest/test-worker-formats.js

# 流式 DSP 等价性（不依赖 wasm）
node tools/autotest/unit-pitch-dsp.js
```

真机/模拟器还需回归：mp3 / m4a / wma / flac(16/24-bit) / wav(16/24-bit)、
试听拖动到任意位置、全曲处理。

## 注意

- 必须 `--arch=wasm --target-os=none`，否则 FFmpeg 会按原生平台配置。
- STANDALONE_WASM 下导出名不带前导下划线；Worker 里用 `F(n)=exports[n]||exports['_'+n]`。
- WASI 导入必须在 Worker 里全部桩化，且 `fd_write` 要写回 `nwritten`，否则
  musl `fprintf` 会无限重试（真机级坑，已踩过）。
- Homebrew emscripten 7.0.0 + FFmpeg 7.1.1 已验证可编译；若升级 FFmpeg 大版本，
  先重跑全格式回归。
