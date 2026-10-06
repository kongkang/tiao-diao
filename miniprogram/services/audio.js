// 音频服务：选文件 → 读字节 → 嗅探 → Worker 统一解码（FFmpeg WASM）→ 元数据
// PCM 全程常驻 Worker（v3 内存架构）：主线程只传文件字节（几 MB）和收小结果包，
// 不再有全量 PCM 跨线程拷贝（不支持 transfer 的机型上那是真机 OOM 的主因）。

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

// ---------- 试听播放（WebAudio，主线程） ----------
let playCtx = null
let playingSource = null
let playingEndTimer = null
let playingFinish = null   // 当前播放的收尾函数（stopPreview 主动调它，解除调用方等待）
// 暂停/进度跟踪：remaining 记"还剩多少毫秒音频"，markAt 记最近一次起跑/暂停时刻
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

/** 播放交错 Float32 立体声 PCM（Worker 试听结果）
 *  Promise 在「自然播完 / 被 stopPreview 打断 / 超时兜底」三种情况下都会 resolve。
 *  真机 onended 不保证触发，绝不能只靠它，否则页面的 previewing 状态会永久卡住。 */
function playInterleavedF32(buffer, sampleRate) {
  const frames = buffer.byteLength / 8
  const interleaved = new Float32Array(buffer)
  const ctx = getPlayCtx()
  const audioBuffer = ctx.createBuffer(2, frames, sampleRate)
  const dL = audioBuffer.getChannelData(0)
  const dR = audioBuffer.getChannelData(1)
  for (let i = 0; i < frames; i++) {
    dL[i] = interleaved[i * 2]
    dR[i] = interleaved[i * 2 + 1]
  }
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
    // 静音模式下走 0 增益的 GainNode（只跑流程不出声，自动化测试用）
    if (previewMuted) {
      if (!muteGain) {
        muteGain = ctx.createGain()
        muteGain.gain.value = 0
        muteGain.connect(ctx.destination)
      }
      src.connect(muteGain)
    } else {
      src.connect(ctx.destination)
    }
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

/** 暂停（suspend 整个 WebAudioContext，音源位置原地冻住；基础库版本需以官方文档核实） */
function pausePreview() {
  if (!playingSource || playPaused) return
  playRemainingMs = Math.max(0, playRemainingMs - (Date.now() - playMarkAt))
  if (playingEndTimer) { clearTimeout(playingEndTimer); playingEndTimer = null }
  playPaused = true
  try { getPlayCtx().suspend() } catch (e) { /* 老基础库无 suspend 时静默降级 */ }
}

/** 续播：从冻住的位置接着唱，兜底定时器按剩余时长重挂 */
function resumePreview() {
  if (!playingSource || !playPaused) return
  playPaused = false
  playMarkAt = Date.now()
  try { getPlayCtx().resume() } catch (e) { /* 同上 */ }
  playingEndTimer = setTimeout(() => { if (playingFinish) playingFinish() }, playRemainingMs + 350)
}

/** 播放进度查询（页面进度条用）：null = 没有在播 */
function getPreviewState() {
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
  // 暂停中被掐停：先把 context 解冻，否则会影响下一次播放
  if (playPaused) {
    playPaused = false
    try { getPlayCtx().resume() } catch (e) { /* */ }
  }
  if (playingEndTimer) { clearTimeout(playingEndTimer); playingEndTimer = null }
  if (playingSource) {
    try { playingSource.stop() } catch (e) { /* 已结束 */ }
    playingSource.onended = null   // 主动停止，不需要 onended 再收尾
    playingSource = null
  }
  if (playingFinish) { const f = playingFinish; playingFinish = null; f() }
}

module.exports = { loadSong, ensureSong, playInterleavedF32, stopPreview, pausePreview, resumePreview, getPreviewState, setPreviewMuted, sniffFormat }
