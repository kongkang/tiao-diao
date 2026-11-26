// 云函数出网读字节:Range 请求、并行分段读、按时间预算截止。只依赖 Node 内置模块
//
// 预算(deadline)是这里的核心约束:云函数单次调用有硬超时,所有读都必须在
// deadline 之前自己收手 —— 宁可少读一点返回前缀(客户端会续传),也不能被平台掐掉。
//
// 本模块不做域名/私网校验,调用方(index.js)在拿到 URL 后先过 assertFetchable。

'use strict'

const http = require('http')
const https = require('https')
const { URL } = require('url')

// keep-alive 连接池:同一实例的后续分块复用 TLS 连接
const agentKeep = new https.Agent({ keepAlive: true, maxSockets: 12 })
const agentPlain = new http.Agent({ keepAlive: true, maxSockets: 12 })

const SPAN_PARTS = 6                 // 大段并行读最多几路
const MIN_PART_BYTES = 256 * 1024    // 比这还小的段就不拆了

class HttpError extends Error {
  constructor(message, code) {
    super(message)
    this.code = code || 'http'
  }
}

/** Content-Range: bytes 0-1023/5408198 → 5408198(拿不到返回 0) */
function totalFromRange(h) {
  const m = /\/(\d+)\s*$/.exec(String(h || ''))
  return m ? parseInt(m[1], 10) : 0
}

/** 发一个 Range 请求。3xx 抛 code='redirect'(location 带在错误对象上),由调用方决定跟不跟 */
function open(url, headers, start, end, deadline) {
  return new Promise((resolve, reject) => {
    const secure = !url.startsWith('http://')
    const req = (secure ? https : http).get(url, {
      agent: secure ? agentKeep : agentPlain,
      headers: Object.assign({}, headers, { Range: 'bytes=' + start + '-' + (end - 1) }),
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        const err = new HttpError('redirect', 'redirect')
        try { err.location = new URL(res.headers.location, url).toString() } catch (e) { err.location = null }
        return reject(err)
      }
      resolve({ req, res })
    })
    req.on('error', reject)
    if (deadline > 0) {
      const t = setTimeout(() => {
        req.destroy()
        reject(new HttpError('deadline', 'deadline'))
      }, Math.max(0, deadline - Date.now()))
      req.once('close', () => clearTimeout(t))
    }
  })
}

/** 把响应体读到 want 字节 / EOF / 预算截止。无论哪种结束都 resolve,由 complete 说明读没读全 */
function collect(req, res, start, want, deadline) {
  return new Promise((resolve, reject) => {
    const status = res.statusCode
    if (status !== 206 && status !== 200) {
      res.resume()
      return reject(new HttpError('status ' + status, 'status' + status))
    }
    if (status === 200 && start > 0) {
      res.resume()
      return reject(new HttpError('no range support', 'norange'))   // 服务器不支持断点:分块协议玩不转
    }
    const chunks = []
    let got = 0
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      resolve({
        buf: Buffer.concat(chunks, Math.min(got, want)),   // 整发时一个 chunk 可能超出请求长度,截到 want
        complete: got >= want,
        status,
        size: status === 206 ? totalFromRange(res.headers['content-range']) : (parseInt(res.headers['content-length'] || '0', 10) || 0),
      })
    }
    res.on('data', c => {
      chunks.push(c)
      got += c.length
      if (got >= want) {
        // 服务器不理 Range 从头整发:拿够就掐;断点响应则让它自然结束 ——
        // 连接会还给连接池,下一次读不用重新握手(实测每个请求都重连的话慢好几倍)
        if (status !== 206) req.destroy()
        else res.resume()
        finish()
      }
    })
    res.on('end', finish)
    res.on('error', finish)
    res.on('aborted', finish)
    if (deadline > 0) {
      const t = setTimeout(() => { req.destroy(); finish() }, Math.max(0, deadline - Date.now()))
      res.once('close', () => clearTimeout(t))
    }
  })
}

/**
 * 精确读 [start, end)。返回 {buf, complete, size};complete=false 表示预算内没读全(buf 是前缀或空)。
 * 3xx 跟随最多两次(每个跳转目标先交给 allow(url) 校验);其余非 2xx 抛 HttpError(code 形如 'status403')。
 */
async function readRange(url, headers, start, end, deadline, allow) {
  if (deadline > 0 && Date.now() >= deadline) throw new HttpError('deadline', 'deadline')   // 没预算就不发请求
  let target = url
  for (let redirects = 0; ; redirects++) {
    let opened
    try {
      opened = await open(target, headers, start, end, deadline)
    } catch (e) {
      if (e.code === 'redirect' && e.location && redirects < 2) {
        if (allow) await allow(e.location)   // 跳转目标同样要过调用方的白名单/私网检查
        target = e.location
        continue
      }
      throw e
    }
    return collect(opened.req, opened.res, start, end - start, deadline)
  }
}

/**
 * 并行分段读一大段 [start, end),返回 {buf, complete, size}。
 * 预算用完/某一路失败时返回「已经读全的最长连续前缀」,complete=false。
 */
async function readSpan(url, headers, start, end, deadline, allow) {
  const total = end - start
  const parts = Math.max(1, Math.min(SPAN_PARTS, Math.floor(total / MIN_PART_BYTES)))
  const each = Math.ceil(total / parts)
  const results = await Promise.all(Array.from({ length: parts }, (_, i) => {
    const a = start + i * each
    const b = Math.min(end, a + each)
    return readRange(url, headers, a, b, deadline, allow).catch(() => null)
  }))
  const ok = []
  for (const r of results) {
    if (!r || !r.complete) break
    ok.push(r.buf)
  }
  const withSize = results.find(r => r && r.size > 0)
  return { buf: ok.length ? Buffer.concat(ok) : Buffer.alloc(0), complete: ok.length === parts, size: withSize ? withSize.size : 0 }
}

module.exports = { readRange, readSpan, HttpError }
