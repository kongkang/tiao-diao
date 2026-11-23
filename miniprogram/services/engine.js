// 处理引擎：解码会话常驻 Worker，主线程只传指令、分块上传输入、分块落盘输出
//
// 协议（与 workers/pitch.js 对应）：
//   analyzeFile(path,size) / analyze(buffer)
//     → analyze_begin / analyze_chunk(×N) / analyze_end
//     ← analyzed {token,frames,sampleRate,channels,durationSec}
//   storeHas(token)           解码会话是否还在（Worker 被杀后自检）
//   preview({...})            试听：只解码 10 秒窗口，回交错 PCM
//   process({...})            全曲：流式变调+MP3，分块回传，主线程 appendFile
//
// Worker 规则（官方限制）：全局只能有 1 个；内部没有 wx API；
// iOS 用实验 Worker（快数倍），onProcessKilled 时会话随之丢失 → storeHas 自检。

const config = require('../config.js')

const ANALYZE_CHUNK = 4 * 1024 * 1024   // 分块上传：主线程峰值约 2 块
const MAX_OUTPUT_BYTES = (config.MAX_OUTPUT_MB || 95) * 1024 * 1024

let worker = null
let current = null // { resolve,reject,kind,waiters,onProgress,onChunk,onMeta,appendChain,... }
let tokenSeq = 0
let transferOk = true // 部分机型/实验 Worker 不支持 transferList，失败后自动降级为拷贝
let suppressKill = false // 主动 terminate 时不把 onProcessKilled 当成内存不足

/** 主线程 → Worker 安全发送：transfer 优先，不支持就结构化克隆 */
function postToWorker(w, msg, transfer) {
  if (transfer && transfer.length && transferOk) {
    try { w.postMessage(msg, transfer); return } catch (e) { transferOk = false }
  }
  w.postMessage(msg)
}

function terminateWorker() {
  if (worker) {
    suppressKill = true
    try { worker.terminate() } catch (e) { /* */ }
    worker = null
    suppressKill = false
  }
}

function ensureWorker() {
  if (worker) return worker
  const w = wx.createWorker('workers/pitch.js', { useExperimentalWorker: true })
  worker = w
  w.onMessage(msg => {
    if (worker === w) onMessage(msg)   // 旧 Worker 的迟到消息不打扰新请求
  })
  if (w.onProcessKilled) {
    w.onProcessKilled(() => {
      // 主动终止 / 旧 Worker 的迟到回调不能影响新 Worker
      if (suppressKill || worker !== w) return
      worker = null   // 解码会话随进程一起没了，后续 storeHas 会发现并重新上传
      if (current) settle(new Error('系统内存不足，处理被中断了。请重新点一次'))
    })
  }
  return w
}

function newToken() {
  return 't' + Date.now() + '-' + (++tokenSeq)
}

function touch() {
  if (!current) return
  clearTimeout(current.timer)
  current.timer = setTimeout(() => {
    if (!current) return
    settle(new Error('处理超时了，可能是文件太大或手机性能不足'))
  }, current.idleMs)
}

function startRequest(kind, idleMs, handlers) {
  if (current) return null
  ensureWorker()
  let resolveOuter
  let rejectOuter
  const promise = new Promise((res, rej) => { resolveOuter = res; rejectOuter = rej })
  current = {
    kind,
    resolve: resolveOuter,
    reject: rejectOuter,
    waiters: [],
    appendChain: Promise.resolve(),
    appendError: null,
    bytesOut: 0,
    onProgress: handlers && handlers.onProgress,
    onChunk: handlers && handlers.onChunk,
    onMeta: handlers && handlers.onMeta,
    idleMs: idleMs || 180000,
    timer: null,
  }
  touch()
  return { promise, token: newToken() }
}

function settle(err, val) {
  if (!current) return
  const c = current
  current = null
  clearTimeout(c.timer)
  for (let i = 0; i < c.waiters.length; i++) {
    const w = c.waiters[i]
    if (err) w.reject(err)
    else w.reject(new Error('请求已结束'))
  }
  c.waiters.length = 0
  err ? c.reject(err) : c.resolve(val)
}

/** 等 Worker 的某条消息（analyze 分步骤用） */
function waitFor(type) {
  if (!current) return Promise.reject(new Error('请求已结束'))
  return new Promise((resolve, reject) => {
    current.waiters.push({ type, resolve, reject })
  })
}

function resolveWaiter(type, val) {
  if (!current) return false
  for (let i = 0; i < current.waiters.length; i++) {
    if (current.waiters[i].type === type) {
      const w = current.waiters.splice(i, 1)[0]
      w.resolve(val)
      return true
    }
  }
  return false
}

function appendAndAck(data) {
  if (!current) return
  const c = current
  c.bytesOut += data.byteLength
  if (c.bytesOut > MAX_OUTPUT_BYTES) {
    terminateWorker()
    settle(new Error('转出来的文件超过微信单文件 100MB 上限，这首歌太长了'))
    return
  }
  c.appendChain = c.appendChain.then(() => {
    if (!c.onChunk) return null
    return c.onChunk(data)
  }).then(() => {
    if (worker) postToWorker(worker, { type: 'ack', bytes: data.byteLength })
  }).catch(err => {
    c.appendError = err
    terminateWorker()
    settle(err)
  })
}

function onMessage(msg) {
  if (!current) return
  const c = current

  if (msg.type === 'progress') {
    touch()
    c.onProgress && c.onProgress(msg.percent, msg)
    return
  }
  if (msg.type === 'meta') {
    touch()
    c.onMeta && c.onMeta(msg)
    return
  }
  if (msg.type === 'chunk') {
    touch()
    appendAndAck(msg.data)
    return
  }
  if (msg.type === 'analyze_ready') {
    touch()
    resolveWaiter('ready', msg)
    return
  }
  if (msg.type === 'analyze_chunk_ack') {
    touch()
    resolveWaiter('ack', msg)
    return
  }
  if (msg.type === 'analyzed') {
    touch()
    resolveWaiter('analyzed', msg)
    return
  }
  if (msg.type === 'store_has_result') {
    return settle(null, msg.value)
  }
  if (msg.type === 'done') {
    if (c.kind === 'preview') {
      return settle(null, {
        data: msg.result,
        ext: msg.ext,
        durationSec: msg.outLength / msg.sampleRate,
        elapsedMs: msg.elapsedMs,
      })
    }
    // 全曲：等所有分块落盘完成再 resolve
    touch()
    c.appendChain.then(() => {
      if (c.appendError) return settle(c.appendError)
      settle(null, {
        ext: msg.ext || 'mp3',
        durationSec: msg.durationSec || msg.outLength / msg.sampleRate,
        outLength: msg.outLength,
        sampleRate: msg.sampleRate,
        channels: msg.channels,
        kbps: msg.kbps,
        bytes: msg.bytes,
        elapsedMs: msg.elapsedMs,
      })
    })
    return
  }
  if (msg.type === 'analyze_error' || msg.type === 'error') {
    settle(new Error(msg.message || '处理失败'))
  }
}

/** 读文件的一段（readFile 支持 position/length，2.10.0+） */
function readFileSlice(path, position, length) {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath: path,
      position,
      length,
      success: res => resolve(res.data),
      fail: err => reject(new Error('读取文件失败，可能文件已被清理；重新选一次试试（' + (err.errMsg || '') + '）')),
    })
  })
}

/**
 * 分块上传 + 探测元数据。主线程不持有整文件 ArrayBuffer。
 * @param {string} path 本地文件路径
 * @param {number} size 文件字节数
 * @returns {Promise<{token,frames,sampleRate,channels,durationSec}>}
 */
function analyzeFile(path, size) {
  if (current) return Promise.reject(new Error('正在处理中，请稍等'))
  if (!size || size <= 0) return Promise.reject(new Error('文件是空的'))
  terminateWorker()   // 新歌：重置 wasm 堆高水位，避免上一首大文件常驻
  const req = startRequest('analyze', 120000)
  if (!req) return Promise.reject(new Error('正在处理中，请稍等'))
  const token = req.token

  ;(async () => {
    try {
      postToWorker(worker, { type: 'analyze_begin', token, totalBytes: size })
      await waitFor('ready')

      for (let off = 0; off < size; off += ANALYZE_CHUNK) {
        const len = Math.min(ANALYZE_CHUNK, size - off)
        const raw = await readFileSlice(path, off, len)
        if (!raw || raw.byteLength !== len) {
          throw new Error('读取文件不完整，可能文件已被清理；重新选一次试试')
        }
        // 复制成普通 JS ArrayBuffer：模拟器里 readFile 返回的 buffer 直接 transfer 给
        // 实验 Worker 会挂死（无报错无超时），复制一次可规避；真机代价也只有 4MB。
        const data = new Uint8Array(raw).slice().buffer
        postToWorker(worker, { type: 'analyze_chunk', token, offset: off, data }, [data])
        await waitFor('ack')
      }

      postToWorker(worker, { type: 'analyze_end', token })
      const meta = await waitFor('analyzed')
      if (meta.token !== token) throw new Error('解码结果对不上，请重试')
      settle(null, meta)
    } catch (e) {
      terminateWorker()
      settle(e)
    }
  })()

  return req.promise
}

/**
 * 兼容自动化注入：内存里的 ArrayBuffer 也走同一套分块上传协议。
 * @param {ArrayBuffer} data
 */
function analyze(data) {
  if (data && !(data instanceof ArrayBuffer) && data.buffer) {
    data = data.buffer.slice(data.byteOffset || 0, (data.byteOffset || 0) + data.byteLength)
  }
  if (current) return Promise.reject(new Error('正在处理中，请稍等'))
  if (!data || !data.byteLength) return Promise.reject(new Error('文件是空的'))
  terminateWorker()   // 新歌：重置 wasm 堆高水位
  const req = startRequest('analyze', 120000)
  if (!req) return Promise.reject(new Error('正在处理中，请稍等'))
  const token = req.token
  const size = data.byteLength

  ;(async () => {
    try {
      postToWorker(worker, { type: 'analyze_begin', token, totalBytes: size })
      await waitFor('ready')
      for (let off = 0; off < size; off += ANALYZE_CHUNK) {
        const len = Math.min(ANALYZE_CHUNK, size - off)
        const part = data.slice(off, off + len)   // 拷贝，不破坏调用方的 buffer
        postToWorker(worker, { type: 'analyze_chunk', token, offset: off, data: part }, [part])
        await waitFor('ack')
      }
      postToWorker(worker, { type: 'analyze_end', token })
      const meta = await waitFor('analyzed')
      if (meta.token !== token) throw new Error('解码结果对不上，请重试')
      settle(null, meta)
    } catch (e) {
      terminateWorker()
      settle(e)
    }
  })()

  return req.promise
}

/** 解码会话是否还在（Worker 进程被杀后为 false，需要重新 analyze） */
function storeHas(token) {
  return new Promise((resolve, reject) => {
    if (current) return reject(new Error('正在处理中，请稍等'))
    if (!worker) return resolve(false)   // 进程都没了，没必要再造一个空 Worker
    const req = startRequest('store_has', 20000)
    if (!req) return reject(new Error('正在处理中，请稍等'))
    // startRequest 的 promise 由 settle 解出；这里直接复用
    req.promise.then(resolve, reject)
    postToWorker(worker, { type: 'store_has', token })
  })
}

/**
 * 试听：从 startSec 起 maxSec 秒做变调，回交错 Float32 PCM（立体声）
 * @returns {Promise<{data, ext:'pcm', durationSec, elapsedMs}>}
 */
function preview(opts) {
  if (current) return Promise.reject(new Error('正在处理中，请稍等'))
  const req = startRequest('preview', 120000)
  if (!req) return Promise.reject(new Error('正在处理中，请稍等'))
  postToWorker(worker, {
    type: 'preview',
    token: opts.token,
    semitones: opts.semitones,
    startSec: opts.startSec || 0,
    maxSec: opts.maxSec || config.PREVIEW_SEC,
  })
  return req.promise
}

/**
 * 全曲处理：流式变调 + MP3，分块落盘
 * @param {Object} opts { token, semitones, kbps, onProgress(percent), onChunk(ArrayBuffer), onMeta(meta) }
 * @returns {Promise<{ext,durationSec,outLength,sampleRate,channels,kbps,bytes,elapsedMs}>}
 */
function process(opts) {
  if (current) return Promise.reject(new Error('正在处理中，请稍等'))
  if ((opts.encode || config.ENCODE) !== 'mp3') {
    return Promise.reject(new Error('长音频只支持 mp3 输出'))
  }
  const req = startRequest('process', 180000, {
    onProgress: opts.onProgress,
    onChunk: opts.onChunk,
    onMeta: opts.onMeta,
  })
  if (!req) return Promise.reject(new Error('正在处理中，请稍等'))
  postToWorker(worker, {
    type: 'process',
    token: opts.token,
    semitones: opts.semitones,
    kbps: opts.kbps || config.MP3_KBPS,
    encode: 'mp3',
  })
  return req.promise
}

/** 用户中途退出时终止 Worker（解码会话一并释放） */
function abort() {
  terminateWorker()
  if (current) settle(new Error('已取消'))
}

module.exports = { analyze, analyzeFile, storeHas, preview, process, abort }
