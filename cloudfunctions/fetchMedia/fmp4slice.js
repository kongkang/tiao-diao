// 分片式 MP4(fMP4/moof-mdat)按分片边界截取 —— 纯字节计算,不做 IO
//
// B站 DASH 音频流是这种形态:[ftyp][moov][sidx][moof mdat][moof mdat]…
// 它本身就是纯音频,不需要「只取音轨」;但视频太长时要按时间截一段。
//
// 实测(自带解码器,见 tools/autotest/test-mp4slice.js 的说明与交接文档):
//   - B站流里的 sidx 索引和实际分片对不上,留着会让时长/定位出错 → 截取时去掉
//   - 时长写在 mvhd 和 mvex/mehd 里,要一起改成截取后的长度
//   - 截取点必须是某个 moof 的开头:按「字节/时间」估算位置,再读一个窗口,
//     用分片头 tfdt(首帧解码时间)的真实时间挑出边界;估偏了就按实测斜率修正重找
//   - 从中段开始截时,首片的 tfdt 不是 0,容器报告的时长会多算这段偏移
//     → 由小程序端解码自检实测修正(那里的探针本来就要确认结尾解得出来)

'use strict'

const {
  PlanError, u32, u64, children, boxHeader, patchDuration,
  findChild, analyzeMoov, pickAudio, audioEntryInfo,
} = require('./mp4box.js')

const MAX_MOOF_BYTES = 256 * 1024
const MAX_MDAT_BYTES = 64 * 1024 * 1024

/** moof 里的 tfdt(首帧解码时间,单位 = 该轨时基) */
function moofTfdt(buf, start, end) {
  const kids = children(buf, start, Math.min(end, buf.length))
  if (!kids) return null
  for (const traf of kids) {
    if (traf.type !== 'traf') continue
    const tk = children(buf, traf.start + traf.hdr, traf.end)
    if (!tk) continue
    const tfdt = tk.find(b => b.type === 'tfdt')
    if (!tfdt) continue
    const p = tfdt.start + tfdt.hdr
    return buf[p] === 1 ? u64(buf, p + 4) : u32(buf, p + 4)
  }
  return null
}

/** buf 的 pos 处若是一个完整分片的开头(moof + mdat 头都在缓冲里),返回分片信息 */
function parseFragmentAt(buf, pos, fileStart) {
  const h = boxHeader(buf, pos)
  if (!h || h.type !== 'moof' || h.size < 16 || h.size > MAX_MOOF_BYTES) return null
  const moofEnd = pos + h.size
  if (moofEnd + 8 > buf.length) return null
  const m = boxHeader(buf, moofEnd)
  if (!m || m.type !== 'mdat' || m.size <= m.hdr || m.size > MAX_MDAT_BYTES) return null
  const time = moofTfdt(buf, pos + h.hdr, moofEnd)
  if (time === null) return null
  return { pos: fileStart + pos, end: fileStart + moofEnd + m.size, time, next: moofEnd + m.size }
}

/**
 * 列出缓冲区里的分片:先找第一个结构完整的 moof(窗口起点落在分片中间也能接上),
 * 之后按 box 大小顺序走。每个候选都要通过完整校验(moof 可解析、tfdt 存在、紧跟合法 mdat),
 * 所以数据里碰巧出现的 "moof" 字样不会被误认。
 * 返回 [{pos, end, time}](pos/end 是文件绝对偏移)
 */
function walkFragments(buf, fileStart) {
  const out = []
  let from = 0
  while (from + 24 <= buf.length) {
    const q = buf.indexOf('moof', from, 'latin1')
    if (q < 4) break
    const f = parseFragmentAt(buf, q - 4, fileStart)
    if (f) {
      out.push(f)
      from = f.next
    } else {
      from = q + 4
    }
  }
  return out
}

/** 挑边界:after=true 取第一个 time ≥ t 的分片;否则取最后一个 time ≤ t 的 */
function pickBoundary(frags, t, after) {
  let hit = null
  for (const f of frags) {
    if (after) { if (f.time >= t) return f } else if (f.time <= t) hit = f
  }
  return after ? null : hit
}

/**
 * tfdt 的一个单位等于多少秒:可能是轨时基,也可能是影片时基。
 * 用窗口里首尾两个分片的「字节 / 时间差」去比整体码率,哪个量级对得上就是哪个。
 */
function unitSeconds(frags, bytesPerSec, trackTimescale, movieTimescale) {
  const cands = [trackTimescale, movieTimescale].filter(x => x > 0).map(x => 1 / x)
  if (!cands.length) return null
  if (frags.length < 2 || !(bytesPerSec > 0)) return cands[0]
  const a = frags[0]
  const b = frags[frags.length - 1]
  const dt = b.time - a.time
  const dp = b.pos - a.pos
  if (!(dt > 0 && dp > 0)) return cands[0]
  let best = null
  for (const c of cands) {
    const err = Math.abs(Math.log((dp / (dt * c)) / bytesPerSec))
    if (!best || err < best.err) best = { c, err }
  }
  return best.c
}

/**
 * 成品文件头:init 段(ftyp…moov)去掉 sidx,时长改写成截取后的长度。
 * @param {Buffer} init       文件开头到第一个分片之前的全部字节
 * @param {[number,number]|null} sidxRange sidx 的 [起,止)
 * @param {number} movieUnits  截取时长(影片时基)
 */
function fmp4Header(init, sidxRange, movieUnits) {
  const head = sidxRange
    ? Buffer.concat([init.subarray(0, sidxRange[0]), init.subarray(sidxRange[1])])
    : Buffer.from(init)
  let p = 0
  while (p + 8 <= head.length) {
    const h = boxHeader(head, p)
    if (!h) break
    if (h.type === 'moov') {
      const moov = { start: p, end: p + h.size, hdr: h.hdr }
      const kids = children(head, p + h.hdr, moov.end) || []
      for (const k of kids) {
        if (k.type === 'mvhd') {
          const out = patchDuration(head, k, 'mvhd', movieUnits)   // 长度不变,直接写回
          out.copy(head, k.start)
        } else if (k.type === 'mvex') {
          const mehd = findChild(head, k, 'mehd')
          if (mehd) {
            const q = mehd.start + mehd.hdr
            const v1 = head[q] === 1
            if (v1) head.writeBigUInt64BE(BigInt(Math.max(0, Math.round(movieUnits))), q + 4)
            else head.writeUInt32BE(Math.min(0xffffffff, Math.max(0, Math.round(movieUnits))), q + 4)
          }
        }
      }
      break
    }
    p += h.size
  }
  return head
}

/**
 * 组装分片式截取计划。
 * @param {object} o
 *   init / sidxRange / movieTimescale:见 fmp4Header
 *   fragStart   第一个分片在源文件里的偏移
 *   start       {pos, time} 截取起点所在的分片(或 null = 从头)
 *   end         {pos, time} 截取终点之后的第一片(或 null = 到文件尾)
 *   unitSec     tfdt 一单位是多少秒
 *   mediaDurationSec / codec / sampleRate / channels  展示用
 */
function planFragmented(o) {
  const srcStart = o.start ? o.start.pos : o.fragStart
  const srcEnd = o.end ? o.end.pos : o.fileSize
  if (!(srcEnd > srcStart)) throw new PlanError('EMPTY', '这一段里没有声音')
  const startSec = o.start ? o.start.time * o.unitSec : 0
  const endSec = o.end ? o.end.time * o.unitSec : o.mediaDurationSec
  const header = fmp4Header(o.init, o.sidxRange, Math.max(0, Math.round((endSec - startSec) * o.movieTimescale)))
  const len = srcEnd - srcStart
  return {
    kind: 'fmp4',
    mode: 'slice',
    codec: o.codec,
    sampleRate: o.sampleRate,
    channels: o.channels,
    mediaDurationSec: o.mediaDurationSec,
    startSec,
    durationSec: endSec - startSec,
    header,
    pieces: [{ src: srcStart, len }],
    pieceCum: [0, len],
    sampleBytes: len,
    totalBytes: header.length + len,
  }
}

module.exports = {
  moofTfdt, parseFragmentAt, walkFragments, pickBoundary, unitSeconds, fmp4Header, planFragmented,
}
