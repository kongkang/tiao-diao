// MP4(ISO BMFF)box 解析基础件 —— 纯字节计算,不做 IO,无依赖
//
// 给 mp4slice.js(渐进式:只取音轨)和 fmp4slice.js(分片式:按分片截取)共用。
// 结构不符合预期时返回 null 或抛 PlanError,由上层决定退回「整文件直传」。

'use strict'

class PlanError extends Error {
  constructor(code, message) {
    super(message || code)
    this.code = code
  }
}

const u32 = (b, o) => b.readUInt32BE(o)
const i32 = (b, o) => b.readInt32BE(o)
const u64 = (b, o) => Number(b.readBigUInt64BE(o))

/** 顺序遍历 [start,end) 里的子 box;结构不完整/越界返回 null */
function children(buf, start, end) {
  const out = []
  let p = start
  while (p + 8 <= end) {
    let size = u32(buf, p)
    let hdr = 8
    if (size === 1) {            // largesize:真实长度在后面 8 字节
      if (p + 16 > end) return null
      size = u64(buf, p + 8)
      hdr = 16
    } else if (size === 0) {     // 一直到结尾
      size = end - p
    }
    if (size < hdr || p + size > end) return null
    out.push({ type: buf.toString('latin1', p + 4, p + 8), start: p, end: p + size, hdr })
    p += size
  }
  return p === end ? out : null
}

/** 读 pos 处的 box 头(不够 16 字节时 largesize 读不了,返回 null) */
function boxHeader(buf, pos) {
  if (!Number.isInteger(pos) || pos < 0 || pos + 8 > buf.length) return null
  let size = u32(buf, pos)
  let hdr = 8
  const type = buf.toString('latin1', pos + 4, pos + 8)
  if (size === 1) {
    if (pos + 16 > buf.length) return null
    size = u64(buf, pos + 8)
    hdr = 16
  }
  if (size < hdr) return null
  return { type, size, hdr }
}

const PRINTABLE = /^[\x20-\x7e]{4}$/

function makeBox(type, payload) {
  const b = Buffer.alloc(8 + payload.length)
  b.writeUInt32BE(8 + payload.length, 0)
  b.write(type, 4, 'latin1')
  payload.copy(b, 8)
  return b
}

function u32buf(values) {
  const b = Buffer.alloc(values.length * 4)
  for (let i = 0; i < values.length; i++) b.writeUInt32BE(values[i], i * 4)
  return b
}

/** 「条数 + 条目」的 box 载荷 */
function countAnd(n, body) {
  return Buffer.concat([u32buf([n]), body])
}

/** FullBox:载荷开头是 4 字节 version/flags */
function fullBox(type, version, flags, body) {
  return makeBox(type, Buffer.concat([u32buf([(version & 0xff) * 0x1000000 + (flags & 0xffffff)]), body]))
}

/** 原 box 载荷开头的 version/flags 4 字节 */
function verFlags(buf, box) {
  return buf.subarray(box.start + box.hdr, box.start + box.hdr + 4)
}

/** mvhd/tkhd/mdhd 的时长字段位置(版本 0 是 4 字节,版本 1 是 8 字节) */
function durationField(buf, box, kind) {
  const p = box.start + box.hdr
  const v1 = buf[p] === 1
  if (kind === 'mvhd') return v1 ? { off: p + 24, size: 8, timescaleOff: p + 20 } : { off: p + 16, size: 4, timescaleOff: p + 12 }
  if (kind === 'mdhd') return v1 ? { off: p + 24, size: 8, timescaleOff: p + 20 } : { off: p + 16, size: 4, timescaleOff: p + 12 }
  return v1 ? { off: p + 28, size: 8 } : { off: p + 20, size: 4 }   // tkhd
}

/** 拷贝 box 并改写时长字段 */
function patchDuration(buf, box, kind, value) {
  const out = Buffer.from(buf.subarray(box.start, box.end))
  const f = durationField(out, { start: 0, hdr: box.hdr }, kind)
  const v = Math.max(0, Math.round(value))
  if (f.size === 8) out.writeBigUInt64BE(BigInt(v), f.off)
  else out.writeUInt32BE(Math.min(v, 0xffffffff), f.off)
  return out
}

function readU32Array(buf, off, cnt) {
  const out = new Uint32Array(cnt)
  for (let i = 0; i < cnt; i++) out[i] = u32(buf, off + i * 4)
  return out
}

/** 读 stbl 里的各张样本表;缺关键表或长度对不上返回 null */
function readStbl(buf, box) {
  const kids = children(buf, box.start + box.hdr, box.end)
  if (!kids) return null
  const s = { format: '', stts: null, ctts: null, stsc: null, sizes: null, offsets: null, stss: null, stsdEntry: 0 }
  for (const k of kids) {
    const p = k.start + k.hdr
    const n = k.end - p
    let cnt = 0
    switch (k.type) {
      case 'stsd':
        // version/flags(4) + entry_count(4) 之后是第一个 SampleEntry 的 size(4)+type(4)
        if (n < 16) return null
        s.format = buf.toString('latin1', p + 12, p + 16)
        s.stsdEntry = p + 8
        break
      case 'stts':
        cnt = u32(buf, p + 4)
        if (n < 8 + cnt * 8) return null
        s.stts = new Array(cnt)
        for (let i = 0; i < cnt; i++) s.stts[i] = { count: u32(buf, p + 8 + i * 8), delta: u32(buf, p + 12 + i * 8) }
        break
      case 'ctts': {
        cnt = u32(buf, p + 4)
        if (n < 8 + cnt * 8) return null
        const signed = buf[p] === 1
        const runs = new Array(cnt)
        for (let i = 0; i < cnt; i++) {
          runs[i] = { count: u32(buf, p + 8 + i * 8), offset: signed ? i32(buf, p + 12 + i * 8) : u32(buf, p + 12 + i * 8) }
        }
        s.ctts = { box: k, runs }
        break
      }
      case 'stsc':
        cnt = u32(buf, p + 4)
        if (n < 8 + cnt * 12) return null
        s.stsc = new Array(cnt)
        for (let i = 0; i < cnt; i++) {
          const o = p + 8 + i * 12
          s.stsc[i] = { first: u32(buf, o), count: u32(buf, o + 4), desc: u32(buf, o + 8) }
        }
        break
      case 'stsz': {
        const uniform = u32(buf, p + 4)
        cnt = u32(buf, p + 8)
        if (uniform) {
          s.sizes = new Uint32Array(cnt).fill(uniform)
        } else {
          if (n < 12 + cnt * 4) return null
          s.sizes = readU32Array(buf, p + 12, cnt)
        }
        break
      }
      case 'stz2': {
        cnt = u32(buf, p + 8)
        const field = buf[p + 7]
        if (field !== 4 && field !== 8 && field !== 16) return null
        s.sizes = new Uint32Array(cnt)
        for (let i = 0; i < cnt; i++) {
          if (field === 16) s.sizes[i] = buf.readUInt16BE(p + 12 + i * 2)
          else if (field === 8) s.sizes[i] = buf[p + 12 + i]
          else s.sizes[i] = (buf[p + 12 + (i >> 1)] >> ((i & 1) ? 0 : 4)) & 15
        }
        break
      }
      case 'stco':
      case 'co64': {
        const wide = k.type === 'co64'
        cnt = u32(buf, p + 4)
        if (n < 8 + cnt * (wide ? 8 : 4)) return null
        s.offsets = new Float64Array(cnt)
        for (let i = 0; i < cnt; i++) s.offsets[i] = wide ? u64(buf, p + 8 + i * 8) : u32(buf, p + 8 + i * 4)
        s.offsetsBox = k
        break
      }
      case 'stss':
        cnt = u32(buf, p + 4)
        if (n < 8 + cnt * 4) return null
        s.stss = readU32Array(buf, p + 8, cnt)
        break
      default:
        break
    }
  }
  return s.stts && s.stsc && s.sizes && s.offsets ? s : null
}

/** 读一条轨:句柄类型、时基、时长、样本表 */
function readTrak(moov, box) {
  const t = { box, handler: '', format: '', timescale: 1, duration: 0, stbl: null }
  const kids = children(moov, box.start + box.hdr, box.end)
  if (!kids) return t
  t.tkhdBox = kids.find(b => b.type === 'tkhd') || null
  t.editDurationUnits = readEditDuration(moov, kids.find(b => b.type === 'edts'))   // 呈现时长(影片时基);没有编辑列表为 null
  const mdia = kids.find(b => b.type === 'mdia')
  if (!mdia) return t
  const mk = children(moov, mdia.start + mdia.hdr, mdia.end)
  if (!mk) return t
  for (const m of mk) {
    if (m.type === 'mdhd') {
      const f = durationField(moov, m, 'mdhd')
      t.timescale = u32(moov, f.timescaleOff) || 1
      t.duration = f.size === 8 ? u64(moov, f.off) : u32(moov, f.off)
      t.mdhdBox = m
    } else if (m.type === 'hdlr') {
      t.handler = moov.toString('latin1', m.start + m.hdr + 8, m.start + m.hdr + 12)
    } else if (m.type === 'minf') {
      const fk = children(moov, m.start + m.hdr, m.end)
      const sb = fk && fk.find(b => b.type === 'stbl')
      if (sb) {
        t.stbl = readStbl(moov, sb)
        t.stblBox = sb
        t.minfBox = m
      }
    }
  }
  t.format = (t.stbl && t.stbl.format) || ''
  return t
}

/** 编辑列表 elst 各段时长之和(影片时基);没有或读不出返回 null */
function readEditDuration(moov, edts) {
  if (!edts) return null
  const elst = findChild(moov, edts, 'elst')
  if (!elst) return null
  const p = elst.start + elst.hdr
  const v1 = moov[p] === 1
  const cnt = u32(moov, p + 4)
  const entry = v1 ? 20 : 12
  if (elst.end - p < 8 + cnt * entry) return null
  let sum = 0
  for (let i = 0; i < cnt; i++) {
    const o = p + 8 + i * entry
    sum += v1 ? u64(moov, o) : u32(moov, o)
  }
  return sum
}

/** 解析 moov 载荷(不含 box 头);结构认不出抛 PlanError */
function analyzeMoov(moov) {
  const kids = children(moov, 0, moov.length)
  if (!kids) throw new PlanError('BAD_MOOV', '视频结构认不出来')
  const info = { movieTimescale: 1, movieDuration: 0, fragmented: false, traks: [], boxes: kids }
  for (const k of kids) {
    if (k.type === 'mvhd') {
      const f = durationField(moov, k, 'mvhd')
      info.movieTimescale = u32(moov, f.timescaleOff) || 1
      info.movieDuration = f.size === 8 ? u64(moov, f.off) : u32(moov, f.off)
      info.mvhdBox = k
    } else if (k.type === 'mvex') {
      info.fragmented = true
      info.mvexBox = k
    } else if (k.type === 'trak') {
      info.traks.push(readTrak(moov, k))
    }
  }
  return info
}

/** AudioSampleEntry 里的声道数/采样率(展示用;读不到返回 0) */
function audioEntryInfo(moov, trak) {
  const e = trak.stbl && trak.stbl.stsdEntry
  if (!e || e + 36 > moov.length) return { channels: 0, sampleRate: 0 }
  return { channels: moov.readUInt16BE(e + 24), sampleRate: u32(moov, e + 32) >>> 16 }
}

/** 在 box 里按类型找直接子 box */
function findChild(buf, box, type) {
  const kids = children(buf, box.start + box.hdr, box.end)
  return kids ? kids.find(b => b.type === type) || null : null
}

/** 选主音轨:优先未加密;其次媒体时长最长;并列取先出现的 */
function pickAudio(traks) {
  const audio = traks.filter(t => t.handler === 'soun' && t.stbl)
  if (!audio.length) return null
  let best = audio[0]
  for (const t of audio.slice(1)) {
    const aClear = best.format !== 'enca'
    const bClear = t.format !== 'enca'
    if (aClear !== bClear) { if (bClear) best = t; continue }
    if (t.duration / t.timescale > best.duration / best.timescale + 0.001) best = t
  }
  return best
}

module.exports = {
  PlanError, u32, i32, u64, children, boxHeader, PRINTABLE,
  makeBox, u32buf, countAnd, fullBox, verFlags, durationField, patchDuration,
  analyzeMoov, audioEntryInfo, findChild, pickAudio,
}
