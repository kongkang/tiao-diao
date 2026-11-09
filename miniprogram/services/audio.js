// 音频服务：选文件 → 读字节 → 嗅探 → Worker 统一解码（FFmpeg WASM）→ 元数据
// PCM 全程常驻 Worker（v3 内存架构）：主线程只传文件字节（几 MB）和收小结果包，
// 不再有全量 PCM 跨线程拷贝（不支持 transfer 的机型上那是真机 OOM 的主因）。
// 2026-11-09 试听改分片流式：每片 10 秒，边播边取；主线程峰值从整段 3 分钟 PCM
// （约 63MB 交错 + 63MB AudioBuffer）降到约 2 片（约 7MB）。

const config = require('../config.js')
const engine = require('./engine.js')
const { fmtDurationChinese } = require('../utils/format.js')

/** 从微信聊天记录选一个音频文件
 *  wma/ogg/amr/ape 也放进可选列表：真机上 extension 过滤会把列表外的文件直接灰掉、
 *  选不了也没任何解释。放进来 + 解码前嗅探拦截，用户至少能得到明确指引。 */
function chooseMessageFile() {
  return new Promise((resolve, reject) => {
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: ['mp3', 'm4a', 'aac', 'wav', 'flac', 'wma', 'ogg', 'amr', 'ape'],
      success(res) {
        if (!res.tempFiles || !res.tempFiles.length) return reject(new Error('没有选择文件'))
        resolve(res.tempFiles[0])
      },
      fail(err) { reject(new Error(err.errMsg || '选择失败')) },
    })
  })
}

/** 读文件为 ArrayBuffer */
function readFile(path) {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath: path,
      success: res => resolve(res.data),
      fail: err => reject(new Error('读取文件失败：' + (err.errMsg || ''))),
    })
  })
}

/**
 * 魔数嗅探真实格式（chooseMessageFile 的 extension 过滤在部分机型不可靠，
 * 且存在改后缀的假 mp3，必须在解码前自己认一遍文件头）
 */
function sniffFormat(buf) {
  if (!buf || buf.byteLength < 16) return 'unknown'
  const b = new Uint8Array(buf.slice(0, 16))
  // ASF/WMA：GUID 30 26 B2 75
  if (b[0] === 0x30 && b[1] === 0x26 && b[2] === 0xB2 && b[3] === 0x75) return 'wma'
  // RIFF....WAVE
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x41 && b[10] === 0x56 && b[11] === 0x45) return 'wav'
  // fLaC
  if (b[0] === 0x66 && b[1] === 0x4C && b[2] === 0x61 && b[3] === 0x43) return 'flac'
  // ....ftyp（m4a / m4b / mp4 音频）
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return 'm4a'
  // OggS
  if (b[0] === 0x4F && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53) return 'ogg'
  // MAC （Monkey's Audio / ape）
  if (b[0] === 0x4D && b[1] === 0x41 && b[2] === 0x43 && b[3] === 0x20) return 'ape'
  // #!AMR
  if (b[0] === 0x23 && b[1] === 0x21 && b[2] === 0x41 && b[3] === 0x4D) return 'amr'
  // ID3 头 或 MPEG 帧同步（mp3 / ADTS aac，二者都能解码，归一类）
  if ((b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) ||
      (b[0] === 0xFF && (b[1] & 0xE0) === 0xE0)) return 'mp3'
  return 'unknown'
}

/** 暂不支持的格式 → 一句话讲清楚 + 可执行的下一步（不提任何电脑端工具） */
function unsupportedError(format) {
  const tips = {
    ogg: '这个格式手机上暂时打不开，换 mp3 或 m4a 文件试试',
    amr: '这是通话录音格式，暂时打不开，换 mp3 文件试试',
    ape: '这个格式手机上暂时打不开，换 mp3 或 m4a 文件试试',
  }
  return new Error(tips[format] || '这个格式打不开，换 mp3 文件试试')
}

/** 选 + 校验 + 解码（字节进 Worker，PCM 常驻），一步到位 */
async function loadSong() {
  const file = await chooseMessageFile()

  if (file.size > config.MAX_FILE_MB * 1024 * 1024) {
    throw new Error('这个文件太大了（超过 ' + config.MAX_FILE_MB + 'MB），换一个小一点的')
  }

  const buf = await readFile(file.path)
  const format = sniffFormat(buf)
  if (format === 'ogg' || format === 'amr' || format === 'ape') {
    throw unsupportedError(format)
  }

  wx.showLoading({ title: '正在读取', mask: true })
  try {
    const meta = await engine.analyze(buf)
    wx.hideLoading()
    const durationSec = meta.frames / meta.sampleRate
    if (durationSec > config.MAX_DURATION_SEC) {
      engine.abort()   // 常驻数据不要了
      throw new Error('太长了（' + fmtDurationChinese(durationSec) + '），最多支持 8 分钟以内的歌')
    }
    if (durationSec < 2) {
      engine.abort()
      throw new Error('这段音乐太短了')
    }
    const song = {
      path: file.path,
      name: file.name || '音乐',
      size: file.size,
      format,
      token: meta.token,
      frames: meta.frames,
      sampleRate: meta.sampleRate,
      channels: meta.channels,
      durationSec,
    }
    return song
  } catch (e) {
    wx.hideLoading()
    throw e
  }
}

/**
 * 确保这首歌在 Worker 里可用（Worker 进程被杀后常驻数据会丢，
 * 这里自检并自动按 path 重新解码，调用方无感）
 */
async function ensureSong(song) {
  if (!song) throw new Error('还没有选择音乐')
  if (await engine.storeHas(song.token)) return song
  const buf = await readFile(song.path)
  const meta = await engine.analyze(buf)
  song.token = meta.token
  song.frames = meta.frames
  song.sampleRate = meta.sampleRate
  song.channels = meta.channels
  song.durationSec = meta.frames / meta.sampleRate
  return song
}

// ---------- 试听播放（WebAudio，主线程；分片流式控内存） ----------
const PREVIEW_CHUNK_SEC = 10     // 每片 10 秒；单片交错 Float32 立体声约 3.5MB
const PREFETCH_AHEAD_SEC = 6     // 当前片还剩约 6 秒时取下一片（最多预取 1 片）

let playCtx = null
let previewStream = null
let streamSeq = 0

// 旧单块接口状态（兼容 playInterleavedF32 / 老测试脚本）
let playingSource = null
let playingEndTimer = null
let playingFinish = null
let playTotalMs = 0
let playRemainingMs = 0
let playMarkAt = 0
let playPaused = false

// 试听静音开关（自动化回归用：测试脚本打开后只走流程不出声，真机默认 false）
let previewMuted = false
let muteGain = null

function setPreviewMuted(m) { previewMuted = !!m }

function getPlayCtx() {
  if (!playCtx) playCtx = wx.createWebAudioContext()
  return playCtx
}

/** 交错 Float32 → AudioBuffer（复制进 WebAudio 原生内存，JS 侧可立即释放） */
function makeAudioBuffer(ctx, data, sampleRate) {
  const frames = data.byteLength / 8
  const interleaved = new Float32Array(data)
  const audioBuffer = ctx.createBuffer(2, frames, sampleRate)
  const dL = audioBuffer.getChannelData(0)
  const dR = audioBuffer.getChannelData(1)
  for (let i = 0; i < frames; i++) {
    dL[i] = interleaved[i * 2]
    dR[i] = interleaved[i * 2 + 1]
  }
  return audioBuffer
}

/** 每片首尾 8ms 淡入淡出，避免切片边界“咔哒” */
function connectChunk(ctx, src, when, dur) {
  if (previewMuted) {
    if (!muteGain) {
      muteGain = ctx.createGain()
      muteGain.gain.value = 0
      muteGain.connect(ctx.destination)
    }
    src.connect(muteGain)
    return
  }
  const g = ctx.createGain()
  const fade = Math.min(0.008, dur / 4)
  g.gain.setValueAtTime(0, when)
  g.gain.linearRampToValueAtTime(1, when + fade)
  g.gain.setValueAtTime(1, Math.max(when + fade, when + dur - fade))
  g.gain.linearRampToValueAtTime(0, when + dur)
  src.connect(g)
  g.connect(ctx.destination)
}

function streamPosition(stream) {
  if (stream.finished) return stream.durationSec
  const ms = stream.paused
    ? stream.playedMs
    : stream.playedMs + (Date.now() - stream.resumedAt)
  return Math.max(0, Math.min(stream.durationSec, ms / 1000))
}

function clearStreamTimers(stream) {
  if (stream.waitTimer) { clearTimeout(stream.waitTimer); stream.waitTimer = null }
  if (stream.endTimer) { clearTimeout(stream.endTimer); stream.endTimer = null }
}

/** 一片播完就从队列移除，AudioBuffer 才能被回收（否则 18 片会一直挂着） */
function removeSource(stream, src) {
  const i = stream.sources.indexOf(src)
  if (i >= 0) stream.sources.splice(i, 1)
}

function finishStream(stream, playedSec, cancel, err) {
  if (stream.finished) return
  stream.finished = true
  stream.cancelled = true
  clearStreamTimers(stream)
  if (cancel) {
    for (let i = 0; i < stream.sources.length; i++) {
      try { stream.sources[i].stop() } catch (e) { /* 已结束 */ }
      stream.sources[i].onended = null
    }
  }
  stream.sources.length = 0
  if (previewStream === stream) previewStream = null
  if (stream.paused) {
    stream.paused = false
    try { stream.ctx.resume() } catch (e) { /* */ }
  }
  if (err) {
    stream.reject && stream.reject(err)
  } else {
    const pos = Math.max(0, Math.min(stream.durationSec, playedSec))
    stream.resolve && stream.resolve({ playedSec: pos, durationSec: stream.durationSec })
  }
  stream.resolve = null
  stream.reject = null
}

function armStreamEndTimer(stream) {
  clearTimeout(stream.endTimer)
  const remain = Math.max(0, stream.durationSec - streamPosition(stream))
  stream.endTimer = setTimeout(() => finishStream(stream, stream.durationSec, false), remain * 1000 + 3000)
}

/** 等到下一片该取的时候（当前片还剩约 PREFETCH_AHEAD_SEC 秒） */
function waitStream(stream, aheadSec) {
  return new Promise(resolve => {
    const check = () => {
      stream.waitTimer = null
      if (stream.cancelled) return resolve()
      if (stream.paused) { stream.waitTimer = setTimeout(check, 250); return }
      if (stream.nextStartCtx - stream.ctx.currentTime <= aheadSec) return resolve()
      stream.waitTimer = setTimeout(check, 200)
    }
    check()
  })
}

/**
 * 分片试听：从 startSec 到 endSec，每片 10 秒，边播边取。
 * 峰值：Worker 1 片约 7MB + 主线程 2 片 AudioBuffer 约 7MB（不再整段 3 分钟搬运）。
 * Promise 在自然播完 / 被 stopPreview 打断时 resolve({ playedSec, durationSec })；
 * 第一片就失败时 reject，交给页面 toast / 排队重试。
 */
function playPreviewChunked(opts) {
  stopPreview()
  const ctx = getPlayCtx()
  const seq = ++streamSeq
  const startSec = Math.max(0, opts.startSec || 0)
  const endSec = Math.max(startSec, opts.endSec || startSec)
  const total = endSec - startSec
  if (total <= 0.05) return Promise.resolve({ playedSec: 0, durationSec: 0 })

  const stream = {
    seq, ctx, startSec, endSec, durationSec: total,
    playedMs: 0, resumedAt: 0, paused: false,
    nextStartCtx: 0, sources: [], finished: false, cancelled: false,
    waitTimer: null, endTimer: null, lastSource: null,
    resolve: null, reject: null,
  }
  previewStream = stream

  return new Promise((resolve, reject) => {
    stream.resolve = resolve
    stream.reject = reject
    ;(async () => {
      let first = true
      try {
        let from = startSec
        let at = ctx.currentTime + 0.05
        while (from < endSec - 0.01) {
          if (stream.cancelled) return
          if (!first) {
            await waitStream(stream, PREFETCH_AHEAD_SEC)
            if (stream.cancelled) return
          }
          const to = Math.min(endSec, from + PREVIEW_CHUNK_SEC)
          const res = await engine.preview({
            token: opts.token,
            semitones: opts.semitones,
            startSec: from,
            maxSec: to - from,
            sampleRate: opts.sampleRate,
            channels: opts.channels,
          })
          if (stream.cancelled || stream.seq !== seq) return

          const buf = makeAudioBuffer(ctx, res.data, opts.sampleRate)
          const when = Math.max(at, ctx.currentTime + 0.02)
          const src = ctx.createBufferSource()
          src.buffer = buf
          connectChunk(ctx, src, when, buf.duration)
          src.onended = () => {
            removeSource(stream, src)
            if (src === stream.lastSource) finishStream(stream, stream.durationSec, false)
          }
          src.start(when)
          stream.sources.push(src)
          at = when + buf.duration
          stream.nextStartCtx = at

          if (first) {
            first = false
            stream.resumedAt = Date.now()
            armStreamEndTimer(stream)
            opts.onStart && opts.onStart()
          }
          from = to
          if (from >= endSec - 0.01) stream.lastSource = src
        }
        // 所有片已安排：最后一片 onended 或兜底定时器收尾
      } catch (e) {
        if (stream.cancelled) return
        console.warn('[audio] 分片试听失败', (e && e.message) || e)
        if (first) finishStream(stream, 0, true, e)
        else finishStream(stream, streamPosition(stream), true)
      }
    })()
  })
}

/** 兼容旧接口：单块交错 PCM 直接播（页面已改分片，保留给旧调用/测试） */
function playInterleavedF32(buffer, sampleRate) {
  const frames = buffer.byteLength / 8
  const ctx = getPlayCtx()
  const audioBuffer = makeAudioBuffer(ctx, buffer, sampleRate)
  stopPreview()
  const src = ctx.createBufferSource()
  src.buffer = audioBuffer
  return new Promise(resolve => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(playingEndTimer)
      playingEndTimer = null
      playingFinish = null
      resolve()
    }
    playingFinish = finish
    src.onended = finish
    connectChunk(ctx, src, ctx.currentTime, frames / sampleRate)
    src.start()
    playingSource = src
    // 时长兜底：onended 不触发的机型靠它收尾（350ms 余量）
    playTotalMs = (frames / sampleRate) * 1000
    playRemainingMs = playTotalMs
    playMarkAt = Date.now()
    playPaused = false
    playingEndTimer = setTimeout(finish, playTotalMs + 350)
  })
}

/** 暂停：分片流 suspend 整个 WebAudioContext；旧单块接口走原有逻辑 */
function pausePreview() {
  if (previewStream) {
    const s = previewStream
    if (s.paused || s.finished) return
    s.playedMs += Date.now() - s.resumedAt
    s.paused = true
    if (s.endTimer) { clearTimeout(s.endTimer); s.endTimer = null }
    try { s.ctx.suspend() } catch (e) { /* 老基础库无 suspend 时静默降级 */ }
    return
  }
  if (!playingSource || playPaused) return
  playRemainingMs = Math.max(0, playRemainingMs - (Date.now() - playMarkAt))
  if (playingEndTimer) { clearTimeout(playingEndTimer); playingEndTimer = null }
  playPaused = true
  try { getPlayCtx().suspend() } catch (e) { /* */ }
}

/** 续播：分片流 resume；旧单块接口按剩余时长重挂兜底定时器 */
function resumePreview() {
  if (previewStream) {
    const s = previewStream
    if (!s.paused || s.finished) return
    s.paused = false
    s.resumedAt = Date.now()
    try { s.ctx.resume() } catch (e) { /* */ }
    armStreamEndTimer(s)
    return
  }
  if (!playingSource || !playPaused) return
  playPaused = false
  playMarkAt = Date.now()
  try { getPlayCtx().resume() } catch (e) { /* */ }
  playingEndTimer = setTimeout(() => { if (playingFinish) playingFinish() }, playRemainingMs + 350)
}

/** 播放进度查询（页面进度条用）：null = 没有在播 */
function getPreviewState() {
  if (previewStream) {
    return {
      positionSec: streamPosition(previewStream),
      durationSec: previewStream.durationSec,
      paused: previewStream.paused,
    }
  }
  if (!playingSource) return null
  const remaining = playPaused
    ? playRemainingMs
    : Math.max(0, playRemainingMs - (Date.now() - playMarkAt))
  return {
    positionSec: (playTotalMs - remaining) / 1000,
    durationSec: playTotalMs / 1000,
    paused: playPaused,
  }
}

function stopPreview() {
  streamSeq++   // 作废所有在途分片请求的落地
  if (previewStream) {
    const s = previewStream
    finishStream(s, streamPosition(s), true)
  }
  // 旧单块接口
  if (playPaused) {
    playPaused = false
    try { getPlayCtx().resume() } catch (e) { /* */ }
  }
  if (playingEndTimer) { clearTimeout(playingEndTimer); playingEndTimer = null }
  if (playingSource) {
    try { playingSource.stop() } catch (e) { /* 已结束 */ }
    playingSource.onended = null
    playingSource = null
  }
  if (playingFinish) { const f = playingFinish; playingFinish = null; f() }
}

module.exports = {
  loadSong, ensureSong,
  playPreviewChunked, playInterleavedF32,
  stopPreview, pausePreview, resumePreview, getPreviewState,
  setPreviewMuted, sniffFormat,
}
