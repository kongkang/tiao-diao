// parseMedia —— 贴链接解析(只解析不下载,快)
// 输入:{ text } 分享文案(整段粘进来就行)或纯链接
// 输出:{ ok, platform, platformName, title, cover, durationSec, ref }
//   ref 是给 fetchMedia 的 opaque 引用,原样传回即可;本函数不做任何媒体下载。
//
// 支持平台(M1,与调研结论一致,详见 docs/handoff/handoff-2026-11-23-link-import.md):
//   bilibili  官方 API:view → cid/标题/封面/时长(免登录)
//   changba   网页播放页里直接暴露 mp3/m4a 直链(正则提取)
//   kge       分享页提取作品号,页面 JSON 里拿 playurl(接口常变,尽力而为)
// 抖音/快手/小红书/视频号:明确告知不支持 + 可执行的替代办法,不甩一句"失败"了事

const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const https = require('https')
const http = require('http')
const dns = require('dns').promises
const { URL } = require('url')

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
const REQ_TIMEOUT_MS = 12000

// ---------- 简易限频(单实例内存级,防一个号疯狂刷解析;多实例时会放大,可接受) ----------
const RATE = { windowMs: 5 * 60 * 1000, max: 30 }
const rateMap = new Map()   // openid → [timestamps]

function rateLimited(openid) {
  const now = Date.now()
  const arr = (rateMap.get(openid) || []).filter(t => now - t < RATE.windowMs)
  if (arr.length >= RATE.max) return true
  arr.push(now)
  rateMap.set(openid, arr)
  if (rateMap.size > 5000) rateMap.clear()   // 兜底防涨内存
  return false
}

// ---------- HTTP:跟随重定向、超时、只收文本页 ----------
function request(url, { headers = {}, timeoutMs = REQ_TIMEOUT_MS, maxRedirects = 3 } = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('http://') ? http : https
    const req = mod.get(url, {
      headers: Object.assign({ 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' }, headers),
    }, res => {
      // 3xx:跟到底(短链 b23.tv → www.bilibili.com)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && maxRedirects > 0) {
        res.resume()
        const next = new URL(res.headers.location, url).toString()
        return request(next, { headers, timeoutMs, maxRedirects: maxRedirects - 1 }).then(resolve, reject)
      }
      const chunks = []
      let size = 0
      res.on('data', c => { size += c.length; if (size > 3 * 1024 * 1024) { req.destroy(new Error('页面太大')); res.resume() } else chunks.push(c) })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, finalUrl: url, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    req.setTimeout(timeoutMs, () => req.destroy(new Error('请求超时')))
  })
}

// ---------- SSRF 防护:只允许访问公开网段(用户可粘贴任意文本,这里守一道) ----------
function assertPrivateIP(addr) {
  const ip = addr.address
  if (addr.family === 6) {
    const s = ip.toLowerCase()
    return s === '::1' || s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe80')
  }
  const p = ip.split('.').map(Number)
  if (p.length !== 4) return true
  if (p[0] === 127 || p[0] === 10 || p[0] === 0) return true
  if (p[0] === 169 && p[1] === 254) return true
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true
  if (p[0] === 192 && p[1] === 168) return true
  if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true
  return false
}

async function assertPublicUrl(url) {
  let u
  try { u = new URL(url) } catch (e) { throw new Error('链接格式不对') }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('只支持 http/https 链接')
  const host = u.hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('这个链接打不开')
  }
  // 字面 IP 直接判;域名解析后每个 A/AAAA 都要公网
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    if (assertPrivateIP({ family: 4, address: host })) throw new Error('这个链接打不开')
    return
  }
  const addrs = await dns.lookup(host, { all: true }).catch(() => null)
  if (!addrs || !addrs.length) throw new Error('这个链接打不开(域名解析失败)')
  for (const a of addrs) {
    if (assertPrivateIP(a)) throw new Error('这个链接打不开')
  }
}

// ---------- 平台识别 ----------
function byHost(host) {
  const h = String(host || '').toLowerCase()
  if (h === 'b23.tv' || h === 'bilibili.com' || h.endsWith('.bilibili.com')) return 'bilibili'
  if (h === 'changba.com' || h.endsWith('.changba.com')) return 'changba'
  if (/^(node\.)?kg\d*\.qq\.com$/.test(h)) return 'kge'
  if (h.endsWith('douyin.com') || h.endsWith('iesdouyin.com')) return 'douyin'
  if (h.endsWith('kuaishou.com')) return 'kuaishou'
  if (h.endsWith('xiaohongshu.com') || h.endsWith('xhslink.com')) return 'xhs'
  if (h.endsWith('channels.weixin.qq.com')) return 'channels'
  return 'unknown'
}

const UNSUPPORTED_TEXT = {
  douyin: '抖音的解析要专门的签名服务,这个版本还没接。可以先把视频下载好,从微信发给自己再导入',
  kuaishou: '暂时还不支持快手,先支持了 B站 / 唱吧 / 全民K歌',
  xhs: '小红书暂不支持,先支持了 B站 / 唱吧 / 全民K歌',
  channels: '视频号的链接没有公开的解析办法,这个版本先不支持',
  unknown: '这个平台暂时不支持。先支持了 B站 / 唱吧 / 全民K歌',
}

function detect(text) {
  const m = String(text).match(/https?:\/\/[^\s"'<>()【】,，]+/i)
  if (!m) {
    // 只粘了 BV 号也算数
    const bv = String(text).match(/\bBV[0-9A-Za-z]{10}\b/)
    if (bv) return { platform: 'bilibili', url: 'https://www.bilibili.com/video/' + bv[0] }
    return null
  }
  let host = ''
  try { host = new URL(m[0]).hostname } catch (e) { return null }
  return { platform: byHost(host), url: m[0] }
}

// ---------- bilibili ----------
async function resolveBilibili(rawUrl) {
  let url = rawUrl
  // 短链 b23.tv(支持 /BVxxx 与 /xxxx 两种形态)→ 真链
  if (/b23\.tv\//.test(url)) {
    const r = await request(url, { maxRedirects: 3 })
    url = r.finalUrl
  }
  let bvid = (url.match(/\/video\/(BV[0-9A-Za-z]{10})/) || [])[1] || (url.match(/\bBV[0-9A-Za-z]{10}\b/) || [])[0]
  let aid = (url.match(/\/video\/av(\d+)/i) || [])[1] || (url.match(/[?&]aid=(\d+)/) || [])[1] || null
  const p = parseInt((url.match(/[?&]p=(\d+)/) || [])[1] || '1', 10)
  if (!bvid && !aid) {
    throw new Error('是B站的链接,但没认出视频编号。合集/直播不行,单个视频分享一次再试试')
  }

  const idq = bvid ? 'bvid=' + bvid : 'aid=' + aid
  const v = JSON.parse((await request('https://api.bilibili.com/x/web-interface/view?' + idq)).body.toString('utf8'))
  if (v.code !== 0) {
    if (v.code === -404 || v.code === 62002) throw new Error('B站上找不到这个视频了(可能已删除或转成私密)')
    if (v.code === -400 || v.code === 62012) throw new Error('链接没认出来。在B站App里点「分享 → 复制链接」,把整段文字粘进来')
    throw new Error('B站接口开小差(' + v.code + '),过一会儿再试')
  }
  const d = v.data
  const pages = Array.isArray(d.pages) && d.pages.length ? d.pages : []
  const page = pages.length ? pages[Math.min(Math.max(p - 1, 0), pages.length - 1)] : null
  const cid = page ? page.cid : d.cid
  if (!cid) throw new Error('这个视频拿不到播放信息,可能还没过审')

  const title = (d.title || 'B站音频') + (pages.length > 1 && p > 1 ? ' P' + p : '')
  return {
    platform: 'bilibili',
    platformName: 'B站',
    title: title.slice(0, 60),
    cover: String(d.pic || '').replace(/^http:/, 'https:'),
    durationSec: (page && page.duration) || d.duration || 0,
    ref: { platform: 'bilibili', bvid: bvid || '', aid: aid || '', cid, title },
  }
}

// 页面 JSON 里的转义斜杠还原后再找直链
function cleanHtml(html) {
  return html.replace(/\\u002F/gi, '/').replace(/\\\//g, '/')
}

function titleFromHtml(html, fallback) {
  const t = (html.match(/<title>([^<]{0,100})/i) || [])[1] || fallback
  return t.replace(/[_\-–—]\s*唱吧.*$|[_\-–—]\s*全民K歌.*$|首唱.*$|^「|」$/g, '').trim() || fallback
}

// ---------- 唱吧 ----------
async function resolveChangba(rawUrl) {
  let u = rawUrl
  try { if (!/changba\.com$/.test(new URL(u).hostname.toLowerCase().replace(/^www\./, '')) &&
        !new URL(u).hostname.toLowerCase().endsWith('.changba.com') && new URL(u).hostname.toLowerCase() !== 'changba.com') {
    throw new Error('链接不对') } } catch (e) { throw new Error('这个唱吧链接打不开') }
  await assertPublicUrl(u)
  const res = await request(u)
  if (res.status >= 400) throw new Error('这首唱吧作品打不开(可能已删除)')
  const html = res.body.toString('utf8')
  const title = titleFromHtml(html, '唱吧作品')
  const m = cleanHtml(html).match(/https?:\/\/[^\s"'<>\\]+?\.(?:mp3|m4a)/i)
  if (!m) throw new Error('这首唱吧作品暂时解析不了(可能开了隐私保护)。可以在唱吧里下载后,从微信发给自己导入')
  return {
    platform: 'changba', platformName: '唱吧', title: title.slice(0, 60), cover: '', durationSec: 0,
    ref: { platform: 'changba', url: m[0], title },
  }
}

// ---------- 全民K歌(接口常变,尽力而为) ----------
async function resolveKge(rawUrl) {
  const songId = (rawUrl.match(/[?&]s=([\w-]+)/) || [])[1] || (rawUrl.match(/[?&]song_id=([\w-]+)/) || [])[1]
  if (!songId) throw new Error('链接里没认出作品编号。在全民K歌里点「分享 → 复制链接」,把整段文字粘进来')
  await assertPublicUrl('https://node.kg.qq.com/play?s=' + encodeURIComponent(songId))
  const res = await request('https://node.kg.qq.com/play?s=' + encodeURIComponent(songId))
  if (res.status >= 400) throw new Error('这个全民K歌作品打不开(可能已删除或仅好友可见)')
  const html = res.body.toString('utf8')
  const title = titleFromHtml(html, '全民K歌作品')
  const clean = cleanHtml(html)
  const url = (clean.match(/"playurl"\s*:\s*"(https?:\/\/[^"]{10,600}?\.m4a)"/i) || [])[1]
    || (clean.match(/"playurl"\s*:\s*"(https?:\/\/[^"]{10,600}?\.mp3)"/i) || [])[1]
    || (clean.match(/https?:\/\/[^\s"'<>\\]+?\.(?:mp3|m4a)/i) || [])[0]
  if (!url) throw new Error('这首作品暂时解析不了(全民K歌接口常变)。可以从K歌里把作品分享出来,或者用别的链接试试')
  return {
    platform: 'kge', platformName: '全民K歌', title: title.slice(0, 60), cover: '', durationSec: 0,
    ref: { platform: 'kge', url, songId, title },
  }
}

// ---------- 入口 ----------
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) return { ok: false, message: '请在微信里打开后再试' }
  if (rateLimited(OPENID)) return { ok: false, message: '解析太频繁了,歇几分钟再来' }

  const text = String((event && event.text) || '').trim()
  if (!text) return { ok: false, message: '先把分享链接粘贴进来' }
  if (text.length > 2000) return { ok: false, message: '这段文字太长了,只粘分享的那几行就行' }

  try {
    const t = detect(text)
    if (!t) return { ok: false, message: '没认出链接。把分享时复制的整段文字粘进来就行,不用自己删字' }
    if (t.platform === 'bilibili') return Object.assign({ ok: true }, await resolveBilibili(t.url))
    if (t.platform === 'changba') return Object.assign({ ok: true }, await resolveChangba(t.url))
    if (t.platform === 'kge') return Object.assign({ ok: true }, await resolveKge(t.url))
    return { ok: false, message: UNSUPPORTED_TEXT[t.platform] || UNSUPPORTED_TEXT.unknown }
  } catch (e) {
    // 自己抛的错文案已可读,直接透传;其余按网络问题转人话
    const msg = (e && e.message) || ''
    if (/解析不了|打不开|认出|删除|私密|接口|链接|粘贴|粘进来|下载好/.test(msg)) {
      return { ok: false, message: msg }
    }
    console.warn('[parseMedia] 未归类错误', (e && e.stack) || e)
    return { ok: false, message: '网络开小差了,再试一次' }
  }
}
