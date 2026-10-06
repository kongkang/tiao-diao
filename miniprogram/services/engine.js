// 处理引擎：PCM 常驻 Worker，主线程只发指令、收结果
// 协议（与 workers/pitch.js 对应）：
//   analyze(data)                 文件字节 → Worker 解码并常驻，回元数据
//   storeHas(token)               常驻数据是否还在（Worker 被杀后自检）
//   preview({token,...slice})     试听：切片变调，回交错 PCM（小包）
//   process({token,semitones...}) 全曲：变调+编码，回一个结果包（mp3/wav）
// Worker 规则（官方限制）：全局只能有 1 个；内部没有 wx API；
// iOS 用实验 Worker（快数倍），onProcessKilled 时常驻数据随之丢失 → storeHas 自检。

const config = require('../config.js')

let worker = null
let current = null // { resolve, reject, onProgress, timer }
let tokenSeq = 0
let transferOk = true // 部分机型/实验 Worker 不支持 transferList，失败后自动降级为拷贝

/** 主线程 → Worker 安全发送：transfer 优先，不支持就结构化克隆
 *  （真机实测报 "transfer is not supported in this version" 的机型靠它跑通） */
function postToWorker(w, msg, transfer) {
  if (transfer && transfer.length && transferOk) {
    try { w.postMessage(msg, transfer); return } catch (e) { transferOk = false }
  }
  w.postMessage(msg)
}

function ensureWorker() {
  if (worker) return worker
  worker = wx.createWorker('workers/pitch.js', { useExperimentalWorker: true })
  worker.onMessage(onMessage)
  if (worker.onProcessKilled) {
    worker.onProcessKilled(() => {
      worker = null   // 常驻 PCM 随进程一起没了，后续 storeHas 会发现并重新解码
      if (current) {
        clearTimeout(current.timer)
        const c = current; current = null
        c.reject(new Error('系统内存不足，处理被中断了。请重新点一次'))
      }
    })
  }
  return worker
}

function onMessage(msg) {
  if (!current) return
  if (msg.type === 'progress') {
    current.onProgress && current.onProgress(msg.percent)
  } else if (msg.type === 'analyzed') {
    settle(null, { token: msg.token, frames: msg.frames, sampleRate: msg.sampleRate, channels: msg.channels })
  } else if (msg.type === 'store_has_result') {
    settle(null, msg.value)
  } else if (msg.type === 'done') {
    settle(null, {
      data: msg.result,
      ext: msg.ext,               // 'wav' | 'mp3' | 'pcm'
      durationSec: msg.outLength / msg.sampleRate,
      elapsedMs: msg.elapsedMs,
    })
  } else if (msg.type === 'analyze_error' || msg.type === 'error') {
    settle(new Error(msg.message || '处理失败'))
  }
}

function settle(err, val) {
  clearTimeout(current.timer)
  const c = current; current = null
  err ? c.reject(err) : c.resolve(val)
}

function request(payload, transfer, timeoutMs, onProgress) {
  if (current) return Promise.reject(new Error('正在处理中，请稍等'))
  return new Promise((resolve, reject) => {
    const w = ensureWorker()
    current = {
      resolve, reject, onProgress,
      timer: setTimeout(() => {
        const c = current; current = null
        c.reject(new Error('处理超时了，可能是文件太大或手机性能不足'))
      }, timeoutMs || 300000),
    }
    postToWorker(w, payload, transfer)
  })
}

/**
 * 解码文件并常驻 Worker（wma/mp3/m4a/flac/wav 统一走自带 FFmpeg WASM）
 * @param {ArrayBuffer} data 文件原始字节（transfer 后调用方引用失效）
 * @returns {Promise<{token, frames, sampleRate, channels}>}
 */
function analyze(data) {
  const token = 't' + Date.now() + '-' + (++tokenSeq)
  return request({ type: 'analyze', data, token }, [data], 120000).then((meta) => {
    if (meta.token !== token) throw new Error('解码结果对不上，请重试')
    return meta
  })
}

/** 常驻数据是否还在（Worker 进程被杀后为 false，需要重新 analyze） */
function storeHas(token) {
  return request({ type: 'store_has', token }, null, 20000)
}

/**
 * 试听：从 startSec 起 maxSec 秒做变调，回交错 Float32 PCM（立体声）
 * @returns {Promise<{data, ext:'pcm', durationSec, elapsedMs}>}
 */
function preview(opts) {
  const sr = opts.sampleRate
  const from = Math.max(0, Math.floor((opts.startSec || 0) * sr))
  return request({
    type: 'pitch',
    token: opts.token,
    semitones: opts.semitones,
    encode: 'pcm',
    slice: { from, to: from + Math.ceil((opts.maxSec || 15) * sr) },
  }, null, 120000)
}

/**
 * 全曲处理：变调 + 编码
 * @param {Object} opts { token, semitones, encode('mp3'|'wav'), onProgress }
 * @returns {Promise<{data, ext, durationSec, elapsedMs}>}
 */
function process(opts) {
  return request({
    type: 'pitch',
    token: opts.token,
    semitones: opts.semitones,
    encode: opts.encode || config.ENCODE,
    kbps: config.MP3_KBPS,
  }, null, 300000, opts.onProgress)
}

/** 用户中途退出时终止 Worker（常驻数据一并释放） */
function abort() {
  if (worker) {
    try { worker.terminate() } catch (e) { /* */ }
    worker = null
  }
  if (current) {
    clearTimeout(current.timer)
    const c = current; current = null
    c.reject(new Error('已取消'))
  }
}

module.exports = { analyze, storeHas, preview, process, abort }
