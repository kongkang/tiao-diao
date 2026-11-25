/**
 * Worker · 音频引擎 v4（流式处理：不再常驻整首 PCM）
 *
 * 核心变化（长音频无时长限制）：
 *   - 输入分块上传：主线程每次 4MB 读文件，Worker malloc 一整块 wasm 输入区后
 *     逐块拷入（每块 ack）。主线程不再持有整文件 ArrayBuffer，避免 100MB 整包
 *     postMessage 的克隆/兼容问题。
 *   - 解码会话：ff_open 只探测元数据，不整首解码；SESSION 保存 {inPtr,inLen,rate,channels}。
 *   - 试听：只在需要的位置解码 10 秒窗口（新 wasm 有 ff_seek/ff_tell 时精确跳转；
 *     旧 wasm 退化为从当前位置顺序解码、远距离回退重开解码器）。
 *   - 全曲：ff_pull 逐块拉 PCM → 流式重采样/WSOLA → Int16 → 单实例 lamejs →
 *     128KB 一块回传主线程 appendFile。内存只与单块相关，与歌曲长度无关。
 *
 * 协议（与 services/engine.js 对应）：
 *   → {type:'analyze_begin', token, totalBytes}      ← {type:'analyze_ready', token}
 *   → {type:'analyze_chunk', token, offset, data}    ← {type:'analyze_chunk_ack', token, offset, bytes}
 *   → {type:'analyze_end', token}                    ← {type:'analyzed', token, frames, sampleRate, channels, durationSec}
 *   → {type:'store_has', token}                      ← {type:'store_has_result', value}
 *   → {type:'preview', token, semitones, startSec, maxSec}
 *                                                    ← {type:'done', result, ext:'pcm', outLength, sampleRate, channels:2}
 *   → {type:'probe', token}                         解码自检：实解开头和结尾
 *      ← {type:'probe_result', token, ok, message, durationSec, sampleRate, channels, peak}
 *   → {type:'process', token, semitones, kbps}
 *      ← meta / progress / chunk{data,bytes} / done / error
 *      → {type:'ack', bytes}                         （主线程落盘后回执，背压）
 */

const dsp = require('./libs/pitch-dsp.js')

// ============ 工具 ============

function interleave(leftF32, rightF32) {
  const frames = Math.min(leftF32.length, rightF32.length)
  const out = new Float32Array(frames * 2)
  for (let i = 0; i < frames; i++) {
    out[i * 2] = leftF32[i]
    out[i * 2 + 1] = rightF32[i]
  }
  return out
}

// ============ FFmpeg WASM（拉取式解码，wasm 堆有界） ============

let ffExports = null
let ffLoadPromise = null

function loadFf() {
  if (ffExports) return Promise.resolve(ffExports)
  if (!ffLoadPromise) {
    // WASI 桩：纯计算路径用不到这些系统调用，但【带出参的必须写回】——
    // 尤其 fd_write 的 nwritten 不写（返回 0 却声称成功），musl 的 fprintf 会认为
    // 短写而无限重试，ffmpeg av_log 第一条日志就把 wasm 卡死（真机级 bug，实测踩过）
    const imports = {
      env: { emscripten_notify_memory_growth: function () {} },
      wasi_snapshot_preview1: {
        fd_write: function (fd, iovs, iovn, nwr) {
          const dv = new DataView(ffExports.memory.buffer)
          let total = 0
          for (let i = 0; i < iovn; i++) {
            total += dv.getUint32(iovs + i * 8 + 4, true)
          }
          dv.setUint32(nwr, total, true)   // 声称全部写出（丢弃日志内容，fprintf 不会重试）
          return 0
        },
        fd_read: function (fd, iovs, iovn, nread) {
          new DataView(ffExports.memory.buffer).setUint32(nread, 0, true)
          return 0
        },
        fd_close: function () { return 0 },
        clock_time_get: function (clk, lo, hi, out) {
          const dv = new DataView(ffExports.memory.buffer)
          const ms = Date.now()
          dv.setUint32(out, ms >>> 0, true)
          dv.setUint32(out + 4, Math.floor(ms / 4294967296), true)
          return 0
        },
        environ_sizes_get: function (pc, pbs) {
          const dv = new DataView(ffExports.memory.buffer)
          dv.setUint32(pc, 0, true)
          dv.setUint32(pbs, 0, true)
          return 0
        },
        environ_get: function () { return 0 },
        fd_fdstat_get: function (fd, buf) {
          return 8   // EBADF：调用方按错误处理，不读 buf
        },
        fd_seek: function () { return 8 },
      },
    }
    ffLoadPromise = WXWebAssembly.instantiate('wasm/ffdecode.wasm.br', imports).then((re) => {
      ffExports = (re && re.instance && re.instance.exports) || re.exports
      if (ffExports._initialize) ffExports._initialize()
      return ffExports
    })
    ffLoadPromise.catch(function () { ffLoadPromise = null })
  }
  return ffLoadPromise
}

const FF_ERR_MSG = {
  1: '手机内存不够，换个短一点的试试',
  2: '这个文件打不开，可能已经损坏',
  3: '这个文件里没有找到声音',
  4: '这首歌可能有加密保护，解不开',
  5: '这个音频格式版本不支持',
  6: '这个文件里没有解出内容',
  7: '出了点问题，再试一次',
  8: '定位失败，再点一次试试',
}

function F(n) {
  return ffExports[n] || ffExports['_' + n]
}

// 传输列表（transferList）在部分机型/实验 Worker 上不支持
// （报错 "transfer is not supported in this version"，真机实测）。
// 统一走安全发送：首次失败自动降级为结构化克隆（多一次拷贝，但保证全机型可用）。
let transferOk = true
function postOut(msg, transfer) {
  if (transfer && transfer.length && transferOk) {
    try { worker.postMessage(msg, transfer); return } catch (e) { transferOk = false }
  }
  worker.postMessage(msg)
}

// ============ 解码会话（不存 PCM，只存压缩输入 + 打开的解码器） ============

const SESSION = {
  token: null,
  inPtr: 0,
  inLen: 0,
  received: 0,
  opened: false,
  rate: 0,
  channels: 1,
  durationSec: 0,
  posFrames: 0,   // 本次 open/seek 之后已拉取的帧数（无 ff_tell 时用于估算位置）
}

function sessionFree() {
  if (!ffExports) {
    SESSION.token = null
    SESSION.inPtr = 0
    SESSION.inLen = 0
    SESSION.received = 0
    SESSION.opened = false
    return
  }
  if (SESSION.opened) {
    try { F('ff_close')() } catch (e) { /* */ }
  }
  if (SESSION.inPtr) {
    try { F('free')(SESSION.inPtr) } catch (e) { /* */ }
  }
  SESSION.token = null
  SESSION.inPtr = 0
  SESSION.inLen = 0
  SESSION.received = 0
  SESSION.opened = false
  SESSION.rate = 0
  SESSION.channels = 1
  SESSION.durationSec = 0
  SESSION.posFrames = 0
}

function sessionOpen() {
  if (SESSION.opened) {
    try { F('ff_close')() } catch (e) { /* */ }
    SESSION.opened = false
  }
  if (F('ff_open')(SESSION.inPtr, SESSION.inLen) < 0) {
    throw new Error(FF_ERR_MSG[F('ff_err')()] || '这个文件打不开')
  }
  SESSION.opened = true
  SESSION.rate = F('ff_rate')() || SESSION.rate || 44100
  SESSION.channels = Math.min(2, F('ff_channels')() || SESSION.channels || 1)
  SESSION.durationSec = F('ff_duration_sec')() || SESSION.durationSec || 0
  SESSION.posFrames = 0
  return SESSION
}

function currentSec() {
  if (F('ff_tell')) {
    const t = F('ff_tell')()
    if (t >= -0.5) return t
  }
  return SESSION.posFrames / (SESSION.rate || 44100)
}

// ============ 输入分块上传 ============

async function doAnalyzeBegin(msg) {
  await loadFf()
  sessionFree()

  const total = msg.totalBytes | 0
  if (total <= 0) throw new Error('文件是空的')
  if (total > 120 * 1024 * 1024) throw new Error('文件超过 100MB，微信读不了')

  const ptr = F('malloc')(total)
  if (!ptr) throw new Error(FF_ERR_MSG[1])

  SESSION.token = msg.token
  SESSION.inPtr = ptr
  SESSION.inLen = total
  SESSION.received = 0
  SESSION.opened = false
  postOut({ type: 'analyze_ready', token: msg.token })
}

function doAnalyzeChunk(msg) {
  if (!SESSION.token || msg.token !== SESSION.token) throw new Error('上传会话丢了，重新选一次')
  const off = msg.offset | 0
  const data = msg.data
  const len = data ? data.byteLength : 0
  if (off !== SESSION.received) throw new Error('上传顺序错了')
  if (!len || off + len > SESSION.inLen) throw new Error('上传数据不完整')

  const heap = new Uint8Array(ffExports.memory.buffer)
  heap.set(new Uint8Array(data), SESSION.inPtr + off)
  SESSION.received += len
  postOut({ type: 'analyze_chunk_ack', token: msg.token, offset: off, bytes: len })
}

function doAnalyzeEnd(msg) {
  if (!SESSION.token || msg.token !== SESSION.token) throw new Error('上传会话丢了，重新选一次')
  if (SESSION.received !== SESSION.inLen) throw new Error('上传还没完成')

  sessionOpen()

  // 个别容器 codecpar 里没有采样率/声道，解一小段再重开
  let rate = SESSION.rate
  let channels = SESSION.channels
  if (!rate || !channels) {
    const probePtr = F('malloc')(65536 * 4)
    if (!probePtr) throw new Error(FF_ERR_MSG[1])
    try {
      F('ff_pull')(probePtr, 65536)
      rate = F('ff_rate')() || rate
      channels = Math.min(2, F('ff_channels')() || channels)
    } finally {
      F('free')(probePtr)
    }
    SESSION.rate = rate
    SESSION.channels = channels || 1
    sessionOpen()   // 重置到 0，后面试听/处理从头开始
  }
  if (!SESSION.rate) throw new Error('读不出采样率，换一首试试')
  if (!SESSION.channels) SESSION.channels = 1

  const durationSec = SESSION.durationSec
  const frames = durationSec > 0 ? Math.round(durationSec * SESSION.rate) : 0
  postOut({
    type: 'analyzed',
    token: msg.token,
    frames,
    sampleRate: SESSION.rate,
    channels: SESSION.channels,
    durationSec,
  })
}

// ============ 试听：只解码窗口 ============

const PULL_FRAMES = 16384   // ≈0.37s@44.1k；ff_pull 的 float 缓冲上限 65536

// 全曲处理复用的 L/R 缓冲（每块编码完即丢，不会留引用）
let pullL = null
let pullR = null

/** 拉一块交错 PCM，返回分声道 float。位置优先用 ff_tell（新 wasm），否则按帧数推。 */
function pullChunk(chunkPtr, framesWanted) {
  const ch = SESSION.channels
  const want = Math.max(1, Math.min(framesWanted, PULL_FRAMES))
  const got = F('ff_pull')(chunkPtr, want * ch)
  if (got < 0) throw new Error(FF_ERR_MSG[F('ff_err')()] || '解码中断了')
  if (got === 0) return { n: 0, L: null, R: null, startSec: 0, endSec: 0 }
  const n = got / ch
  const view = new Float32Array(ffExports.memory.buffer, chunkPtr, got)
  const L = new Float32Array(n)
  const R = ch > 1 ? new Float32Array(n) : null
  for (let i = 0; i < n; i++) {
    L[i] = view[i * ch]
    if (R) R[i] = view[i * ch + 1]
  }
  let endSec = (SESSION.posFrames + n) / SESSION.rate
  if (F('ff_tell')) {
    const t = F('ff_tell')()
    if (t >= -0.5) endSec = t
  }
  SESSION.posFrames += n
  return { n, L, R, startSec: endSec - n / SESSION.rate, endSec }
}

/** 从 targetSec 解出最多 maxSec 秒（末尾不足则少给）。 */
function decodeWindow(chunkPtr, targetSec, maxSec) {
  if (!SESSION.opened) sessionOpen()
  const rate = SESSION.rate
  const need = Math.max(1, Math.round(maxSec * rate))

  let cur = currentSec()
  // 目标在当前解码位置之前：重开（除非只差一点点，容忍 250ms）
  if (cur > targetSec + 0.25) {
    sessionOpen()
    cur = 0
  }
  // 远距离向前：有 ff_seek/ff_tell 就跳，没有就顺序解码丢弃
  if (targetSec - cur > 0.25) {
    if (F('ff_seek') && F('ff_tell')) {
      const to = Math.max(0, targetSec - 1.5)
      if (F('ff_seek')(to) === 0) {
        SESSION.posFrames = Math.round(to * rate)
        cur = to
      } else {
        sessionOpen()
        cur = 0
      }
    }
  }

  const outL = new Float32Array(need)
  const outR = SESSION.channels > 1 ? new Float32Array(need) : null
  let collected = 0
  let skipUntil = targetSec

  for (;;) {
    if (collected >= need) break
    const remaining = need - collected
    let want = remaining
    if (collected === 0 && skipUntil > cur) {
      // 先只拉到目标附近，避免越过窗口起点太多
      want = Math.min(remaining, Math.max(1, Math.ceil((skipUntil - cur) * rate)))
    }
    const p = pullChunk(chunkPtr, want)
    if (!p.n) break

    let offset = 0
    if (collected === 0 && p.startSec < skipUntil) {
      const skipFrames = Math.min(p.n, Math.max(0, Math.round((skipUntil - p.startSec) * rate)))
      if (skipFrames >= p.n) {
        cur = p.endSec
        continue
      }
      offset = skipFrames
    }
    const take = Math.min(p.n - offset, remaining)
    outL.set(p.L.subarray(offset, offset + take), collected)
    if (outR) outR.set(p.R.subarray(offset, offset + take), collected)
    collected += take
    cur = p.startSec + (offset + take) / rate
    if (take < p.n - offset) break   // 窗口已够（正常不会发生：want 已按 remaining 限制）
  }

  return {
    L: outL.subarray(0, collected),
    R: outR ? outR.subarray(0, collected) : null,
    frames: collected,
  }
}

function doPreview(msg) {
  if (!SESSION.token || msg.token !== SESSION.token || !SESSION.opened) {
    return postOut({ type: 'error', message: '这首歌的数据丢了，回到首页重新选一次' })
  }
  const t0 = Date.now()
  const rate = SESSION.rate
  const maxSec = Math.max(0.1, msg.maxSec || 10)
  const targetSec = Math.max(0, msg.startSec || 0)
  const semitones = msg.semitones | 0

  const chunkPtr = F('malloc')(PULL_FRAMES * 2 * 4)
  if (!chunkPtr) throw new Error(FF_ERR_MSG[1])
  let win
  try {
    win = decodeWindow(chunkPtr, targetSec, maxSec)
  } finally {
    F('free')(chunkPtr)
  }
  if (!win.frames) throw new Error('这个位置没有声音了')

  let outL = win.L
  let outR = win.R || win.L
  if (semitones !== 0) {
    const ratio = Math.pow(2, semitones / 12)
    const ws = dsp.makeWsola(rate)
    outL = ws.stretch(dsp.resample(win.L, ratio), ratio)
    outR = win.R ? ws.stretch(dsp.resample(win.R, ratio), ratio) : outL
  }

  const resultBuffer = interleave(outL, outR).buffer
  postOut({
    type: 'done',
    result: resultBuffer,
    ext: 'pcm',
    outLength: outL.length,
    sampleRate: rate,
    channels: 2,
    semitones,
    elapsedMs: Date.now() - t0,
  }, [resultBuffer])
}

// ============ 解码自检：确认这首歌真的能解出声音 ============
// analyze 只探测文件头 —— 解不出声音要到试听/处理时才暴露。进选调页之前先在这里实解一遍：
//   开头要解得出、要有声音；结尾要真的解得出来（文件被截断、容器时长标错都在这里暴露）
// 通过后主线程才放出「下一步」，坏文件在付费之前就被挡住。

const PROBE_HEAD_SEC = 2          // 开头解 2 秒
const PROBE_TAIL_SEC = 1          // 结尾解 1 秒
const PROBE_SILENCE = 1 / 32768   // 16 位量化下的最小非零值：比它还小就是纯数字静音

/** 从 sec 起解最多 maxSec 秒，返回 {frames, peak}；解码出错时 frames=0 并带 error */
function probeDecode(chunkPtr, sec, maxSec) {
  let win
  try {
    win = decodeWindow(chunkPtr, sec, maxSec)
  } catch (err) {
    return { frames: 0, peak: 0, error: String((err && err.message) || err) }
  }
  let peak = 0
  for (let i = 0; i < win.frames; i++) {
    const a = Math.abs(win.L[i])
    if (a > peak) peak = a
  }
  return { frames: win.frames, peak }
}

/** sec 处是不是真的有声音：解 0.6 秒，至少要解出 0.3 秒 */
function hasAudioAt(chunkPtr, sec) {
  return probeDecode(chunkPtr, sec, 0.6).frames >= 0.3 * SESSION.rate
}

/** 声明的结尾解不出东西：二分往前找真正能解到的最后位置（精度 0.5 秒） */
function findRealEnd(chunkPtr, declaredSec) {
  let good = 0
  let bad = declaredSec
  while (bad - good > 0.5) {
    const mid = (good + bad) / 2
    if (hasAudioAt(chunkPtr, mid)) good = mid
    else bad = mid
  }
  return bad   // 第一个「没有声音」的位置 ≈ 真实结尾
}

function doProbe(msg) {
  if (!SESSION.token || msg.token !== SESSION.token || !SESSION.opened) {
    return postOut({ type: 'probe_result', token: msg.token, ok: false, message: '这首歌的数据丢了，回到首页重新选一次' })
  }
  const chunkPtr = F('malloc')(PULL_FRAMES * 2 * 4)
  if (!chunkPtr) return postOut({ type: 'probe_result', token: msg.token, ok: false, message: FF_ERR_MSG[1] })
  try {
    // 1) 开头：要解得出、要有声音
    sessionOpen()
    const head = probeDecode(chunkPtr, 0, PROBE_HEAD_SEC)
    if (head.frames <= 0) {
      return postOut({
        type: 'probe_result', token: msg.token, ok: false,
        message: head.error || '这个文件解不出声音，可能已经损坏',
      })
    }
    let peak = head.peak
    // 开头正好是数字静音（前奏留白）且歌够长：去中间再听一次
    if (peak <= PROBE_SILENCE && SESSION.durationSec > PROBE_HEAD_SEC * 4) {
      peak = Math.max(peak, probeDecode(chunkPtr, SESSION.durationSec / 2, PROBE_HEAD_SEC).peak)
    }
    if (peak <= PROBE_SILENCE) {
      return postOut({ type: 'probe_result', token: msg.token, ok: false, message: '这个文件里没有解出声音' })
    }

    // 2) 结尾：声明的时长处要真的有数据。没有就往前找真实结尾，时长以实测为准
    let durationSec = SESSION.durationSec
    let ok = true
    if (durationSec > PROBE_HEAD_SEC + PROBE_TAIL_SEC + 1) {
      const tail = probeDecode(chunkPtr, durationSec - PROBE_TAIL_SEC, PROBE_TAIL_SEC)
      if (tail.frames < PROBE_TAIL_SEC * SESSION.rate * 0.5) {
        durationSec = findRealEnd(chunkPtr, durationSec)
        ok = durationSec > PROBE_HEAD_SEC
      }
    }
    postOut({
      type: 'probe_result',
      token: msg.token,
      ok,
      message: ok ? '' : '这个文件不完整，只有开头一点声音，重新来一次试试',
      durationSec,
      sampleRate: SESSION.rate,
      channels: SESSION.channels,
      peak,
    })
  } finally {
    try { F('free')(chunkPtr) } catch (e) { /* */ }
    sessionOpen()   // 回到开头，不影响后面的试听/处理
  }
}

// ============ 全曲流式处理 ============

const ACK_WINDOW_BYTES = 4 * 1024 * 1024
let outstandingBytes = 0
let ackWaiters = []

function onAck(msg) {
  outstandingBytes = Math.max(0, outstandingBytes - (msg.bytes | 0))
  if (ackWaiters.length && outstandingBytes <= ACK_WINDOW_BYTES) {
    const ws = ackWaiters; ackWaiters = []
    for (let i = 0; i < ws.length; i++) ws[i]()
  }
}

function waitAck() {
  if (outstandingBytes <= ACK_WINDOW_BYTES) return Promise.resolve()
  return new Promise(resolve => ackWaiters.push(resolve))
}

function sleep0() {
  return new Promise(resolve => setTimeout(resolve, 0))
}

async function doProcess(msg) {
  if (!SESSION.token || msg.token !== SESSION.token) {
    throw new Error('这首歌的数据丢了，回到首页重新选一次')
  }
  if (msg.encode && msg.encode !== 'mp3') {
    throw new Error('长音频只支持 mp3 输出')
  }
  const t0 = Date.now()
  sessionOpen()
  const rate = SESSION.rate
  const ch = SESSION.channels
  const mono = ch < 2
  const semitones = msg.semitones | 0
  if (dsp.MP3_RATES.indexOf(rate) < 0) {
    throw new Error('这个采样率暂时不支持，换一首试试')
  }
  const kbps = dsp.clampKbps(rate, msg.kbps || 160)
  const totalFrames = SESSION.durationSec > 0 ? Math.round(SESSION.durationSec * rate) : 0
  outstandingBytes = 0
  ackWaiters = []

  postOut({
    type: 'meta',
    durationSec: SESSION.durationSec,
    sampleRate: rate,
    channels: ch,
    kbps,
    totalFrames,
  })

  const chunkPtr = F('malloc')(PULL_FRAMES * 2 * 4)
  if (!chunkPtr) throw new Error(FF_ERR_MSG[1])

  let pulled = 0
  let outFrames = 0
  let lastPercent = -1
  let block = 0
  let mp3 = null
  let pitch = null

  function emitChunk(u8) {
    const buf = u8.buffer
    outstandingBytes += u8.byteLength
    postOut({ type: 'chunk', data: buf, bytes: u8.byteLength }, [buf])
  }

  try {
    // 输出保持旧的立体声行为（单声道源也编成双声道），不改变短歌成品格式
    mp3 = dsp.createMp3Stream(rate, kbps, 2)
    pitch = dsp.createPitchStream(rate, semitones, ch)
    if (!pullL) {
      pullL = new Float32Array(PULL_FRAMES)
      pullR = new Float32Array(PULL_FRAMES)
    }

    for (;;) {
      const got = F('ff_pull')(chunkPtr, PULL_FRAMES * ch)
      if (got < 0) throw new Error(FF_ERR_MSG[F('ff_err')()] || '解码中断了')
      if (got === 0) break
      const frames = got / ch
      pulled += frames

      const view = new Float32Array(ffExports.memory.buffer, chunkPtr, got)
      for (let i = 0; i < frames; i++) {
        pullL[i] = view[i * ch]
        if (!mono) pullR[i] = view[i * ch + 1]
      }
      const L = frames === PULL_FRAMES ? pullL : pullL.subarray(0, frames)
      const R = mono ? null : (frames === PULL_FRAMES ? pullR : pullR.subarray(0, frames))

      const out = pitch.push(L, R)
      if (out.L.length) {
        const l16 = dsp.f32ToI16(out.L)
        const r16 = mono ? l16 : dsp.f32ToI16(out.R)
        outFrames += l16.length
        mp3.push(l16, r16, emitChunk)
      }

      const percent = totalFrames > 0
        ? Math.min(99, Math.floor((pulled / totalFrames) * 100))
        : -1
      if (percent !== lastPercent) {
        lastPercent = percent
        postOut({ type: 'progress', percent, frames: pulled, totalFrames })
      }

      block++
      if (block % 8 === 0) await sleep0()
      if (outstandingBytes > ACK_WINDOW_BYTES) await waitAck()
    }

    const tail = pitch.flush()
    if (tail.L.length) {
      const l16 = dsp.f32ToI16(tail.L)
      const r16 = mono ? l16 : dsp.f32ToI16(tail.R)
      outFrames += l16.length
      mp3.push(l16, r16, emitChunk)
    }
    mp3.flush(emitChunk)

    postOut({
      type: 'progress',
      percent: 100,
      frames: pulled,
      totalFrames: totalFrames || pulled,
    })
    postOut({
      type: 'done',
      outLength: outFrames,
      sampleRate: rate,
      channels: 2,
      ext: 'mp3',
      kbps,
      bytes: mp3.bytes,
      durationSec: outFrames / rate,
      elapsedMs: Date.now() - t0,
    })
  } finally {
    try { F('free')(chunkPtr) } catch (e) { /* */ }
  }
}

// ============ 消息入口 ============

worker.onMessage(function (msg) {
  if (msg.type === 'ping') return postOut({ type: 'pong' })

  if (msg.type === 'ack') {
    onAck(msg)
    return
  }

  if (msg.type === 'store_has') {
    return postOut({
      type: 'store_has_result',
      value: !!SESSION.token && SESSION.token === msg.token && SESSION.opened,
    })
  }

  if (msg.type === 'analyze_begin') {
    doAnalyzeBegin(msg).catch(err => {
      postOut({ type: 'analyze_error', message: String((err && err.message) || err) })
    })
    return
  }

  if (msg.type === 'analyze_chunk') {
    try {
      doAnalyzeChunk(msg)
    } catch (err) {
      sessionFree()
      postOut({ type: 'analyze_error', message: String((err && err.message) || err) })
    }
    return
  }

  if (msg.type === 'analyze_end') {
    try {
      doAnalyzeEnd(msg)
    } catch (err) {
      sessionFree()
      postOut({ type: 'analyze_error', message: String((err && err.message) || err) })
    }
    return
  }

  if (msg.type === 'preview') {
    try {
      doPreview(msg)
    } catch (err) {
      postOut({ type: 'error', message: String((err && err.message) || err) })
    }
    return
  }

  if (msg.type === 'probe') {
    try {
      doProbe(msg)
    } catch (err) {
      postOut({ type: 'probe_result', token: msg.token, ok: false, message: String((err && err.message) || err) })
    }
    return
  }

  if (msg.type === 'process') {
    doProcess(msg).catch(err => {
      postOut({ type: 'error', message: String((err && err.message) || err) })
    })
    return
  }
})
