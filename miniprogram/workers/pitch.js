/**
 * Worker · 音频引擎 v3（PCM 常驻 + 统一 wasm 解码 + 变调 + 编码）
 *
 * 架构（内存优先设计，真机 OOM 重构后）：
 *   - 解码：文件字节（几 MB）进来，FFmpeg WASM 拉取式解码（ff_open/ff_pull/ff_close），
 *     wasm 堆体积有界（≈输入文件大小），PCM 累积到 JS 堆的 Int16 存储（体积减半）
 *   - 常驻：PCM 只存在 Worker 里（STORE），主线程只拿元数据 —— 大数组不再跨线程拷贝
 *     （不支持 transfer 的机型上一次拷贝就是一份全量 PCM，来回四趟是真机被杀的主因）
 *   - 处理：试听=切片变调回传交错 PCM（15s 小包）；全曲=变调+编码（mp3/wav）回传一个结果包
 *
 * 协议（与 services/engine.js 对应）：
 *   → {type:'analyze', data:ArrayBuffer, token}      解码文件并常驻
 *   ← {type:'analyzed', token, frames, sampleRate, channels}
 *   ← {type:'analyze_error', message}
 *   → {type:'pitch', token, semitones, encode, kbps, slice?}
 *     slice={from,to}（帧范围，试听用；省略=全曲）
 *   ← progress / done{result, ext, outLength, sampleRate} / error
 *   → {type:'store_has', token}  ← {type:'store_has_result', value}
 */

// ============ 工具 ============

function f32ToI16(f32) {
  const out = new Int16Array(f32.length)
  for (let i = 0; i < f32.length; i++) {
    let s = f32[i]
    if (s > 1) s = 1
    else if (s < -1) s = -1
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return out
}

function i16ToF32(i16) {
  const out = new Float32Array(i16.length)
  for (let i = 0; i < i16.length; i++) out[i] = i16[i] / 0x8000
  return out
}

// ============ 变调算法（重采样 + WSOLA，验证过勿动本体） ============

function resample(input, ratio) {
  if (Math.abs(ratio - 1) < 1e-9) return input
  const newLen = Math.max(1, Math.floor(input.length / ratio))
  const out = new Float32Array(newLen)
  for (let i = 0; i < newLen; i++) {
    const src = i * ratio
    const i0 = Math.floor(src)
    const frac = src - i0
    const a = input[i0]
    const b = i0 + 1 < input.length ? input[i0 + 1] : a
    out[i] = a + (b - a) * frac
  }
  return out
}

// 参数以毫秒定义，与 SoundTouch 默认一致：sequence 40ms / seekwindow 15ms / overlap 8ms
function makeWsola(sampleRate) {
  const SEQ = Math.round(sampleRate * 0.040)
  const SEEK = Math.round(sampleRate * 0.015)
  const OVL = Math.round(sampleRate * 0.008)

  const win = new Float32Array(OVL)
  for (let i = 0; i < OVL; i++) win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (OVL - 1)))

  /**
   * 时间拉伸：factor = 输出时长/输入时长。
   * 名义位置按 step=(SEQ-OVL)/factor 严格推进（偏移零均值不漂移，时长守得住）；
   * 输出预分配 + 块重叠写入（真 overlap-add），峰值内存只有块数组方案的一半。
   */
  function stretch(input, factor) {
    if (Math.abs(factor - 1) < 1e-9) return input
    const est = Math.ceil(input.length * factor) + 2 * SEQ
    const result = new Float32Array(est)
    let w = 0

    const first = input.subarray(0, Math.min(SEQ, input.length))
    result.set(first, w)
    w += first.length

    let prevEnd = first
    const tplStart = SEQ - OVL
    const halfSeek = Math.floor(SEEK / 2)
    const step = Math.max(1, Math.round((SEQ - OVL) / factor))
    let nominal = 0
    const blended = new Float32Array(SEQ)  // 复用缓冲（读 prevEnd 尾部在前，覆写在后，区域不重叠）

    while (nominal + step + halfSeek + SEQ + OVL < input.length) {
      nominal += step
      const base = nominal - halfSeek
      let bestOffset = 0
      let bestCorr = -Infinity
      for (let s = 0; s < SEEK; s++) {
        let corr = 0
        const b = base + s
        for (let i = 0; i < OVL; i += 2) {
          corr += prevEnd[tplStart + i] * input[b + i]
        }
        if (corr > bestCorr) { bestCorr = corr; bestOffset = s }
      }

      const block = input.subarray(base + bestOffset, base + bestOffset + SEQ)
      for (let i = 0; i < OVL; i++) {
        const wgt = win[i]
        blended[i] = prevEnd[tplStart + i] * (1 - wgt) + block[i] * wgt
      }
      for (let i = OVL; i < SEQ; i++) blended[i] = block[i]

      if (w + SEQ > result.length) break
      result.set(blended, w)
      w += SEQ - OVL
      prevEnd = blended
    }
    return result.subarray(0, w)
  }

  return { stretch }
}

// ============ 编码 ============

function wavFromI16(l16, r16, sampleRate) {
  const frames = Math.min(l16.length, r16.length)
  const dataBytes = frames * 4
  const buf = new ArrayBuffer(44 + dataBytes)
  const dv = new DataView(buf)
  let p = 0
  function str(s) { for (let i = 0; i < s.length; i++) dv.setUint8(p++, s.charCodeAt(i)) }
  function u32(v) { dv.setUint32(p, v, true); p += 4 }
  function u16(v) { dv.setUint16(p, v, true); p += 2 }
  str('RIFF'); u32(36 + dataBytes); str('WAVE')
  str('fmt '); u32(16); u16(1); u16(2)
  u32(sampleRate); u32(sampleRate * 4); u16(4); u16(16)
  str('data'); u32(dataBytes)
  const out = new Int16Array(buf, 44)
  for (let i = 0; i < frames; i++) {
    out[i * 2] = l16[i]
    out[i * 2 + 1] = r16[i]
  }
  return buf
}

function encodeMp3I16(l16, r16, sampleRate, kbps, onProgress) {
  const lamejs = require('./libs/lamejs.js')
  const enc = new lamejs.Mp3Encoder(2, sampleRate, kbps)
  const blockSize = 1152 * 32   // 大块少循环，编码占比小
  const out = []

  const len = Math.min(l16.length, r16.length)
  let done = 0
  for (let i = 0; i < len; i += blockSize) {
    const buf = enc.encodeBuffer(l16.subarray(i, Math.min(i + blockSize, len)), r16.subarray(i, Math.min(i + blockSize, len)))
    if (buf.length > 0) out.push(new Uint8Array(buf))
    done = i + blockSize
    if (onProgress && (i / blockSize) % 8 === 0) onProgress(done / len)
  }
  const end = enc.flush()
  if (end.length > 0) out.push(new Uint8Array(end))

  let total = 0
  for (const c of out) total += c.length
  const mp3 = new Uint8Array(total)
  let w = 0
  for (const c of out) { mp3.set(c, w); w += c.length }
  return mp3
}

// 立体声交错 Float32（试听回传用）
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

// ============ 常驻存储（单槽：当前这首歌，Int16 省一半内存） ============

const STORE = {
  token: null,
  i16L: null,
  i16R: null,     // 单声道时为 null
  frames: 0,
  sampleRate: 0,
  channels: 1,
}

function storeFree() {
  STORE.token = null
  STORE.i16L = null
  STORE.i16R = null
  STORE.frames = 0
}

// ============ 解码：文件字节 → Int16 PCM 常驻 ============

async function doAnalyze(msg) {
  const ff = await loadFf()
  const F = (n) => ffExports[n] || ffExports['_' + n]

  const bytes = new Uint8Array(msg.data)
  const inPtr = F('malloc')(bytes.length)
  let opened = false
  let chunkPtr = 0
  try {
    new Uint8Array(ff.memory.buffer).set(bytes, inPtr)
    if (F('ff_open')(inPtr, bytes.length) < 0) {
      throw new Error(FF_ERR_MSG[F('ff_err')()] || '这个文件解不开')
    }
    opened = true

    const PULL_FLOATS = 65536   // 每次拉 65536 个交错样本（256KB）
    chunkPtr = F('malloc')(PULL_FLOATS * 4)

    const rate = F('ff_rate')() || 44100
    const ch = Math.min(2, F('ff_channels')() || 1)
    const durSec = F('ff_duration_sec')()

    // 按容器声明时长预分配（×1.1 余量）；拿不到就按 2 分钟起步动态翻倍
    let cap = durSec > 0 ? Math.ceil(durSec * rate * ch * 1.1) + rate : rate * ch * 120
    let accL = new Int16Array(cap)
    let accR = ch > 1 ? new Int16Array(cap) : null   // 右声道（交错转分声道）
    let n = 0   // 已写入的帧数

    for (;;) {
      const got = F('ff_pull')(chunkPtr, PULL_FLOATS)
      if (got <= 0) break
      const frames = got / ch
      if (n + frames > cap) {
        // 预分配不足（容器时长低估）：倍增扩容
        while (cap < n + frames) cap *= 2
        const gL = new Int16Array(cap)
        gL.set(accL.subarray(0, n))
        accL = gL
        if (ch > 1) {
          const gR = new Int16Array(cap)
          gR.set(accR.subarray(0, n))
          accR = gR
        }
      }
      // 拷出本块（memory 可能增长过，view 每次新建）
      const chunk = new Float32Array(ff.memory.buffer, chunkPtr, got)
      for (let i = 0; i < frames; i++) {
        accL[n] = chunk[i * ch] > 1 ? 32767 : (chunk[i * ch] < -1 ? -32768 : Math.round(chunk[i * ch] * 32767))
        if (ch > 1) {
          const r = chunk[i * ch + 1]
          accR[n] = r > 1 ? 32767 : (r < -1 ? -32768 : Math.round(r * 32767))
        }
        n++
      }
    }

    F('ff_close')()
    opened = false
    F('free')(chunkPtr); chunkPtr = 0

    if (n === 0) throw new Error(FF_ERR_MSG[6])

    STORE.token = msg.token
    STORE.i16L = accL.subarray(0, n)
    STORE.i16R = accR ? accR.subarray(0, n) : null
    STORE.frames = n
    STORE.sampleRate = rate
    STORE.channels = ch

    postOut({
      type: 'analyzed',
      token: msg.token,
      frames: n,
      sampleRate: rate,
      channels: ch,
    })
  } catch (e) {
    if (opened) { try { F('ff_close')() } catch (e2) { /* */ } }
    if (chunkPtr) { try { F('free')(chunkPtr) } catch (e2) { /* */ } }
    storeFree()
    throw e
  } finally {
    // inPtr 的生命周期覆盖 open/pull（avio 要持续读它），这里才真正释放
    try { F('free')(inPtr) } catch (e2) { /* */ }
  }
}

// ============ 变调处理（全曲 or 试听切片） ============

function doPitch(msg) {
  if (STORE.token !== msg.token) {
    return postOut({ type: 'error', message: '这首歌的数据丢了，回到首页重新选一次' })
  }
  const t0 = Date.now()
  const { sampleRate, channels } = STORE
  const semitones = msg.semitones | 0
  const encode = msg.encode || 'mp3'
  const from = msg.slice ? Math.max(0, msg.slice.from | 0) : 0
  const to = msg.slice ? Math.min(STORE.frames, msg.slice.to | 0) : STORE.frames

  const ratio = Math.pow(2, semitones / 12)
  const wsola = makeWsola(sampleRate)

  postOut({ type: 'progress', percent: 2 })

  // 分声道处理，float 中间量用完即弃（int16 常驻不动）
  const srcL = i16ToF32(STORE.i16L.subarray(from, to))
  let outL
  if (semitones === 0) {
    outL = srcL
  } else {
    const rsL = resample(srcL, ratio)
    // srcL 无法置 null（const）—— WSOLA 期间多占一份 float，8 分钟歌约 85MB；
    // M1 换 SoundTouch WASM 流式后消除
    outL = wsola.stretch(rsL, ratio)
  }
  postOut({ type: 'progress', percent: 45 })

  let l16 = null
  if (encode !== 'pcm') { l16 = f32ToI16(outL); outL = null }   // 尽早降位深腾内存

  let outR = null
  if (channels > 1) {
    const srcR = i16ToF32(STORE.i16R.subarray(from, to))
    outR = semitones === 0 ? srcR : wsola.stretch(resample(srcR, ratio), ratio)
  }
  postOut({ type: 'progress', percent: 70 })

  let resultBuffer = null
  let ext = 'pcm'
  if (encode === 'pcm') {
    resultBuffer = interleave(outL, outR || outL).buffer
    ext = 'pcm'
  } else {
    const r16 = outR ? f32ToI16(outR) : l16
    outR = null
    postOut({ type: 'progress', percent: 75 })
    if (encode === 'wav') {
      resultBuffer = wavFromI16(l16, r16, sampleRate)
      ext = 'wav'
    } else {
      resultBuffer = encodeMp3I16(l16, r16, sampleRate, msg.kbps || 160, (p) => {
        postOut({ type: 'progress', percent: 75 + Math.min(20, Math.round(p * 20)) })
      }).buffer
      ext = 'mp3'
    }
  }
  postOut({ type: 'progress', percent: 96 })

  postOut({
    type: 'done',
    result: resultBuffer,
    ext: ext,
    outLength: encode === 'pcm' ? resultBuffer.byteLength / 8 : l16.length,
    sampleRate,
    channels: 2,
    semitones,
    elapsedMs: Date.now() - t0,
  }, [resultBuffer])
}

// ============ 消息入口 ============

worker.onMessage(function (msg) {
  if (msg.type === 'ping') return postOut({ type: 'pong' })

  if (msg.type === 'store_has') {
    return postOut({ type: 'store_has_result', value: STORE.token === msg.token && STORE.frames > 0 })
  }

  if (msg.type === 'analyze') {
    doAnalyze(msg).catch((err) => {
      postOut({ type: 'analyze_error', message: String((err && err.message) || err) })
    })
    return
  }

  if (msg.type === 'pitch') {
    try {
      doPitch(msg)
    } catch (err) {
      postOut({ type: 'error', message: String((err && err.message) || err) })
    }
    return
  }
})
