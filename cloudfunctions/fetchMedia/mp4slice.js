// 渐进式 MP4:只保留音轨 + 按时间切片 —— 纯字节计算,不做 IO
//
// 抖音/视频号的 mp4 画面和声音交织存放(每个音频包单独成块,夹在视频包之间)。
// planAudioSlice() 按 moov 里的样本表算出每个音频块的字节区间,输出:
//   header  新文件头 = ftyp + 只有音轨的 moov + mdat 头
//   pieces  源文件里要搬过来的字节段(顺序拼在 header 之后就是成品 m4a)
// 云端顺序读源文件、只留这些段;手机拿到的是普通大小的音频文件。
//
// 两种模式:
//   full  整段保留(视频不超长):moov 原样,去掉其他轨,音轨块偏移回填
//   slice 时间切片(视频太长,只取一段):音轨样本表按保留区间重建,时间轴从首帧起算

'use strict'

const {
  PlanError, children, boxHeader, makeBox, fullBox, u32buf, countAnd, patchDuration,
  analyzeMoov, audioEntryInfo, findChild, pickAudio,
} = require('./mp4box.js')

// ---------- 样本表展开 ----------

/** 把 stsc/stco/stsz 展开成每个块:{first 起始样本, count 帧数, offset 源偏移, size 字节数} */
function buildChunks(trak) {
  const { stsc, offsets, sizes } = trak.stbl
  const total = sizes.length
  if (!total || !offsets.length) throw new PlanError('BAD_TABLES', '音轨样本表是空的')
  const cum = new Float64Array(total + 1)
  for (let i = 0; i < total; i++) cum[i + 1] = cum[i] + sizes[i]

  const chunks = []
  let sample = 0
  for (let r = 0; r < stsc.length && sample < total; r++) {
    const first = stsc[r].first
    const last = r + 1 < stsc.length ? stsc[r + 1].first - 1 : offsets.length
    const perChunk = stsc[r].count
    if (first < 1 || last < first || perChunk < 1) throw new PlanError('BAD_TABLES', '音轨样本表对不上')
    for (let c = first; c <= last && sample < total; c++) {
      if (c > offsets.length) throw new PlanError('BAD_TABLES', '音轨样本表对不上')
      const n = Math.min(perChunk, total - sample)
      chunks.push({ first: sample, count: n, desc: stsc[r].desc || 1, offset: offsets[c - 1], size: cum[sample + n] - cum[sample] })
      sample += n
    }
  }
  if (sample !== total || !chunks.length) throw new PlanError('BAD_TABLES', '音轨样本表对不上')
  return chunks
}

/** 媒体总时长(轨时基) */
function totalUnits(stts) {
  let t = 0
  for (const r of stts) t += r.count * r.delta
  return t
}

/** 第一个 dts ≥ t 的样本序号;超出则返回样本总数 */
function timeToSample(stts, t) {
  let s = 0
  let d = 0
  for (const r of stts) {
    const end = d + r.count * r.delta
    if (t < end) return s + (r.delta ? Math.floor((t - d) / r.delta) : 0)
    s += r.count
    d = end
  }
  return s
}

/** 样本序号所在的块 */
function chunkOfSample(chunks, s) {
  let lo = 0
  let hi = chunks.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (chunks[mid].first <= s) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** 把按样本分段的 runs(stts 的 delta / ctts 的 offset)裁到 [s0,s1),相邻同值合并 */
function clipRuns(runs, s0, s1, key) {
  const out = []
  let s = 0
  for (const r of runs) {
    const end = s + r.count
    if (end <= s0) { s = end; continue }
    if (s >= s1) break
    const a = Math.max(s, s0)
    const b = Math.min(end, s1)
    const last = out[out.length - 1]
    if (last && last.value === r[key]) last.count += b - a
    else out.push({ count: b - a, value: r[key] })
    s = end
  }
  return out
}

/** 样本 [s0,s1) 的媒体时长(轨时基) */
function keptUnits(stts, s0, s1) {
  let units = 0
  for (const r of clipRuns(stts, s0, s1, 'delta')) units += r.count * r.value
  return units
}

function dtsOfSample(stts, index) {
  let s = 0
  let d = 0
  for (const r of stts) {
    if (index < s + r.count) return d + (index - s) * r.delta
    s += r.count
    d += r.count * r.delta
  }
  return d
}

// ---------- box 重组 ----------

/** 按 childFn 重组 box 的子 box:undefined=原样,null=丢弃,Buffer=替换 */
function rebuild(buf, box, fn) {
  const kids = children(buf, box.start + box.hdr, box.end)
  if (!kids) throw new PlanError('BAD_MOOV', '视频结构认不出来')
  const parts = []
  for (const k of kids) {
    const r = fn(k)
    if (r === null) continue
    parts.push(r === undefined ? buf.subarray(k.start, k.end) : r)
  }
  return makeBox(box.type, Buffer.concat(parts))
}

function runsBox(runs, key) {
  const b = Buffer.alloc(runs.length * 8)
  for (let i = 0; i < runs.length; i++) {
    b.writeUInt32BE(runs[i].count, i * 8)
    if (key === 'offset' && runs[i].value < 0) b.writeInt32BE(runs[i].value, i * 8 + 4)
    else b.writeUInt32BE(runs[i].value, i * 8 + 4)
  }
  return b
}

function u32Range(arr, from, to) {
  const out = Buffer.alloc((to - from) * 4)
  for (let i = from; i < to; i++) out.writeUInt32BE(arr[i], (i - from) * 4)
  return out
}

function ftypBox(ftyp) {
  if (ftyp && ftyp.length >= 8 && ftyp.toString('latin1', 4, 8) === 'ftyp') return ftyp
  return Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex')   // 兜底:isom
}

/** mdat box 头(8 字节),大小 = 头 + 全部音频块;块本身紧接在头后面 */
function mdatHeader(dataBytes) {
  const b = Buffer.alloc(8)
  b.writeUInt32BE(8 + dataBytes, 0)
  b.write('mdat', 4, 'latin1')
  return b
}

// ---------- 入口 ----------

/**
 * @param {Buffer} moov        moov 载荷(不含 box 头)
 * @param {Buffer|null} ftyp   原 ftyp box(整 box),没有就自动补一个
 * @param {number} fileSize    源文件字节数(未知传 0,跳过越界检查)
 * @param {{startSec?:number, endSec?:number}} opts 目标时间范围(秒,左闭右开)
 * @returns {{kind:'mp4', mode, header, pieces, totalBytes, durationSec, startSec, mediaDurationSec, codec, sampleRate, channels}}
 */
function planAudioSlice(moov, ftyp, fileSize, opts) {
  const info = analyzeMoov(moov)
  if (info.fragmented) throw new PlanError('FRAGMENTED', '分片式视频不走这条路')
  const trak = pickAudio(info.traks)
  if (!trak) throw new PlanError('NO_AUDIO', '这个视频里没有声音')
  if (trak.format === 'enca') throw new PlanError('DRM', '声音有加密保护')
  const chunks = buildChunks(trak)
  const ts = trak.timescale
  const total = trak.stbl.sizes.length
  const mediaUnits = totalUnits(trak.stbl.stts)
  if (fileSize > 0) {
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i]
      if (!(c.offset >= 0 && c.size > 0 && c.offset + c.size <= fileSize)) {
        throw new PlanError('BAD_TABLES', '音轨位置超出文件范围')
      }
    }
  }

  const startSec = Math.max(0, opts.startSec || 0)
  const endSec = opts.endSec == null ? Infinity : Math.max(0, opts.endSec)
  const s1 = endSec * ts >= mediaUnits ? total : timeToSample(trak.stbl.stts, Math.round(endSec * ts))
  // 起点对齐到所在块的第一帧(块内样本必须从块头连续),最多提前一个音频块
  const c0 = startSec > 0 ? chunkOfSample(chunks, timeToSample(trak.stbl.stts, Math.round(startSec * ts))) : 0
  const s0 = chunks[c0].first
  if (s1 <= s0) throw new PlanError('EMPTY', '这一段里没有声音')
  const c1 = chunkOfSample(chunks, Math.max(s0, s1 - 1))
  const kept = chunks.slice(c0, c1 + 1)
  const full = c0 === 0 && s1 >= total
  const entry = audioEntryInfo(moov, trak)

  const dataBytes = kept.reduce((a, c) => a + c.size, 0)
  const header = full
    ? fullHeader(moov, info, ftyp, trak, dataBytes)
    : Buffer.concat([ftypBox(ftyp), slicedMoov(moov, info, trak, { s0, s1, kept }), mdatHeader(dataBytes)])
  return finishPlan({
    kind: 'mp4',
    mode: full ? 'full' : 'slice',
    codec: trak.format,
    sampleRate: entry.sampleRate,
    channels: entry.channels,
    mediaDurationSec: mediaUnits / ts,
    startSec: s0 === 0 ? 0 : dtsOfSample(trak.stbl.stts, s0) / ts,
    sampleStart: s0,
    // 整段保留时编辑列表原样留着,呈现时长以它为准(首尾的编码余量会被它裁掉)
    durationSec: full
      ? (trak.editDurationUnits != null ? trak.editDurationUnits / info.movieTimescale : mediaUnits / ts)
      : keptUnits(trak.stbl.stts, s0, s1) / ts,
  }, header, kept, s1, trak.stbl.sizes)
}

/** 整段保留:moov 原样,只去掉其他轨(画面/封面/字幕);音轨块偏移由 finishPlan 回填 */
function fullHeader(moov, info, ftyp, trak, dataBytes) {
  const parts = []
  for (const k of info.boxes) {
    if (k.type === 'trak') {
      if (k === trak.box) parts.push(Buffer.from(moov.subarray(k.start, k.end)))
      continue
    }
    if (k.type === 'iods') continue   // 引用了被丢弃的轨,一并去掉
    parts.push(moov.subarray(k.start, k.end))
  }
  return Buffer.concat([ftypBox(ftyp), makeBox('moov', Buffer.concat(parts)), mdatHeader(dataBytes)])
}

/** 切片:音轨样本表按保留区间重建,时间轴从保留的第一帧起算 */
function slicedMoov(moov, info, trak, ctx) {
  const { s0, s1, kept } = ctx
  const stbl = trak.stbl
  const units = keptUnits(stbl.stts, s0, s1)
  const movieUnits = Math.round(units * info.movieTimescale / trak.timescale)

  // stsc:相邻「每块帧数相同」的块合并成一条(最后一块可能被截短)
  const stscRuns = []
  for (let i = 0; i < kept.length; i++) {
    const n = Math.min(kept[i].count, s1 - kept[i].first)
    const prev = stscRuns[stscRuns.length - 1]
    if (!prev || prev.count !== n || prev.desc !== kept[i].desc) stscRuns.push({ first: i + 1, count: n, desc: kept[i].desc })
  }
  const stscBody = Buffer.alloc(stscRuns.length * 12)
  stscRuns.forEach((r, i) => {
    stscBody.writeUInt32BE(r.first, i * 12)
    stscBody.writeUInt32BE(r.count, i * 12 + 4)
    stscBody.writeUInt32BE(r.desc, i * 12 + 8)
  })
  const stsc = fullBox('stsc', 0, 0, countAnd(stscRuns.length, stscBody))

  // stsz:保留区间内等长就写统一长度
  const sizes = stbl.sizes
  let uniform = true
  for (let i = s0 + 1; i < s1; i++) {
    if (sizes[i] !== sizes[s0]) { uniform = false; break }
  }
  const stsz = fullBox('stsz', 0, 0, uniform
    ? u32buf([sizes[s0], s1 - s0])
    : Buffer.concat([u32buf([0, s1 - s0]), u32Range(sizes, s0, s1)]))

  let ctts = null
  if (stbl.ctts) {
    const runs = clipRuns(stbl.ctts.runs, s0, s1, 'offset')
    if (runs.some(r => r.offset !== 0)) {
      ctts = fullBox('ctts', moov[stbl.ctts.box.start + stbl.ctts.box.hdr], 0, countAnd(runs.length, runsBox(runs, 'offset')))
    }
  }
  let stss = null
  if (stbl.stss && stbl.stss.length) {
    const keep = []
    for (let i = 0; i < stbl.stss.length; i++) {
      const n = stbl.stss[i] - 1
      if (n >= s0 && n < s1) keep.push(n - s0 + 1)
    }
    // 全是关键帧或一个不剩,这张表就没必要留
    if (keep.length && keep.length !== s1 - s0) stss = fullBox('stss', 0, 0, countAnd(keep.length, u32buf(keep)))
  }
  const sttsRuns = clipRuns(stbl.stts, s0, s1, 'delta')
  const stts = fullBox('stts', 0, 0, countAnd(sttsRuns.length, runsBox(sttsRuns, 'delta')))
  const stco = fullBox('stco', 0, 0, countAnd(kept.length, Buffer.alloc(kept.length * 4)))   // 条目先留 0,拼完头再回填

  const newTrak = rebuild(moov, trak.box, k => {
    if (k.type === 'tkhd') return patchDuration(moov, k, 'tkhd', movieUnits)
    if (k.type === 'edts') return null   // 切片从保留的首帧起播,原编辑表不再适用
    if (k.type !== 'mdia') return undefined
    return rebuild(moov, k, m => {
      if (m.type === 'mdhd') return patchDuration(moov, m, 'mdhd', units)
      if (m.type !== 'minf') return undefined
      return rebuild(moov, m, f => {
        if (f.type !== 'stbl') return undefined
        return rebuild(moov, f, t => {
          switch (t.type) {
            case 'stsd': return undefined
            case 'stts': return stts
            case 'stsc': return stsc
            case 'stsz': case 'stz2': return stsz
            case 'stco': case 'co64': return stco
            case 'ctts': return ctts
            case 'stss': return stss
            default: return null   // 逐帧辅助表(sdtp 等)已不适用
          }
        })
      })
    })
  })

  const parts = []
  for (const k of info.boxes) {
    if (k.type === 'trak') {
      if (k === trak.box) parts.push(newTrak)
      continue
    }
    if (k.type === 'iods') continue
    if (k.type === 'mvhd') {
      parts.push(patchDuration(moov, k, 'mvhd', movieUnits))
      continue
    }
    parts.push(moov.subarray(k.start, k.end))
  }
  return makeBox('moov', Buffer.concat(parts))
}

/** 回填音轨块在输出文件里的偏移,再做一遍自检。sizes 是原文件的样本长度表 */
function finishPlan(plan, header, kept, s1, sizes) {
  const loc = locateStco(header)
  if (!loc) throw new PlanError('BAD_MOOV', '音轨索引没找到')
  let off = header.length
  const pos = new Array(kept.length)
  for (let i = 0; i < kept.length; i++) {
    pos[i] = off
    off += kept[i].size
  }
  for (let i = 0; i < kept.length; i++) {
    if (loc.wide) header.writeBigUInt64BE(BigInt(pos[i]), loc.entryOff + i * 8)
    else header.writeUInt32BE(pos[i], loc.entryOff + i * 4)
  }
  plan.header = header
  plan.totalBytes = off

  // 自检:按成品文件头重新展开,必须和计划逐块一致
  const layout = headerLayout(header)
  if (!layout || layout.mdat.size !== 8 + (off - header.length) || layout.mdatStart + 8 !== header.length) {
    throw new PlanError('BAD_MOOV', '切片自检没过')
  }
  const again = analyzeMoov(header.subarray(layout.moovStart, layout.moovEnd))
  const trak = pickAudio(again.traks)
  if (again.fragmented || again.traks.length !== 1 || !trak) throw new PlanError('BAD_MOOV', '切片自检没过')
  const chunks = buildChunks(trak)
  if (chunks.length !== kept.length) throw new PlanError('BAD_MOOV', '切片自检没过')
  let sample = 0
  for (let i = 0; i < chunks.length; i++) {
    // 最后一块可能只引用前半截(切片终点落在块中间):字节数按被引用的样本算
    const frames = Math.min(kept[i].count, s1 - kept[i].first)
    let refBytes = 0
    for (let n = kept[i].first; n < kept[i].first + frames; n++) refBytes += sizes[n]
    if (chunks[i].offset !== pos[i] || chunks[i].first !== sample ||
        chunks[i].count !== frames || chunks[i].size !== refBytes) {
      throw new PlanError('BAD_MOOV', '切片自检没过')
    }
    sample += frames
  }
  plan.sampleCount = sample
  plan.pieces = mergePieces(kept.map(c => ({ src: c.offset, len: c.size })))
  plan.sampleBytes = off - header.length
  plan.pieceCum = prefixSums(plan.pieces)
  return plan
}

/** 相邻的源字节段合并,少发请求 */
function mergePieces(list) {
  const out = []
  for (const p of list) {
    const last = out[out.length - 1]
    if (last && last.src + last.len === p.src) last.len += p.len
    else out.push({ src: p.src, len: p.len })
  }
  return out
}

function prefixSums(pieces) {
  const cum = new Float64Array(pieces.length + 1)
  for (let i = 0; i < pieces.length; i++) cum[i + 1] = cum[i] + pieces[i].len
  return cum
}

/**
 * 成品文件头的布局:[ftyp][moov][mdat 头]。
 * 不能用 children() 遍历:这里的 mdat 只有 8 字节头(数据在头后面),通用遍历会判它越界。
 */
function headerLayout(header) {
  const ftyp = boxHeader(header, 0)
  if (!ftyp || ftyp.type !== 'ftyp') return null
  const moov = boxHeader(header, ftyp.size)
  if (!moov || moov.type !== 'moov') return null
  const mdatStart = ftyp.size + moov.size
  const mdat = boxHeader(header, mdatStart)
  if (!mdat || mdat.type !== 'mdat') return null
  return { moovStart: mdatStart - moov.size + moov.hdr, moovEnd: mdatStart, mdatStart, mdat }
}

/** 在成品文件头里定位音轨的 stco/co64 条目区 */
function locateStco(header) {
  const layout = headerLayout(header)
  if (!layout) return null
  const payload = header.subarray(layout.moovStart, layout.moovEnd)
  const info = analyzeMoov(payload)
  const trak = pickAudio(info.traks)
  if (!trak) return null
  const stco = findChild(payload, trak.stblBox, 'stco') || findChild(payload, trak.stblBox, 'co64')
  if (!stco) return null
  // stco 载荷:version/flags(4) + 条数(4),条目从第 8 字节起
  return { entryOff: layout.moovStart + stco.start + stco.hdr + 8, wide: stco.type === 'co64' }
}

module.exports = {
  PlanError,
  buildChunks, totalUnits, timeToSample, chunkOfSample, clipRuns, keptUnits, dtsOfSample,
  mergePieces, prefixSums, headerLayout, locateStco,
  planAudioSlice,
}
