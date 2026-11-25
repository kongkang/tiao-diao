// 云端切片的 IO 编排:扫文件头 → 决定怎么取 → 按计划分批产出
//
// 本模块不碰网络:fetchMedia 注入两个读函数
//   read(start, end)          精确读 [start, end)(小范围:文件头、找边界用的窗口),失败抛错
//   readSpan(start, end)      读一大段连续字节,返回 {buf, complete}(预算用完时 buf 可能只是前缀)
//
// 取法三种:
//   渐进式 mp4(抖音/视频号)  → 只取音轨,必要时按时间切片(mp4slice.js)
//   分片式 fMP4(B站音频流)   → 整段放得下就直传;放不下按分片边界截一段(fmp4slice.js)
//   其他(mp3 / 不需要切的)   → 整文件直传(调用方用 plainPlan 兜底)

'use strict'

const { PlanError, boxHeader, PRINTABLE, analyzeMoov, pickAudio, audioEntryInfo } = require('./mp4box.js')
const { planAudioSlice, prefixSums } = require('./mp4slice.js')
const fmp4 = require('./fmp4slice.js')

const HEAD_BYTES = 256 * 1024
const MAX_MOOV_BYTES = 16 * 1024 * 1024
const WIN_BEFORE = 768 * 1024   // 找分片边界:估算位置之前读这么多
const WIN_AFTER = 384 * 1024    // 之后读这么多
const SPAN_BYTES = 16 * 1024 * 1024       // 一批最多顺序读多少源文件(音频占比约 10% → 出 1.5MB 成品)
const MIN_SPAN_BYTES = 256 * 1024          // 源很慢时一批最小读多少(再小就没法保证有进展了)

/** 整文件直传的计划:没有文件头,整个文件就是一段 */
function plainPlan(fileSize, meta) {
  return {
    kind: 'bytes',
    mode: 'full',
    header: Buffer.alloc(0),
    pieces: [{ src: 0, len: fileSize }],
    pieceCum: [0, fileSize],
    sampleBytes: fileSize,
    totalBytes: fileSize,
    durationSec: (meta && meta.durationSec) || 0,
    startSec: 0,
    mediaDurationSec: (meta && meta.durationSec) || 0,
  }
}

/**
 * 扫文件开头:找 moov(不够就往后补读),顺带记下它后面是不是分片式结构。
 * 返回 {kind:'none'} 或 {kind:'mp4', moov(载荷), ftyp, init, fragStart, sidxRange}
 */
async function scanFileHead(read, fileSize) {
  const none = { kind: 'none' }
  let head = await read(0, Math.min(HEAD_BYTES, fileSize))
  // 头不够时每次往后补 64KB
  const more = async () => {
    if (head.length >= fileSize) return false
    const tail = await read(head.length, Math.min(head.length + 65536, fileSize))
    if (!tail.length) return false
    head = Buffer.concat([head, tail])
    return true
  }
  let pos = 0
  let ftyp = null
  for (let guard = 0; guard < 64; guard++) {
    while (pos + 16 > head.length && (await more())) { /* 头不够,往后补 */ }
    const h = boxHeader(head, pos)
    if (!h || !PRINTABLE.test(h.type)) return none
    const size = h.size === 0 ? fileSize - pos : h.size
    if (pos === 0 && h.type === 'ftyp' && size >= 8 && size <= head.length) ftyp = Buffer.from(head.subarray(0, size))
    if (h.type === 'moof') return none          // 没见到 moov 就到分片了:不处理
    if (h.type === 'moov') {
      const end = pos + size
      if (end > fileSize || size > MAX_MOOV_BYTES || h.hdr >= size) return none
      while (head.length < end) {
        if (!(await more())) return none        // moov 读不全
      }
      const out = { kind: 'mp4', moov: Buffer.from(head.subarray(pos + h.hdr, end)), ftyp }
      // moov 之后:跳过 sidx,看是不是紧跟分片(moof)
      let q = end
      while (q + 16 > head.length && (await more())) { /* */ }
      const b = boxHeader(head, q)
      if (b && b.type === 'sidx') {
        out.sidxRange = [q, q + b.size]
        q += b.size
      }
      const f = boxHeader(head, q)
      if (f && f.type === 'moof') {
        out.fragStart = q
        out.init = Buffer.from(head.subarray(0, q))
      }
      return out
    }
    pos += size
  }
  return none
}

/**
 * 决定这个媒体怎么取。
 * @returns {object|null} 计划;null = 不用切,整文件直传
 * @throws PlanError  NO_AUDIO / DRM / EMPTY 是明确的「取不了」,其余结构问题由调用方按 null 处理
 */
async function buildSource(ctx) {
  const { read, fileSize, slice, durationSec } = ctx
  const scan = await scanFileHead(read, fileSize)
  if (scan.kind !== 'mp4') return null
  const info = analyzeMoov(scan.moov)
  if (!info.fragmented) {
    // 渐进式:一律只取音轨(画面占九成字节);给了时长上限就按时间切片
    const endSec = slice.maxSec > 0 ? slice.startSec + slice.maxSec : undefined
    return planAudioSlice(scan.moov, scan.ftyp, fileSize, { startSec: slice.startSec, endSec })
  }
  // 分片式(本身已是纯音频):整段放得下就直传,放不下才按分片边界截
  const needCut = slice.startSec > 0 || (slice.maxSec > 0 && durationSec > slice.maxSec + 1)
  if (!needCut || !(durationSec > 0) || !(scan.fragStart >= 0)) return null
  return buildFmp4Plan(ctx, scan, info)
}

async function buildFmp4Plan(ctx, scan, info) {
  const { read, fileSize, slice, durationSec } = ctx
  const trak = pickAudio(info.traks)
  const entry = trak ? audioEntryInfo(scan.moov, trak) : { sampleRate: 0, channels: 0 }
  const search = {
    read,
    fileSize,
    fragStart: scan.fragStart,
    bytesPerSec: (fileSize - scan.fragStart) / durationSec,
    trackTs: trak ? trak.timescale : 0,
    movieTs: info.movieTimescale,
  }
  const wantEnd = slice.maxSec > 0 && slice.startSec + slice.maxSec < durationSec - 1
  const end = wantEnd ? await findBoundary(search, slice.startSec + slice.maxSec, true) : null
  const start = slice.startSec > 0 ? await findBoundary(search, slice.startSec, false) : null
  if (wantEnd && !end) throw new PlanError('NO_BOUNDARY', '没找到截取位置')
  if (slice.startSec > 0 && !start) throw new PlanError('NO_BOUNDARY', '没找到截取位置')
  return fmp4.planFragmented({
    init: scan.init,
    sidxRange: scan.sidxRange || null,
    movieTimescale: info.movieTimescale,
    fragStart: scan.fragStart,
    fileSize,
    start,
    end,
    unitSec: (start || end).unitSec,
    mediaDurationSec: durationSec,
    codec: trak ? trak.format : '',
    sampleRate: entry.sampleRate,
    channels: entry.channels,
  })
}

/**
 * 找分片边界:targetSec 附近、时间 ≥ targetSec 的第一片(after=true)
 * 或时间 ≤ targetSec 的最后一片(after=false)。
 * 先按整体码率估位置,读一个窗口用真实 tfdt 挑;估偏了就按窗口里实测的斜率修正再找(最多 4 次)。
 * @returns {{pos, time, unitSec}|null}
 */
async function findBoundary(s, targetSec, after) {
  let guess = s.fragStart + targetSec * s.bytesPerSec
  for (let attempt = 0; attempt < 4; attempt++) {
    const from = Math.max(s.fragStart, Math.floor(guess - WIN_BEFORE))
    const to = Math.min(s.fileSize, Math.ceil(guess + WIN_AFTER))
    if (to - from < 24) return null
    const win = await s.read(from, to)
    const frags = fmp4.walkFragments(win, from)
    if (frags.length) {
      const unitSec = fmp4.unitSeconds(frags, s.bytesPerSec, s.trackTs, s.movieTs)
      if (unitSec) {
        const hit = fmp4.pickBoundary(frags, targetSec / unitSec, after)
        if (hit) return { pos: hit.pos, time: hit.time, unitSec }
        // 窗口里没有要的边界:按首尾两片的实测「字节/秒」重新估
        const a = frags[0]
        const b = frags[frags.length - 1]
        if (b.time > a.time && b.pos > a.pos) {
          const slope = (b.pos - a.pos) / ((b.time - a.time) * unitSec)
          const ref = after ? b : a
          guess = ref.pos + (targetSec - ref.time * unitSec) * slope
          continue
        }
      }
    }
    return null
  }
  return null
}

/** 从输出位置 pos 起,凑 want 字节成品(或读满 spanBytes 源文件)所需的字节段 */
function takeBatch(plan, pos, want, spanBytes) {
  const cum = plan.pieceCum
  let lo = 0
  let hi = cum.length - 2
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (cum[mid] <= pos) lo = mid
    else hi = mid - 1
  }
  const items = []
  const src = plan.pieces[lo].src + (pos - cum[lo])
  let srcEnd = src
  let out = 0
  for (let i = lo; i < plan.pieces.length && out < want; i++) {
    const p = plan.pieces[i]
    const from = i === lo ? pos - cum[i] : 0
    // 单段也不能超过本批的源文件跨度(连续数据要靠这里截断,慢速源才能越读越小)
    const len = Math.max(1, Math.min(p.len - from, want - out, spanBytes - (srcEnd - src)))
    items.push({ src: p.src + from, len })
    out += len
    srcEnd = p.src + from + len
    if (srcEnd - src >= spanBytes) break
  }
  return items.length ? { src, srcEnd, items, out } : null
}

/**
 * 产出成品 [offset, min(offset + maxBytes, total)) 这一段。
 * 源文件按「批」顺序读,每批只留落在计划字节段里的字节。
 * 预算用完就返回已经拿到的 —— 一定是成品的前缀,客户端从 nextOffset 续传。
 * @returns {{buf, nextOffset, done, produced}}
 */
async function readPlanChunk(plan, io, offset, maxBytes, deadline) {
  const end = Math.min(plan.totalBytes, offset + maxBytes)
  const parts = []
  let have = 0
  if (offset < plan.header.length) {
    const to = Math.min(plan.header.length, end)
    parts.push(plan.header.subarray(offset, to))
    have = to - offset
  }
  const base = plan.header.length
  while (offset + have < end && Date.now() < deadline - 30) {
    const span = plan.spanBytes || SPAN_BYTES
    const batch = takeBatch(plan, offset + have - base, end - offset - have, span)
    if (!batch) break
    const got = await io.readSpan(batch.src, batch.srcEnd)
    let produced = 0
    for (const it of batch.items) {
      if (it.src + it.len > batch.src + got.buf.length) break   // 这一段没读全
      parts.push(got.buf.subarray(it.src - batch.src, it.src - batch.src + it.len))
      produced += it.len
    }
    have += produced
    if (produced < batch.out) {
      // 没凑齐:预算用完或网络慢。下一批读小一点,保证每次都有进展
      if (!got.complete) plan.spanBytes = Math.max(MIN_SPAN_BYTES, Math.floor(span / 2))
      break
    }
    if (span < SPAN_BYTES) plan.spanBytes = Math.min(SPAN_BYTES, span * 2)   // 读顺了就放大回去
  }
  return { buf: Buffer.concat(parts), nextOffset: offset + have, done: offset + have >= plan.totalBytes, produced: have }
}

module.exports = {
  PlanError, plainPlan, prefixSums, buildSource, readPlanChunk,
  _internals: { scanFileHead, findBoundary, takeBatch },
}
