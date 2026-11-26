// parseMedia —— 贴链接解析(只解析不下载,快)
// 输入:{ text } 分享文案(整段粘进来就行)或纯链接
// 输出:{ ok, platform, platformName, title, cover, durationSec, ref }
//   ref 是给 fetchMedia 的 opaque 引用,原样传回即可;本函数不做任何媒体下载。
//
// 支持平台(2026-11-24,详见 docs/handoff/handoff-2026-11-23-link-import.md):
//   bilibili  官方 API:view → cid/标题/封面/时长(免登录)
//   douyin    短链 302 → 作品号 → App 客户端 feed 接口(客户端 UA,免登录免签名)
//   channels  视频号短链 weixin.qq.com/sph/…(媒体提取在 fetchMedia,需元宝 Cookie)
//   changba   网页播放页里直接暴露 mp3/m4a 直链(正则提取)
//   kge       分享页提取作品号,页面 JSON 里拿 playurl(接口常变,尽力而为)
//   快手/小红书等:明确告知不支持 + 可执行的替代办法,不甩一句"失败"了事
// 链接提取:带协议 URL(尾部标点自动去)、无协议的已知平台域名、裸 BV/av 号,
//   提到平台但没链接时给针对性指路

const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const https = require('https')
const http = require('http')
const dns = require('dns').promises
const { URL } = require('url')

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1'
// 抖音 App 客户端 UA:aweme/v1/feed 接口只认这个形态,浏览器 UA 只回几十字节空壳
const DOUYIN_CLIENT_UA = 'com.ss.android.ugc.aweme/290101 (Linux; U; Android 12; zh_CN; SM-G988N; Build/SP1A.210812.016; Cronet/TTNetVersion:d1da0ea9 2023-01-13 QuicVersion:51879282 2022-12-07)'
const REQ_TIMEOUT_MS = 12000
// B站接口的风控:对数据中心 IP(云函数)只带 UA 的请求直接回 412 拦截页;
// 带上浏览器式的 Cookie(buvid3)+ Referer + Accept 才放行(2026-11-25 云上实测)
const BILI_HEADERS = {
  'User-Agent': UA,
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  Referer: 'https://www.bilibili.com/',
  Cookie: 'buvid3=' + Date.now().toString(16) + Math.random().toString(16).slice(2) + 'infoc',
}

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
  if (h === 'douyin.com' || h.endsWith('.douyin.com') || h.endsWith('.iesdouyin.com') || h === 'iesdouyin.com') return 'douyin'
  if (h === 'weixin.qq.com' || h.endsWith('channels.weixin.qq.com')) return 'channels'
  if (h.endsWith('kuaishou.com')) return 'kuaishou'
  if (h.endsWith('xiaohongshu.com') || h.endsWith('xhslink.com')) return 'xhs'
  return 'unknown'
}

const UNSUPPORTED_TEXT = {
  kuaishou: '暂时还不支持快手,先支持了 B站 / 抖音 / 视频号 / 唱吧 / 全民K歌',
  xhs: '小红书暂不支持,先支持了 B站 / 抖音 / 视频号 / 唱吧 / 全民K歌',
  unknown: '这个平台暂时不支持。先支持了 B站 / 抖音 / 视频号 / 唱吧 / 全民K歌',
}

// 从分享文案里抠有效链接:支持 http(s) 带协议、无协议的已知平台域名,尾部标点自动去掉
const KNOWN_HOST_RE = '(?:b23\\.tv|(?:www\\.)?bilibili\\.com|(?:v|www|m)\\.douyin\\.com|www\\.iesdouyin\\.com|(?:www\\.)?changba\\.com|(?:node\\.)?kg\\d*\\.qq\\.com|channels\\.weixin\\.qq\\.com|weixin\\.qq\\.com\\/sph)'
const URL_STOP = '[^\\s"\'<>【】,，。、;；!！?？()（）「」『』]+'
const TAIL_PUNCT = /[.,;:!?,、。]+$/

function detect(text) {
  const s = String(text)

  // 1. 带协议的 URL(到空白/中文标点为止,去掉尾部标点)
  let url = ''
  const m = s.match(new RegExp('https?:\\/\\/' + URL_STOP, 'i'))
  if (m) url = m[0].replace(TAIL_PUNCT, '')

  // 2. 没带协议:已知的平台域名裸写也算数(v.douyin.com/xxx、weixin.qq.com/sph/xxx 等)
  if (!url) {
    const m2 = s.match(new RegExp(KNOWN_HOST_RE + '\\/' + URL_STOP, 'i'))
    if (m2) url = 'https://' + m2[0].replace(TAIL_PUNCT, '')
  }

  if (url) {
    let host = ''
    try { host = new URL(url).hostname } catch (e) { url = '' }
    if (url) return { platform: byHost(host), url }
  }

  // 3. 裸代码:B站 BV / av(抖音作品号是纯数字,裸形态没有平台签名,不做路由)
  const bv = s.match(/\bBV[0-9A-Za-z]{10}\b/)
  if (bv) return { platform: 'bilibili', url: 'https://www.bilibili.com/video/' + bv[0] }
  const av = s.match(/\bav(\d{6,})\b/i)
  if (av) return { platform: 'bilibili', url: 'https://www.bilibili.com/video/av' + av[1] }

  // 4. 提到平台但没抠出链接 → 针对性指路(别甩一句"没认出"完事)
  if (/抖音|douyin/i.test(s)) return { platform: 'douyin-noguide', url: '' }
  if (/视频号/.test(s)) return { platform: 'channels-noguide', url: '' }
  return null
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
  const vr = await request('https://api.bilibili.com/x/web-interface/view?' + idq, { headers: BILI_HEADERS })
  let v
  try {
    v = JSON.parse(vr.body.toString('utf8'))
  } catch (e) {
    // 回的不是 JSON:多半又是风控拦截页(412)。说人话,别把解析错误甩给用户
    console.warn('[parseMedia] B站接口返回非 JSON', vr.status)
    throw new Error('B站那边暂时不让访问(' + vr.status + '),过几分钟再试')
  }
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
    ref: { platform: 'bilibili', bvid: bvid || '', aid: aid || '', cid, title, durationSec: (page && page.duration) || d.duration || 0 },
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

// ---------- 抖音 ----------
async function resolveDouyin(rawUrl) {
  // 1. URL 里直接带作品号:/video/、/note/、/slides/ 路径或 item_ids 参数
  let m = rawUrl.match(/\/(?:video|note|slides)\/(\d{6,})/) || rawUrl.match(/[?&]item_ids=(\d{6,})/)
  let awemeId = m ? m[1] : ''
  // 2. 短链跟随(v.douyin.com → iesdouyin.com/share/video/…),最终 URL 或页面里找 id
  if (!awemeId) {
    const r = await request(rawUrl, { headers: { 'User-Agent': MOBILE_UA }, maxRedirects: 4 })
    const hay = [r.finalUrl, r.body.toString('utf8').slice(0, 500 * 1024)]
    for (const h of hay) {
      m = h.match(/\/(?:video|note|slides)\/(\d{6,})/) || h.match(/[?&]item_ids=(\d{6,})/) || h.match(/"aweme_id"\s*:\s*"(\d{6,})"/)
      if (m) { awemeId = m[1]; break }
    }
  }
  if (!awemeId) throw new Error('链接能打开,但里面没认出作品编号。作品可能已删除或转私密,重新「复制链接」再试试')

  // 3. App Feed 接口拿标题/时长(必须客户端 UA;失败不阻塞,fetchMedia 会再拿)
  let item = null
  try {
    const res = await request('https://aweme.snssdk.com/aweme/v1/feed/?aweme_id=' + awemeId, { headers: { 'User-Agent': DOUYIN_CLIENT_UA } })
    const j = JSON.parse(res.body.toString('utf8'))
    const list = j.aweme_list || []
    item = list.find(a => String(a.aweme_id) === String(awemeId)) || (list.length === 1 ? list[0] : null)
  } catch (e) { /* 元信息拿不到就先给占位标题 */ }
  if (item && Array.isArray(item.images) && item.images.length) {
    throw new Error('这是图集作品,没有声音。换一个带画面带声音的视频试试')
  }
  return {
    platform: 'douyin', platformName: '抖音',
    title: String((item && item.desc) || '抖音视频').slice(0, 60) || '抖音视频',
    cover: (item && item.video && item.video.cover && item.video.cover.url_list && item.video.cover.url_list[0]) || '',
    durationSec: (item && item.video && item.video.duration ? Math.round(item.video.duration / 1000) : 0) || 0,
    // 解析时已经拿到播放直链,一并带给提取环节:省掉一次冷启动接口调用(首次调用不必白等一轮)
    ref: {
      platform: 'douyin', awemeId: String(awemeId),
      title: String((item && item.desc) || '').slice(0, 60),
      durationSec: item && item.video && item.video.duration ? Math.round(item.video.duration / 1000) : 0,
      urls: douyinPlayUrls(item && item.video),
    },
  }
}

/** 抖音播放直链:play_addr 里的几条 + snssdk 播放接口(会跳转到 CDN,域名更稳) */
function douyinPlayUrls(video) {
  const out = []
  const addr = video && video.play_addr
  if (addr && Array.isArray(addr.url_list)) out.push(...addr.url_list)
  if (addr && addr.uri) out.push('https://aweme.snssdk.com/aweme/v1/play/?video_id=' + addr.uri + '&ratio=720p&line=0')
  return out.filter(u => /^https?:\/\//.test(u)).slice(0, 4)
}

// ---------- 视频号(短链 weixin.qq.com/sph/…;媒体提取需元宝 Cookie,在 fetchMedia 里) ----------
async function resolveChannels(rawUrl) {
  const m = rawUrl.match(/sph\/([A-Za-z0-9]{6,})/)
  if (!m) throw new Error('视频号要用「分享 → 复制链接」得到的短链接(形如 weixin.qq.com/sph/…),网页版长链接认不了')
  return {
    platform: 'channels', platformName: '视频号',
    title: '视频号作品', cover: '', durationSec: 0,
    ref: { platform: 'channels', url: 'https://weixin.qq.com/sph/' + m[1], sphId: m[1] },
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
    if (t.platform === 'douyin-noguide') {
      return { ok: false, message: '没认出抖音链接:在抖音里点「分享 → 复制链接」,把复制的整段文字粘进来(只发口令不行)' }
    }
    if (t.platform === 'channels-noguide') {
      return { ok: false, message: '没认出视频号链接:点作品「分享 → 复制链接」,把复制的整段文字粘进来' }
    }
    if (t.platform === 'bilibili') return Object.assign({ ok: true }, await resolveBilibili(t.url))
    if (t.platform === 'douyin') return Object.assign({ ok: true }, await resolveDouyin(t.url))
    if (t.platform === 'channels') return Object.assign({ ok: true }, await resolveChannels(t.url))
    if (t.platform === 'changba') return Object.assign({ ok: true }, await resolveChangba(t.url))
    if (t.platform === 'kge') return Object.assign({ ok: true }, await resolveKge(t.url))
    return { ok: false, message: UNSUPPORTED_TEXT[t.platform] || UNSUPPORTED_TEXT.unknown }
  } catch (e) {
    // 自己抛的错文案已可读,直接透传;其余按网络问题转人话
    const msg = (e && e.message) || ''
    if (/解析不了|打不开|认出|删除|私密|接口|链接|粘贴|粘进来|下载好|没有声音|图集|短链接/.test(msg)) {
      return { ok: false, message: msg }
    }
    console.warn('[parseMedia] 未归类错误', (e && e.stack) || e)
    // detail 只给排查用(客户端不展示):线上遇到没归类的错,能直接看到原因
    return { ok: false, message: '网络开小差了,再试一次', detail: String(msg).slice(0, 200) }
  }
}
