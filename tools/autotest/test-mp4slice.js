#!/usr/bin/env node
/**
 * 云端「只取音轨 + 时间切片」模块回归（不需要开发者工具）
 *
 * 1) ffmpeg 现场生成各种形态的 mp4 → mp4slice.planAudioSlice() → 按计划拼出成品
 * 2) 成品用系统 ffprobe/ffmpeg 校验：只有一条音轨、时长对、能解、无报错
 * 3) 成品 PCM 与 ffmpeg 从原视频解出的 PCM 逐样本比对（切片从第 4 帧起比，首帧有变换窗重叠）
 * 4) 再用小程序自带解码器（tools/autotest/lib/ffdecode-node）开一遍：时长 / 定位 / PCM
 *
 * 可选环境变量：
 *   TD_REAL_SAMPLES=<目录>  里面有 dy.mp4 / sph.mp4（抖音、视频号真实样本）时一并测
 *                            （它们的音频是「一包一块」的碎片交织，ffmpeg 现场生成不出来）
 *
 * 运行：node tools/autotest/test-mp4slice.js
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync, spawnSync } = require('child_process')

const ROOT = path.resolve(__dirname, '../..')
const box = require(path.join(ROOT, 'cloudfunctions/fetchMedia/mp4box.js'))
const slice = require(path.join(ROOT, 'cloudfunctions/fetchMedia/mp4slice.js'))
const ff = require('./lib/ffdecode-node')

const FIX = {}
const ENC = {}
let TMP = ''

// ---------- 小测试框架 ----------
const tests = []
function test(name, fn) { tests.push({ name, fn }) }

// ---------- ffmpeg / ffprobe ----------
function ffmpeg(args, input) {
  return execFileSync('ffmpeg', ['-v', 'error', '-y'].concat(args), { input, maxBuffer: 1 << 30, stdio: ['pipe', 'pipe', 'pipe'] })
}
function ffprobeJson(file) {
  return JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { maxBuffer: 1 << 24 }).toString())
}
/** 解码成交错 float(与自带解码器的输出同布局) */
function decodeFloat(file, extra) {
  const buf = ffmpeg((extra || []).concat(['-i', file, '-map', '0:a:0', '-f', 'f32le', '-']))
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
}
function decodeErrors(file) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-'], { maxBuffer: 1 << 24 })
  return r.stderr.toString().trim()
}

// ---------- mp4 工具 ----------
function topBoxes(buf) {
  const out = []
  let p = 0
  while (p + 8 <= buf.length) {
    const h = box.boxHeader(buf, p)
    assert(h, '坏 box 头 @' + p)
    const size = h.size === 0 ? buf.length - p : h.size
    out.push({ type: h.type, start: p, end: p + size, hdr: h.hdr })
    p += size
  }
  return out
}
function moovOf(buf) {
  const b = topBoxes(buf).find(x => x.type === 'moov')
  return buf.subarray(b.start + b.hdr, b.end)
}
function ftypOf(buf) {
  const b = topBoxes(buf)[0]
  return b && b.type === 'ftyp' ? buf.subarray(0, b.end) : null
}
/** 模拟云端:文件头 + 按计划从源文件搬字节段 */
function assemble(src, plan) {
  const parts = [plan.header]
  let got = plan.header.length
  for (const p of plan.pieces) {
    assert(p.src >= 0 && p.src + p.len <= src.length, '字节段越界')
    parts.push(src.subarray(p.src, p.src + p.len))
    got += p.len
  }
  assert.strictEqual(got, plan.totalBytes, '拼出来的长度和计划对不上')
  return Buffer.concat(parts)
}
function planOf(src, opts) {
  return slice.planAudioSlice(moovOf(src), ftypOf(src), src.length, opts || {})
}
/** 原视频音轨的样本总数 */
function planFrames(src, a) {
  return a.frames
}

function maxDiff(a, b, ai, bi, n) {
  let m = 0
  for (let i = 0; i < n; i++) {
    const d = Math.abs(a[ai + i] - b[bi + i])
    if (d > m) m = d
  }
  return m
}

/**
 * 校验一个切片成品。
 * @param {Buffer} src      原视频
 * @param {object} plan     mp4slice 的计划
 * @param {object} refs     { byDefault: 原视频默认解码, byMedia: -ignore_editlist 解码 }
 * @param {object} expect   { mode, durationSec, startSec, sampleRate, channels, spf(每帧采样数) }
 */
function verifySlice(src, plan, refs, expect) {
  const out = assemble(src, plan)
  const file = path.join(TMP, 'out-' + expect.label + '.m4a')
  fs.writeFileSync(file, out)

  assert.strictEqual(plan.mode, expect.mode, expect.label + ' 模式')
  const info = ffprobeJson(file)
  const streams = info.streams
  assert.strictEqual(streams.length, 1, expect.label + ' 应只有一条轨，实际 ' + streams.map(s => s.codec_type).join(','))
  assert.strictEqual(streams[0].codec_type, 'audio', expect.label + ' 应是音频轨')
  assert.strictEqual(streams[0].sample_rate, String(expect.sampleRate), expect.label + ' 采样率')
  assert.strictEqual(streams[0].channels, expect.channels, expect.label + ' 声道数')
  const dur = Number(streams[0].duration)
  assert(Math.abs(dur - expect.durationSec) < 0.06, expect.label + ' 时长 ' + dur + ' ≠ ' + expect.durationSec)
  const err = decodeErrors(file)
  assert(!err, expect.label + ' ffmpeg 解码报错: ' + err)

  // PCM:成品 vs 原视频,按真实媒体时间逐帧对齐(帧长不均匀也对)
  const got = decodeFloat(file)
  const a = expect.audio
  const ch = expect.channels
  const s0 = expect.mode === 'full' ? 0 : expect.sampleStart   // 成品第 k 帧 = 原视频第 (s0 + k) 帧
  const mediaEnd = Math.round(slice.totalUnits(a.stts) * a.sampleRate / a.timescale)   // 原视频最后一个样本的结束位置
  const frames = expect.mode === 'full' ? planFrames(src, a) : plan.sampleCount
  // 切片从第 4 帧起逐样本一致(首几帧缺上一帧的重叠窗)。
  // 例外:HE-AAC/HE-AACv2(SBR + 参数化立体声)的解码器带内部状态,从任何位置起解都会和
  // 「从头连续解」有细微差异(ffmpeg 自己 seek 进去也一样,实测偏差还更大),这是编码格式的固有特性
  const stateful = /^HE-AAC/.test(streams[0].profile || '')
  const skip = expect.mode === 'full' ? 0 : (stateful ? 5 : 3)
  const tol = expect.mode === 'full' ? 1e-4 : (stateful ? 0.25 : 1e-4)
  const ref = expect.mode === 'full' ? refs.byDefault : refs.byMedia
  let worst = 0
  for (let k = skip; k < frames; k++) {
    const from = sampleOffset(a, s0 + k)
    const to = s0 + k + 1 < a.frames ? sampleOffset(a, s0 + k + 1) : mediaEnd   // 末帧通常比标准帧短
    const outFrom = from - sampleOffset(a, s0)
    const d = maxDiff(got, ref, outFrom * ch, from * ch, (to - from) * ch)
    if (d > worst) worst = d
  }
  assert(worst < tol, expect.label + ' 与原视频 PCM 对不上，最大偏差 ' + worst)
  assert(Math.abs(got.length / ch / expect.sampleRate - dur) < a.spf * 2 / expect.sampleRate, expect.label + ' 解出的样本数和时长对不上')

  // 自带解码器:能开、时长对、定位准、PCM 与系统 ffmpeg 一致
  // (编译时没带的解码器 —— 比如 alac —— 到这里就是「没找到声音」,这种编码只验到上一步)
  let h
  try {
    h = ff.open(out)
  } catch (e) {
    if (e.ffErr === 3) { console.log('      (自带解码器没有 ' + streams[0].codec_name + ' 解码器,跳过自带解码器校验)'); return worst }
    throw e
  }
  assert(Math.abs(h.dur - expect.durationSec) < 0.06, expect.label + ' 自带解码器时长 ' + h.dur + ' ≠ ' + expect.durationSec)
  assert.strictEqual(h.rate, expect.sampleRate, expect.label + ' 自带解码器采样率')
  const pcm = ff.decodeAll()
  assert(Math.abs(pcm.length - got.length) <= expect.spf * ch * 2, expect.label + ' 自带解码器样本数 ' + pcm.length + ' vs ' + got.length)
  const wasmDiff = maxDiff(pcm, got, 0, 0, Math.min(pcm.length, got.length))
  // 两版 ffmpeg(自带的是 7.1、系统的是 9.x)的 AAC 浮点舍入允许末位噪声
  assert(wasmDiff < 1e-4, expect.label + ' 自带解码器 PCM 与 ffmpeg 不一致 ' + wasmDiff)
  for (const t of [0.5, expect.durationSec / 2, Math.max(0, expect.durationSec - 1)]) {
    ff.reopen(h)
    assert.strictEqual(ff.seek(t), 0, expect.label + ' seek ' + t + ' 失败 err=' + ff.F('ff_err')())
    const r = ff.pullSec(0.3)
    assert(r.frames > 0 && r.peak > 1e-3, expect.label + ' seek ' + t + ' 后没解出声音')
    const at = ff.tell()
    assert(at >= t - 0.05 && at <= t + 1.2, expect.label + ' seek ' + t + ' 实际落在 ' + at)
  }
  ff.close(h)
  return worst
}

function refsOf(src) {
  const file = path.join(TMP, 'src-' + Math.random().toString(36).slice(2, 8) + '.mp4')
  fs.writeFileSync(file, src)
  return { byDefault: decodeFloat(file), byMedia: decodeFloat(file, ['-ignore_editlist', '1']) }
}

/** 源文件的音频参数(采样率/声道/每帧采样数/媒体时长) */
function audioOf(src) {
  const info = box.analyzeMoov(moovOf(src))
  const trak = box.pickAudio(info.traks)
  const n = trak.stbl.sizes.length
  const mediaDur = slice.totalUnits(trak.stbl.stts) / trak.timescale
  const entry = box.audioEntryInfo(moovOf(src), trak)
  const chunks = slice.buildChunks(trak)
  // 帧长按首段 stts 算(末帧通常是短帧,不能用平均值);最大块时长 = 起点对齐块首时最多提前多久
  const spf = Math.round(trak.stbl.stts[0].delta * entry.sampleRate / trak.timescale)
  const maxChunkSec = Math.max(...chunks.map(c => c.count)) * spf / entry.sampleRate
  return { sampleRate: entry.sampleRate, channels: entry.channels, spf, maxChunkSec, mediaDur, frames: n, format: trak.format, stts: trak.stbl.stts, timescale: trak.timescale }
}

/** 原视频第 m 个样本在参考 PCM 里的起点(按真实媒体时间算,帧长不均匀也对) */
function sampleOffset(a, m) {
  return Math.round(slice.dtsOfSample(a.stts, m) * a.sampleRate / a.timescale)
}

// ---------- 夹具 ----------
const lavfi = graph => ['-f', 'lavfi', '-i', graph]
const VSRC = lavfi('testsrc=size=160x90:rate=5:duration=20')
const ASRC = sr => lavfi('sine=frequency=440:sample_rate=' + sr + ':duration=20')
const VIDEO = ['-c:v', 'mpeg4', '-q:v', '8']
const FAST = ['-movflags', '+faststart']
const MAP = ['-map', '0:v', '-map', '1:a']

/** 生成夹具:输入在前,输出参数在后,逐段拍平 */
function mk(name, ...parts) {
  const file = path.join(TMP, name + '.mp4')
  ffmpeg([].concat(...parts).concat([file]))
  FIX[name] = fs.readFileSync(file)
  return FIX[name]
}

function buildFixtures() {
  const has = id => ENC[id]
  mk('stereo', VSRC, ASRC(44100), MAP, VIDEO, ['-c:a', 'aac', '-ac', '2'], FAST)
  mk('nofast', VSRC, ASRC(44100), MAP, VIDEO, ['-c:a', 'aac', '-ac', '2'])
  mk('mono48', VSRC, ASRC(48000), MAP, VIDEO, ['-c:a', 'aac', '-ac', '1'], FAST)
  mk('pcm', VSRC, ASRC(22050), MAP, VIDEO, ['-c:a', 'pcm_s16le'], FAST)
  mk('videoonly', VSRC, ['-an'], VIDEO, FAST)
  mk('frag', VSRC, ASRC(44100), MAP, VIDEO, ['-c:a', 'aac'], ['-movflags', '+faststart+frag_keyframe+empty_moov+default_base_moof'])
  if (has('alac')) mk('alac', VSRC, ASRC(44100), MAP, VIDEO, ['-c:a', 'alac'], FAST)
  if (has('libmp3lame')) mk('mp3inmp4', VSRC, ASRC(44100), MAP, VIDEO, ['-c:a', 'libmp3lame', '-b:a', '96k'], FAST)
  // 两条音轨(一长 20 秒、一短 8 秒)+ 画面:应选长的那条
  mk('twoaudio', VSRC, ASRC(44100), lavfi('sine=frequency=330:sample_rate=32000:duration=8'),
    ['-map', '0:v', '-map', '1:a', '-map', '2:a'], VIDEO, ['-c:a', 'aac', '-ac', '2'], ['-c:a', 'aac', '-ac', '1'], FAST)
  // 13 分钟、25fps:moov 超过 256KB,切片点落在大文件中段
  mk('long', lavfi('testsrc=size=160x90:rate=25:duration=780'), lavfi('sine=frequency=440:sample_rate=48000:duration=780'),
    MAP, ['-c:v', 'mpeg4', '-q:v', '12'], ['-c:a', 'aac', '-ac', '2'], FAST)
}

/** 重组 box:childFn 返回 Buffer 就替换该子 box */
function rebuildBox(buf, boxObj, childFn) {
  const kids = box.children(buf, boxObj.start + boxObj.hdr, boxObj.end)
  const parts = kids.map(k => {
    const r = childFn(k)
    return r === undefined ? buf.subarray(k.start, k.end) : r
  })
  return box.makeBox(boxObj.type, Buffer.concat(parts))
}

/**
 * 换掉源文件音轨的 stbl(其余不动)。
 * 做法:原 moov 的位置放一个同大小的 free 占位(数据偏移因此不变),新 moov 追加到文件尾。
 */
function withAudioStbl(src, makeStbl) {
  const tops = topBoxes(src)
  const moovBox = tops.find(b => b.type === 'moov')
  const moov = src.subarray(moovBox.start + moovBox.hdr, moovBox.end)
  const trak = box.pickAudio(box.analyzeMoov(moov).traks)
  const mdia = box.findChild(moov, trak.box, 'mdia')
  const minf = box.findChild(moov, mdia, 'minf')
  const stbl = box.findChild(moov, minf, 'stbl')
  const stbl2 = makeStbl(moov, stbl)
  const minf2 = rebuildBox(moov, minf, k => (k === stbl ? stbl2 : undefined))
  const mdia2 = rebuildBox(moov, mdia, k => (k === minf ? minf2 : undefined))
  const trak2 = rebuildBox(moov, trak.box, k => (k === mdia ? mdia2 : undefined))
  const moovKids = box.children(moov, 0, moov.length)
  const moov2 = box.makeBox('moov', Buffer.concat(moovKids.map(k => (k === trak.box ? trak2 : moov.subarray(k.start, k.end)))))
  const parts = tops.map(b => (b === moovBox ? box.makeBox('free', Buffer.alloc(b.end - b.start - 8)) : src.subarray(b.start, b.end)))
  return Buffer.concat(parts.concat([moov2]))
}

/** 把 stereo 的音轨 stco 换成 co64(64 位块偏移) */
function toCo64(src) {
  return withAudioStbl(src, (payload, stbl) => {
    const stco = box.findChild(payload, stbl, 'stco')
    const cnt = box.u32(payload, stco.start + stco.hdr + 4)
    const body = [payload.subarray(stco.start + stco.hdr, stco.start + stco.hdr + 4)]
    for (let i = 0; i < cnt; i++) {
      const v = Buffer.alloc(8)
      v.writeBigUInt64BE(BigInt(box.u32(payload, stco.start + stco.hdr + 8 + i * 4)))
      body.push(v)
    }
    return box.makeBox('co64', Buffer.concat(body))
  })
}

// ---------- 用例 ----------
function cases(name, slices) {
  const src = FIX[name]
  const a = audioOf(src)
  test(name + ' · 参数', () => {
    assert(a.sampleRate > 0 && a.channels > 0 && a.spf > 0, '夹具音频参数不对: ' + JSON.stringify(a))
  })
  test(name + ' · 整段只留音轨', () => {
    const refs = refsOf(src)
    const plan = planOf(src)
    assert(plan.durationSec > 0 && plan.durationSec <= a.mediaDur + 1e-6, '整段时长应在 (0, 媒体时长] 内: ' + plan.durationSec)
    verifySlice(src, plan, refs, { mode: 'full', durationSec: plan.durationSec, startSec: 0, audio: a, sampleRate: a.sampleRate, channels: a.channels, spf: a.spf, label: name + '-full' })
    assert(plan.totalBytes < src.length, '只留音轨后应该更小')
  })
  for (const s of slices) {
    test(name + ' · 切片 ' + s.start + '~' + s.end + 's', () => {
      const refs = refsOf(src)
      const plan = planOf(src, { startSec: s.start, endSec: s.end })
      const want = Math.min(s.end, a.mediaDur) - s.start
      // 起点对齐到块首:最多提前一个块,时长相应多出这么多
      assert(plan.durationSec >= want - a.spf / a.sampleRate - 0.01 && plan.durationSec <= want + a.maxChunkSec + a.spf / a.sampleRate,
        '切片时长 ' + plan.durationSec + ' 应约等于 ' + want + '(可多出一个块 ' + a.maxChunkSec + 's)')
      verifySlice(src, plan, refs, { mode: 'slice', durationSec: plan.durationSec, startSec: plan.startSec, sampleStart: plan.sampleStart,
        audio: a, sampleRate: a.sampleRate, channels: a.channels, spf: a.spf, label: name + '-' + s.start })
      assert(plan.startSec <= s.start + 1e-6 && s.start - plan.startSec < a.maxChunkSec + 1e-6, '切片起点应对齐到块首且不超过一个块: ' + plan.startSec)
    })
  }
}

async function main() {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'td-mp4slice-'))
  ENC.list = execFileSync('ffmpeg', ['-hide_banner', '-encoders']).toString()
  for (const id of ['alac', 'libmp3lame']) ENC[id] = ENC.list.includes(' ' + id + ' ')
  await ff.load()
  buildFixtures()

  cases('stereo', [{ start: 5, end: 12 }, { start: 15, end: 40 }, { start: 0, end: 7 }])
  cases('nofast', [{ start: 5, end: 12 }])
  cases('mono48', [{ start: 5, end: 12 }])
  cases('pcm', [{ start: 5, end: 12 }])
  if (FIX.alac) cases('alac', [{ start: 5, end: 12 }])
  if (FIX.mp3inmp4) cases('mp3inmp4', [{ start: 5, end: 12 }])
  test('long · 参数', () => assert(audioOf(FIX.long).mediaDur > 700, '长夹具应超过 700s'))
  for (const s of [{ start: 0, end: 600 }, { start: 600.5, end: 1200 }, { start: 719, end: 1200 }, { start: 300, end: 360 }]) {
    test('long · 切片 ' + s.start + '~' + s.end + 's', () => {
      const src = FIX.long
      const a = audioOf(src)
      const refs = refsOf(src)
      const plan = planOf(src, { startSec: s.start, endSec: s.end })
      verifySlice(src, plan, refs, { mode: 'slice', durationSec: plan.durationSec, startSec: plan.startSec, sampleStart: plan.sampleStart,
        audio: a, sampleRate: a.sampleRate, channels: a.channels, spf: a.spf, label: 'long-' + s.start })
      const want = Math.min(s.end, a.mediaDur) - s.start
      assert(plan.durationSec >= want - 0.03 && plan.durationSec <= want + a.maxChunkSec + 0.03, '长切片时长 ' + plan.durationSec + ' 应约等于 ' + want)
    })
  }

  test('twoaudio · 选最长的音轨', () => {
    const src = FIX.twoaudio
    const plan = planOf(src)
    const a = audioOf(src)
    const refs = refsOf(src)
    verifySlice(src, plan, refs, { mode: 'full', durationSec: plan.durationSec, startSec: 0, audio: a, sampleRate: a.sampleRate, channels: a.channels, spf: a.spf, label: 'twoaudio' })
    assert(a.mediaDur > 19, '应选 20 秒那条轨,实际 ' + a.mediaDur)
  })
  test('co64 · 64 位块偏移', () => {
    const src = toCo64(FIX.stereo)
    const file = path.join(TMP, 'co64.mp4')
    fs.writeFileSync(file, src)
    const info = ffprobeJson(file)
    assert.strictEqual(info.streams.length, 2, 'co64 夹具应仍是 2 条轨')
    const a = audioOf(FIX.stereo)
    const refs = refsOf(src)
    const plan = planOf(src)
    verifySlice(src, plan, refs, { mode: 'full', durationSec: plan.durationSec, startSec: 0, audio: a, sampleRate: a.sampleRate, channels: a.channels, spf: a.spf, label: 'co64-full' })
    const plan2 = planOf(src, { startSec: 5, endSec: 12 })
    verifySlice(src, plan2, refs, { mode: 'slice', durationSec: plan2.durationSec, startSec: plan2.startSec, sampleStart: plan2.sampleStart,
        audio: a, sampleRate: a.sampleRate, channels: a.channels, spf: a.spf, label: 'co64-slice' })
  })
  test('videoonly · 报「没有声音」', () => {
    assert.throws(() => planOf(FIX.videoonly), e => e.code === 'NO_AUDIO')
  })
  test('frag · 分片式不走渐进式这条路', () => {
    assert.throws(() => planOf(FIX.frag), e => e.code === 'FRAGMENTED')
  })
  test('坏 moov · 报结构认不出', () => {
    const full = moovOf(FIX.stereo)
    for (const bad of [full.subarray(0, full.length - 5), Buffer.concat([full, Buffer.from([0, 0, 0, 1])])]) {   // 截断 / 尾部多出垃圾
      assert.throws(() => slice.planAudioSlice(bad, null, 0, {}), e => e.code === 'BAD_MOOV')
    }
  })
  test('字节段越界 · 报音轨位置超出文件范围', () => {
    assert.throws(() => slice.planAudioSlice(moovOf(FIX.stereo), ftypOf(FIX.stereo), 1000, {}), e => e.code === 'BAD_TABLES')
  })
  test('起点在结尾之后 · EMPTY 或只剩最后一块', () => {
    const a = audioOf(FIX.stereo)
    let plan = null
    try { plan = planOf(FIX.stereo, { startSec: a.mediaDur + 5, endSec: a.mediaDur + 10 }) } catch (e) { assert.strictEqual(e.code, 'EMPTY'); return }
    assert(plan.durationSec < 1.2, '起点在结尾之后最多只剩最后一块')
  })

  const realDir = process.env.TD_REAL_SAMPLES
  if (realDir) {
    for (const name of ['dy.mp4', 'sph.mp4']) {
      const p = path.join(realDir, name)
      if (!fs.existsSync(p)) continue
      FIX['real-' + name] = fs.readFileSync(p)
      cases('real-' + name, [{ start: 3, end: 9 }, { start: 0, end: 5 }])
    }
  }

  let pass = 0
  let fail = 0
  for (const t of tests) {
    try {
      await t.fn()
      pass++
      console.log('  ✓ ' + t.name)
    } catch (e) {
      fail++
      console.log('  ✗ ' + t.name + '\n      ' + String(e && e.message || e).split('\n').join('\n      '))
    }
  }
  console.log('\n' + pass + ' 过 / ' + fail + ' 败   (临时目录 ' + TMP + ')')
  process.exit(fail ? 1 : 0)
}

main().catch(e => { console.error(e); process.exit(1) })
