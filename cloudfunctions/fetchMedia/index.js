// fetchMedia —— 贴链接导入的媒体提取(分块断点协议 + 云端只取音轨)
//
// 输入:{ ref, offset, startSec?, maxSec? }
//   offset    客户端已经收到的成品字节数(0 起)
//   startSec  从媒体的第几秒开始取(视频太长时用户选一段)
//   maxSec    这一段最多取多长(默认 10 分钟,硬上限 15 分钟)
// 输出:{ ok, chunkB64, nextOffset, totalBytes, ext, done, retry?, meta? }
//   ext / meta 只在第一块(offset=0)返回;done = 成品已全部给完
//   retry = true:这次预算内没读到新字节,客户端用同一个 offset 再来一次
//
// 取法(slicer.js 按文件结构决定,客户端无感):
//   抖音 / 视频号的 mp4 → 只取音轨(画面占九成字节,手机端不用再背整个视频);视频太长就按时间切一段
//   B站音频流(分片式)  → 整段放得下直传;太长按分片边界截一段
//   mp3 等              → 整文件直传
//
// 预算:单次调用在 CALL_WALL_MS 内自己收手,读不完就返回前缀,客户端续传。
//   解析出的直链和切片计划都按实例缓存 10 分钟:冷实例第一块慢,后面的块近乎直连。
// 安全:ref 来自前端,域名按平台白名单 + 私网 DNS 拦截;跳转目标同样要过检查。

'use strict'

const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const dns = require('dns').promises
const { URL } = require('url')

const mediahttp = require('./mediahttp.js')
const platforms = require('./platforms.js')
const slicer = require('./slicer.js')
const { PlanError } = require('./mp4box.js')

// 单次调用总墙钟预算:默认 2600ms(适配函数超时 3s)。控制台把超时调大后,
// 可设环境变量 FETCH_WALL_MS(如 9000)放大预算:单次读得更多,调用次数更少
const CALL_WALL_MS = Math.min(15000, Math.max(2000, parseInt(process.env.FETCH_WALL_MS || '2600', 10) || 2600))
const MAX_CHUNK_BYTES = 1536 * 1024
const CACHE_TTL_MS = 10 * 60 * 1000
const DEFAULT_MAX_SEC = 600      // 一段最多 10 分钟:真机变调约 0.1 倍实时,再长手机吃不消
const HARD_MAX_SEC = 900

// ---------- 域名白名单(ref.platform 决定) ----------
// bilibili 特例:官方常把音轨甩到 PCDN 边缘节点(域名不可预测),这些节点从云上大多连不通;
// 但 B站媒体路径必以 /upgcxcode/ 开头,以路径签名兜底放行。
const HOST_ALLOWLIST = {
  bilibili: (h, u) =>
    /(^|\.)(bilivideo\.com|bilivideo\.cn|akamaized\.net)$/.test(h) ||
    !!(u && u.pathname && u.pathname.startsWith('/upgcxcode/')),
  // 抖音/字节的视频 CDN 域名很多:play_addr 直链常见 *.365yg.com、*.douyinvod.com,跳转后还可能落到
  // *.zjcdn.com、*.pstatp.com 等;只有确认是字节系视频分发域名才放行
  douyin: h => /(^|\.)(douyin\.com|douyinvod\.com|365yg\.com|snssdk\.com|isnssdk\.com|amemv\.com|zjcdn\.com|bytecdn\.cn|pstatp\.com|toutiaocdn\.com|toutiaovod\.com|ixigua\.com)$/.test(h),
  channels: h => /(^|\.)qq\.com$/.test(h),
  changba: h => /(^|\.)changba\.com$/.test(h) || /(^|\.)lncetimes\.com$/.test(h),
  kge: h => /(^|\.)qq\.com$/.test(h),
}

// ---------- 私网段拦截 ----------
function isPrivateIP(addr) {
  if (addr.family === 6) {
    const s = String(addr.address).toLowerCase()
    return s === '::1' || s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe80')
  }
  const p = String(addr.address).split('.').map(Number)
  if (p.length !== 4) return true
  if (p[0] === 127 || p[0] === 10 || p[0] === 0) return true
  if (p[0] === 169 && p[1] === 254) return true
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true
  if (p[0] === 192 && p[1] === 168) return true
  if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true
  return false
}

const dnsCache = new Map()   // host → { ok, ts }

async function assertFetchable(url, platform) {
  let u
  try { u = new URL(url) } catch (e) { throw new Error('提取地址无效') }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('提取地址无效')
  const host = u.hostname.toLowerCase()
  const ok = HOST_ALLOWLIST[platform]
  if (!ok || !ok(host, u)) throw new Error('音频来源地址不对(' + platform + '),解析结果可能过期了,重新解析一次')
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    if (isPrivateIP({ family: 4, address: host })) throw new Error('音频来源地址不对')
    return
  }
  const cached = dnsCache.get(host)
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    if (!cached.ok) throw new Error('音频服务器连不上,过一会儿再试')
    return
  }
  const addrs = await dns.lookup(host, { all: true }).catch(() => null)
  const good = !!(addrs && addrs.length) && addrs.every(a => !isPrivateIP(a))
  dnsCache.set(host, { ok: good, ts: Date.now() })
  if (dnsCache.size > 500) dnsCache.clear()
  if (!addrs || !addrs.length) throw new Error('音频服务器连不上,过一会儿再试')
  for (const a of addrs) if (isPrivateIP(a)) throw new Error('音频来源地址不对')
}

// ---------- 嗅探:整文件直传时确认拿到的真是音频 ----------
function sniffExt(buf) {
  if (!buf || buf.length < 12) return null
  const b = buf
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return 'm4a'   // ....ftyp
  if ((b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) ||
      (b[0] === 0xFF && (b[1] & 0xE0) === 0xE0)) return 'mp3'                          // ID3 / MPEG 帧同步
  if (b[0] === 0x66 && b[1] === 0x4C && b[2] === 0x61 && b[3] === 0x43) return 'flac'  // fLaC
  if (b[0] === 0x4F && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53) return 'ogg'   // OggS
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x41) return 'wav'   // RIFF…WAVE
  return null
}

// ---------- 来源:直链 + 切片计划(按实例缓存) ----------
const sourceCache = new Map()   // key → { plan, url, headers, platform, ts }

function sourceKey(ref, slice) {
  return platforms.cacheKeyFor(ref) + '|' + slice.startSec + '|' + slice.maxSec
}

/** 给某个直链配一套读函数;跳转目标也要过白名单/私网检查 */
function ioFor(url, headers, platform, deadline) {
  const allow = loc => assertFetchable(loc, platform)
  return {
    read: async (start, end) => {
      const r = await mediahttp.readRange(url, headers, start, end, deadline, allow)
      if (!r.complete) throw new mediahttp.HttpError('short read', 'deadline')
      return r.buf
    },
    readSpan: (start, end) => mediahttp.readSpan(url, headers, start, end, deadline, allow),
  }
}

// 这些是「取不了」的明确原因:直接告诉用户,不退回整文件直传
// (退回去等于把整个视频传到手机,最后还是解不了)
const PLAN_FAIL_TEXT = {
  NO_AUDIO: '这个视频里没有声音,换一个视频试试',
  DRM: '这个视频的声音有加密保护,解不开',
  EMPTY: '这一段里没有声音,换个起点试试',
}

async function buildSource(ref, slice, deadline) {
  let entry = await platforms.entryFor(ref, deadline)
  for (let round = 0; ; round++) {
    const r = await tryEntry(entry, ref, slice, deadline)
    if (r) return r
    // 客户端带来的直链可能已经过期:走接口重新解析一次再试
    if (!entry.fromRef || Date.now() >= deadline) break
    entry = await platforms.entryFor(ref, deadline, true)
  }
  throw new mediahttp.HttpError('deadline', 'deadline')
}

async function tryEntry(entry, ref, slice, deadline) {
  let lastErr = null
  let timedOut = false
  // 上次成功过的节点排最前,避免每块都重走坏节点
  const ordered = entry.winner ? [entry.winner].concat(entry.candidates.filter(u => u !== entry.winner)) : entry.candidates
  for (const url of ordered) {
    if (Date.now() >= deadline) break
    try {
      await assertFetchable(url, entry.platform)
      const io = ioFor(url, entry.headers, entry.platform, deadline)
      // 探一下:确认支持断点读取,顺便拿到文件大小
      const probe = await mediahttp.readRange(url, entry.headers, 0, 1, deadline, loc => assertFetchable(loc, entry.platform))
      if (probe.status !== 206 || !probe.size) {
        throw new mediahttp.HttpError('no range support', 'norange')
      }
      let plan
      try {
        plan = await slicer.buildSource({ read: io.read, fileSize: probe.size, slice, durationSec: ref.durationSec || 0 })
      } catch (e) {
        if (!(e instanceof PlanError)) throw e
        if (PLAN_FAIL_TEXT[e.code]) return { fail: PLAN_FAIL_TEXT[e.code] }
        plan = null   // 结构认不出 / 没法切:整文件直传
      }
      if (!plan) plan = slicer.plainPlan(probe.size, { durationSec: ref.durationSec || 0 })
      entry.winner = url
      const src = { plan, url, headers: entry.headers, platform: entry.platform, ts: Date.now() }
      sourceCache.set(sourceKey(ref, slice), src)
      if (sourceCache.size > 50) sourceCache.clear()
      return src
    } catch (e) {
      lastErr = e
      if (Date.now() >= deadline) { timedOut = true; break }   // 预算花光:让客户端重试(解析结果已缓存)
    }
  }
  if (timedOut || !lastErr) return null
  throw lastErr
}

async function sourceFor(ref, slice, deadline) {
  const key = sourceKey(ref, slice)
  const hit = sourceCache.get(key)
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit
  return buildSource(ref, slice, deadline)
}

// ---------- 入口 ----------
exports.main = async (event) => {
  const deadline = Date.now() + CALL_WALL_MS
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) return { ok: false, message: '请在微信里打开后再试' }

  const ref = event && event.ref
  const offset = Math.max(0, parseInt((event && event.offset) || 0, 10) || 0)
  if (!ref || !HOST_ALLOWLIST[ref.platform]) {
    return { ok: false, message: '提取信息不完整,重新解析一次' }
  }
  if (ref.platform === 'bilibili' && !ref.cid) {
    return { ok: false, message: '提取信息不完整,重新解析一次' }
  }
  if (ref.platform === 'douyin' && !ref.awemeId) {
    return { ok: false, message: '提取信息不完整,重新解析一次' }
  }
  if ((ref.platform === 'changba' || ref.platform === 'kge' || ref.platform === 'channels') && !ref.url) {
    return { ok: false, message: '提取信息不完整,重新解析一次' }
  }
  const slice = {
    startSec: Math.max(0, Math.min(24 * 3600, Number(event.startSec) || 0)),
    maxSec: Math.max(1, Math.min(HARD_MAX_SEC, Number(event.maxSec) || DEFAULT_MAX_SEC)),
  }

  // 没新字节可给:让客户端用同一个 offset 再来(解析/计划是逐步缓存的,下一次会更快)
  const again = (totalBytes, done) => ({ ok: true, retry: true, nextOffset: offset, totalBytes: totalBytes || 0, ext: '', done: !!done, chunkB64: '' })

  try {
    const src = await sourceFor(ref, slice, deadline)
    if (src.fail) return { ok: false, message: src.message }
    const plan = src.plan
    if (offset >= plan.totalBytes) {
      return { ok: true, retry: false, nextOffset: offset, totalBytes: plan.totalBytes, ext: '', done: true, chunkB64: '' }
    }
    const r = await slicer.readPlanChunk(plan, ioFor(src.url, src.headers, src.platform, deadline), offset, MAX_CHUNK_BYTES, deadline)
    if (!r.buf.length) return again(plan.totalBytes, false)

    let ext = ''
    let meta
    if (offset === 0) {
      ext = plan.kind === 'bytes' ? sniffExt(r.buf) : 'm4a'
      if (!ext) throw new Error('拿到的内容不是音频(平台接口可能变了),重新解析一次试试')
      meta = {
        durationSec: Math.round((plan.durationSec || 0) * 10) / 10,
        startSec: Math.round((plan.startSec || 0) * 10) / 10,
        mediaDurationSec: Math.round((plan.mediaDurationSec || 0) * 10) / 10,
        mode: plan.mode,
      }
    }
    return {
      ok: true,
      chunkB64: r.buf.toString('base64'),
      nextOffset: r.nextOffset,
      totalBytes: plan.totalBytes,
      ext,
      done: r.done,
      meta,
    }
  } catch (e) {
    const code = (e && e.code) || ''
    // 预算用完 / 接口超时 / 网络抖动:都不是最终失败,客户端原 offset 重试即可
    if (code === 'deadline' || code === 'aborted' || code === 'net') return again(0, false)
    if (/^status(403|404|410|429|500|502|503)$/.test(code)) {
      // 多半是签名直链过期 / 节点抽风:清掉缓存,客户端原 offset 重试时会重新解析
      sourceCache.clear()
      platforms.forgetCarried()
      return again(0, false)
    }
    if (code === 'norange') {
      return { ok: false, message: '这个音频来源不支持断点提取,暂时取不了' }
    }
    const msg = (e && e.message) || ''
    // 各平台解析抛的错都是给用户看的中文短句,原样透出;其余按未归类处理
    if (/[\u4e00-\u9fa5]/.test(msg)) return { ok: false, message: msg }
    console.warn('[fetchMedia] 未归类错误', (e && e.stack) || e)
    return { ok: false, message: '提取没成功,再试一次' }
  }
}

// 本地联调测试用(云端不影响)
exports._internal = { assertFetchable, sniffExt, ioFor, sourceFor, CALL_WALL_MS, MAX_CHUNK_BYTES }
