// fetchMedia —— 分块提取音频(断点续传协议,适配任意函数超时)
//
// 输入:{ ref, offset }   offset = 客户端已接收字节数(0 起)
// 输出:{ ok, chunkB64, nextOffset, totalBytes, ext, done, retry }
//   ext 只在第一块(offset=0)返回;done=已到文件尾;retry=true 表示本次没读到数据,同 offset 重试
//
// 设计要点(2026-11-24):
//   - 每次调用限时 ~2.2s / 1.5MB(二进制),客户端循环拉取拼接 → 函数超时 3s 也能跑,
//     控制台把超时调大后单块更大、更快,但都不是必须
//   - 不落云存储:客户端拼完即得本地文件,省掉 media_imports 集合与 24h 清理
//   - wbi 密钥与音频直链按函数实例进程内缓存(TTL 10min):第一块付解析开销,后续块近乎直连
//   - 域名白名单 + 私网 DNS 拦截保留(ref 来自前端,必须防伪造 SSRF)

const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const https = require('https')
const http = require('http')
const dns = require('dns').promises
const crypto = require('crypto')
const { URL } = require('url')

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
// 抖音 App 客户端 UA:feed 接口与自家 CDN 都认这个形态
const DOUYIN_CLIENT_UA = 'com.ss.android.ugc.aweme/290101 (Linux; U; Android 12; zh_CN; SM-G988N; Build/SP1A.210812.016; Cronet/TTNetVersion:d1da0ea9 2023-01-13 QuicVersion:51879282 2022-12-07)'
const CALL_WALL_MS = 2600        // 单次调用总墙钟预算(函数超时 3s 的余量,超时被平台杀掉前自己收)
const HEADER_TIMEOUT_MS = 1200   // 每个候选的握手/首字节限时:超时就换下一个,绝不在一个坏节点上耗尽预算
const MAX_CHUNK_BYTES = 1536 * 1024
const CACHE_TTL_MS = 10 * 60 * 1000

// ---------- 域名白名单(ref.platform 决定) ----------
// bilibili 特例:官方常把音轨甩到 PCDN 边缘节点(域名不可预测),这些节点从云上大多连不通;
// 但 B站媒体路径必以 /upgcxcode/ 开头,以路径签名兜底放行。
const HOST_ALLOWLIST = {
  bilibili: (h, u) =>
    /(^|\.)(bilivideo\.com|bilivideo\.cn|akamaized\.net)$/.test(h) ||
    !!(u && u.pathname && u.pathname.startsWith('/upgcxcode/')),
  douyin: h => /(^|\.)(douyin\.com|douyinvod\.com|snssdk\.com|amemv\.com|zjcdn\.com|bytecdn\.cn|isnssdk\.com|toutiaocdn\.com|ixigua\.com)$/.test(h),
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

// ---------- 基础 HTTP ----------
// keep-alive 连接池:同一实例的后续分块复用 TLS 连接,握手开销归零
const agentKeep = new https.Agent({ keepAlive: true, maxSockets: 4 })
const agentPlain = new http.Agent({ keepAlive: true, maxSockets: 4 })

function rawGet(url, headers, { timeoutMs = 1200 } = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('http://') ? http : https
    const req = mod.get(url, { headers, agent: mod === https ? agentKeep : agentPlain }, res => {
      resolve({ req, res })
    })
    req.on('error', reject)
    // 限时只管「等到响应头」;数据阶段的预算由 readChunk 自己控
    req.setTimeout(timeoutMs, () => req.destroy(new Error('响应头超时(' + Math.round(timeoutMs / 100) / 10 + 's),换个节点')))
  })
}

function redirectGet(url, headers, { maxRedirects = 3, timeoutMs = 10000 } = {}) {
  // 只处理 API 类小响应(跟随重定向,收完整 body)
  return new Promise((resolve, reject) => {
    const once = (target, left) => {
      rawGet(target, headers, { timeoutMs }).then(({ req, res }) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && left > 0) {
          res.resume()
          return once(new URL(res.headers.location, target).toString(), left - 1)
        }
        const chunks = []
        res.on('data', c => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }))
        res.on('error', reject)
      }, reject).catch(reject)
    }
    once(url, maxRedirects)
  })
}

// ---------- bilibili:wbi 签名 → playurl → 最佳音轨直链(带进程内缓存) ----------
const MIXIN_KEY_ENC_TAB = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 49, 19, 26, 35,
  42, 3, 24, 45, 37, 17, 32, 6, 18, 37, 32, 4, 26, 18, 1, 8]

function md5(s) { return crypto.createHash('md5').update(s).digest('hex') }

function wbiSign(params, imgKey, subKey) {
  const mixinKey = MIXIN_KEY_ENC_TAB.map(i => (imgKey + subKey)[i]).join('')
  const clean = s => String(s).replace(/[!'()*]/g, '')
  const all = Object.assign({ wts: Math.round(Date.now() / 1000) }, params)
  const query = Object.keys(all).sort()
    .map(k => encodeURIComponent(clean(k)) + '=' + encodeURIComponent(clean(all[k]))).join('&')
  return { query, w_rid: md5(query + mixinKey) }
}

const biliApiHeaders = () => ({
  'User-Agent': UA,
  Referer: 'https://www.bilibili.com/',
  Cookie: 'buvid3=' + crypto.randomUUID() + 'infoc',
})

let wbiCache = null   // { imgKey, subKey, ts }
async function biliWbiKeys(headers) {
  if (wbiCache && Date.now() - wbiCache.ts < CACHE_TTL_MS) return wbiCache
  const nav = JSON.parse((await redirectGet('https://api.bilibili.com/x/web-interface/nav', headers)).body.toString('utf8'))
  const img = ((nav.data && nav.data.wbi_img && nav.data.wbi_img.img_url) || '').match(/\/(\w+)\.png/)
  const sub = ((nav.data && nav.data.wbi_img && nav.data.wbi_img.sub_url) || '').match(/\/(\w+)\.png/)
  if (!img || !sub) throw new Error('B站接口开小差(wbi),过一会儿再试')
  wbiCache = { imgKey: img[1], subKey: sub[1], ts: Date.now() }
  return wbiCache
}

const urlCache = new Map()   // cacheKey → { candidates, headers, ts }

async function biliAudioCandidates(ref) {
  const cacheKey = 'bilibili:' + (ref.bvid || ref.aid) + ':' + ref.cid
  const hit = urlCache.get(cacheKey)
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit

  const headers = biliApiHeaders()
  const { imgKey, subKey } = await biliWbiKeys(headers)
  const { query, w_rid } = wbiSign({
    bvid: ref.bvid || undefined,
    aid: !ref.bvid && ref.aid ? ref.aid : undefined,
    cid: ref.cid, qn: 64, fnval: 16, fnver: 0, fourk: 1, platform: 'web',
  }, imgKey, subKey)
  const p = JSON.parse((await redirectGet('https://api.bilibili.com/x/player/wbi/playurl?' + query + '&w_rid=' + w_rid, headers)).body.toString('utf8'))
  if (p.code !== 0) throw new Error('B站播放信息拿不到(' + p.code + '),重新解析一次试试')
  const audios = (p.data && p.data.dash && p.data.dash.audio) || []
  if (!audios.length) throw new Error('这个视频拿不到音轨(可能是特殊格式)')
  audios.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))
  // 主链 + 备链都收进来;排序:稳定域名优先,靠 /upgcxcode/ 路径签名放行的 PCDN 节点垫底
  const t = audios[0]
  const cands = [t.baseUrl, t.base_url]
    .concat(Array.isArray(t.backupUrl) ? t.backupUrl : [t.backupUrl])
    .concat(Array.isArray(t.backup_url) ? t.backup_url : [t.backup_url])
    .filter(Boolean)
  const entry = { candidates: sortStableFirst([...new Set(cands)]), headers, ts: Date.now(), winner: '' }
  urlCache.set(cacheKey, entry)
  if (urlCache.size > 200) urlCache.clear()
  return entry
}

/** 稳定 CDN(域名能对上白名单的)排前面,PCDN(只靠路径签名放行的)垫底 */
function sortStableFirst(urls) {
  const score = u => {
    try {
      const host = new URL(u).hostname.toLowerCase()
      return /(^|\.)(bilivideo\.com|bilivideo\.cn|akamaized\.net)$/.test(host) ? 0 : 1
    } catch (e) { return 2 }
  }
  return urls.sort((a, b) => score(a) - score(b))
}

function cacheKeyFor(ref) {
  if (ref.platform === 'bilibili') return 'bilibili:' + (ref.bvid || ref.aid) + ':' + ref.cid
  if (ref.platform === 'douyin') return 'douyin:' + ref.awemeId
  return ref.platform + ':' + (ref.sphId || ref.url)
}

// ---------- 抖音:App 客户端 feed 接口(免登录免签名,客户端 UA 必需) ----------
const DOUYIN_FEED_HOSTS = ['aweme.snssdk.com', 'aweme-hl.snssdk.com', 'api.amemv.com']

async function douyinEntry(ref) {
  const cacheKey = cacheKeyFor(ref)
  const hit = urlCache.get(cacheKey)
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit

  let item = null
  const errors = []
  for (const host of DOUYIN_FEED_HOSTS) {
    try {
      const res = await redirectGet('https://' + host + '/aweme/v1/feed/?aweme_id=' + ref.awemeId,
        { 'User-Agent': DOUYIN_CLIENT_UA })
      const j = JSON.parse(res.body.toString('utf8'))
      const list = j.aweme_list || []
      // 接口会附带相关推荐,必须按 aweme_id 精确匹配
      item = list.find(a => String(a.aweme_id) === String(ref.awemeId)) || (list.length === 1 ? list[0] : null)
      if (item) break
    } catch (e) {
      errors.push(host + ': ' + e.message)
    }
  }
  if (!item) throw new Error('抖音作品信息拿不到(可能已删除或地区限制),重新解析一次试试')
  if (Array.isArray(item.images) && item.images.length) {
    throw new Error('这是图集作品,没有声音。换一个带画面带声音的视频试试')
  }

  const v = item.video || {}
  const urls = []
  if (v.play_addr) {
    if (Array.isArray(v.play_addr.url_list)) urls.push(...v.play_addr.url_list)
    if (v.play_addr.uri) urls.push('https://aweme.snssdk.com/aweme/v1/play/?video_id=' + v.play_addr.uri + '&ratio=720p&line=0')
  }
  if (v.download_addr && Array.isArray(v.download_addr.url_list)) urls.push(...v.download_addr.url_list)
  const candidates = [...new Set(urls.filter(u => /^https?:\/\//.test(u)))]
  if (!candidates.length) throw new Error('这个作品拿不到视频地址(可能是特殊格式)')

  const entry = { candidates, headers: { 'User-Agent': DOUYIN_CLIENT_UA }, ts: Date.now(), winner: '' }
  urlCache.set(cacheKey, entry)
  if (urlCache.size > 200) urlCache.clear()
  return entry
}

// ---------- 视频号:元宝换授权 token → finder-preview feed 直链(需 YUANBAO_COOKIE 环境变量) ----------
function postJson(url, body, headers) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body))
    const req = https.request(url, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': data.length }, headers),
      timeout: 10000,
    }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null
        try { json = JSON.parse(text) } catch (e) { /* 非 JSON 保留 text */ }
        resolve({ status: res.statusCode, text, json })
      })
    })
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('请求超时')))
    req.write(data)
    req.end()
  })
}

function yuanbaoHeaders(cookie) {
  return {
    'Content-Type': 'application/json',
    'Origin': 'https://yuanbao.tencent.com',
    'Referer': 'https://yuanbao.tencent.com/',
    'User-Agent': UA,
    Cookie: cookie,
    // 服务端校验的自定义头(参考 ltaoo/wx_channels_download / ga-ven 实现)
    'x-agentid': 'naQivTmsDa/cf4d0079-ed1b-4c55-a3f3-2ca1379727d1',
    'x-instance-id': '5',
    'x-platform': 'mac',
    'x-source': 'web',
    'x-webversion': '2.69.0',
    'x-webdriver': '0',
  }
}

async function channelsEntry(ref) {
  const cookie = process.env.YUANBAO_COOKIE || ''
  if (!cookie) {
    throw new Error('视频号解析还没配置:需在云函数 fetchMedia 的环境变量里设置 YUANBAO_COOKIE(获取步骤见交接文档)')
  }
  const cacheKey = cacheKeyFor(ref)
  const hit = urlCache.get(cacheKey)
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit

  // 1. 元宝:分享链接 → playable_url(token/eid);成功响应是 201
  const yb = await postJson('https://yuanbao.tencent.com/api/weixin/get_parse_result',
    { type: 'video_channel_url', url: ref.url, scene: 1 },
    yuanbaoHeaders(cookie))
  if (yb.status === 401) {
    throw new Error('视频号解析的元宝 Cookie 失效了:去云开发控制台更新 fetchMedia 的 YUANBAO_COOKIE 环境变量')
  }
  if (yb.status < 200 || yb.status >= 300) {
    throw new Error('视频号解析服务没响应(' + yb.status + '),稍后再试')
  }
  const yd = (yb.json && yb.json.data) || {}
  const playable = yd.playable_url || ''
  const exportId = yd.wx_export_id || ''
  if (!playable || !exportId) throw new Error('这个视频号作品解析不出来(可能已删除或受限)')
  let token = ''
  try { token = new URL(playable).searchParams.get('token') || '' } catch (e) { /* */ }
  if (!token) throw new Error('视频号解析返回不完整,稍后再试')

  // 2. 视频号 feed:token/eid 要同时出现在 Referer 里,缺了拿不到媒体地址
  const rid = Date.now().toString(16) + Math.random().toString(16).slice(2, 10)
  const feedUrl = 'https://channels.weixin.qq.com/finder-preview/api/feed/get_feed_info?_rid=' + rid +
    '&_pageUrl=' + encodeURIComponent('https://channels.weixin.qq.com/finder-preview/pages/feed')
  const referer = 'https://channels.weixin.qq.com/finder-preview/pages/feed' +
    '?entry_card_type=48&comment_scene=39&appid=0&entry_scene=0' +
    '&token=' + encodeURIComponent(token) + '&eid=' + encodeURIComponent(exportId)
  const fr = await postJson(feedUrl,
    { baseReq: { generalToken: token }, exportId },
    { 'Content-Type': 'application/json', 'Origin': 'https://channels.weixin.qq.com', 'Referer': referer, 'User-Agent': UA })
  if (fr.status < 200 || fr.status >= 300) throw new Error('视频号作品信息拿不到(' + fr.status + '),稍后再试')
  const fj = fr.json || {}
  if (fj.errCode !== undefined && fj.errCode !== 0) {
    throw new Error('这个视频号作品打不开(' + (fj.errMsg || '内容受限') + ')')
  }
  const fi = (fj.data && fj.data.feedInfo) || {}
  const candidates = [
    fi.h264VideoInfo && fi.h264VideoInfo.videoUrl,
    fi.h265VideoInfo && fi.h265VideoInfo.videoUrl,
  ].filter(Boolean)
  if (!candidates.length) throw new Error('这是图文作品或直播回放,没有可提取的视频声音')

  const entry = { candidates, headers: { 'User-Agent': UA }, ts: Date.now(), winner: '' }
  urlCache.set(cacheKey, entry)
  if (urlCache.size > 200) urlCache.clear()
  return entry
}

// ---------- 嗅探:必须真的是音频 ----------
function sniffExt(buf) {
  if (!buf || buf.length < 16) return null
  const b = buf.slice(0, 16)
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return 'm4a'   // ....ftyp
  if ((b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) ||
      (b[0] === 0xFF && (b[1] & 0xE0) === 0xE0)) return 'mp3'                          // ID3 / MPEG sync
  return null
}

// ---------- 单块提取:Range 断点读一段 ----------
function entryFor(ref) {
  if (ref.platform === 'bilibili') return biliAudioCandidates(ref)
  if (ref.platform === 'douyin') return douyinEntry(ref)
  if (ref.platform === 'channels') return channelsEntry(ref)
  const k = cacheKeyFor(ref)
  let entry = urlCache.get(k)
  if (!entry) {
    entry = { candidates: [ref.url], headers: { 'User-Agent': UA }, ts: Date.now(), winner: '' }
    urlCache.set(k, entry)
  }
  return Promise.resolve(entry)
}

async function extractChunk(ref, offset) {
  const entry = await entryFor(ref)
  const { headers } = entry
  // 上次成功过的节点排最前,避免每块都重走坏节点
  const ordered = entry.winner
    ? [entry.winner].concat(entry.candidates.filter(u => u !== entry.winner))
    : entry.candidates

  const t0 = Date.now()
  const want = MAX_CHUNK_BYTES
  let lastErr = null

  for (const target of ordered) {
    try {
      await assertFetchable(target, ref.platform)
      const range = { Range: 'bytes=' + offset + '-' + (offset + want - 1) }
      let usedUrl = target
      let r = await rawGet(target, Object.assign({}, headers, range))

      if (r.res.statusCode >= 300 && r.res.statusCode < 400 && r.res.headers.location) {
        // 媒体 CDN 极少重定向;跟一次
        r.res.resume()
        usedUrl = new URL(r.res.headers.location, target).toString()
        await assertFetchable(usedUrl, ref.platform)
        r = await rawGet(usedUrl, Object.assign({}, headers, range))
      }

      const out = await readChunk(r.req, r.res, offset, t0, want)
      if (out.buf.length) entry.winner = usedUrl
      return out
    } catch (e) {
      lastErr = e
      if (Date.now() - t0 >= CALL_WALL_MS) break   // 预算烧完,别再试下一个了
    }
  }
  throw lastErr || new Error('音频下载失败,再试一次')
}

function readChunk(req, res, offset, t0, want) {
  return new Promise((resolve, reject) => {
    if (res.statusCode !== 206 && res.statusCode !== 200) {
      res.resume()
      return reject(new Error('音频服务器返回 ' + res.statusCode + ',这个链接可能过期了,重新解析一次'))
    }
    if (res.statusCode === 200 && offset > 0) {
      // 服务器不支持 Range(从 0 重发):分块协议玩不转,给出明确出路
      res.resume()
      return reject(new Error('这个音频服务器不支持断点提取。可以在云开发控制台把 fetchMedia 超时调到 60 秒后重试'))
    }

    const totalBytes = parseInt(res.headers['content-range'] ? String(res.headers['content-range']).split('/')[1] || '0' : res.headers['content-length'] && res.statusCode === 200 ? res.headers['content-length'] : '0', 10) || 0
    const chunks = []
    let got = 0
    let done = false

    const finish = ok => {
      if (done) return
      done = true
      if (ok) resolve({ buf: Buffer.concat(chunks), totalBytes, ended: res.complete && got < want })
      else reject(new Error('音频传输中断,稍后重试'))
    }
    res.on('data', c => {
      chunks.push(c)
      got += c.length
      // 墙钟预算:从本次调用开始算(含握手),到点就收手;数据预算与 TTFB 无关
      if (!done && (Date.now() - t0 >= CALL_WALL_MS || got >= want)) {
        req.destroy()          // 掐断连接,手里已读的字节照常返回
        finish(true)
      }
    })
    res.on('end', () => finish(true))
    res.on('error', () => finish(chunks.length > 0))
  })
}

// ---------- 入口 ----------
exports.main = async (event) => {
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

  try {
    const { buf, totalBytes, ended } = await extractChunk(ref, offset)
    if (!buf || !buf.length) {
      return { ok: true, retry: true, nextOffset: offset, totalBytes, ext: '', done: false, chunkB64: '' }
    }
    let ext = ''
    if (offset === 0) {
      ext = sniffExt(buf)
      if (!ext) throw new Error('拿到的内容不是音频(平台接口可能变了),重新解析一次试试')
    }
    const nextOffset = offset + buf.length
    const done = ended || (totalBytes > 0 && nextOffset >= totalBytes)
    return {
      ok: true,
      chunkB64: buf.toString('base64'),
      nextOffset,
      totalBytes,
      ext,
      done,
    }
  } catch (e) {
    const msg = (e && e.message) || ''
    if (/太长|太大|过期|重新解析|不是音频|失败|断|超时|连不上|不对|拿不到|不支持断点|Cookie|视频号|图集|没有声音|图文|受限|删除|特殊格式|解析不出来/.test(msg)) {
      return { ok: false, message: msg }
    }
    console.warn('[fetchMedia] 未归类错误', (e && e.stack) || e)
    return { ok: false, message: '提取没成功,再试一次' }
  }
}

// 本地联调测试用(云端不影响):直接 require 后调 _internal
exports._internal = { wbiSign, biliAudioCandidates, sniffExt, extractChunk, assertFetchable, CALL_WALL_MS, MAX_CHUNK_BYTES }
