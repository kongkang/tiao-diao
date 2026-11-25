// 各平台「作品 → 媒体直链」解析(实例内缓存 10 分钟)
//
//   bilibili  wbi 签名 → playurl → DASH 音频流(分片式,纯音频)
//   douyin    App 客户端 feed 接口(客户端 UA,免登录免签名)→ mp4
//   channels  mtotech 公共解析(主)/ 元宝 Cookie(备,需环境变量)→ mp4
//   其他      parseMedia 给的直链原样用(唱吧 / 全民K歌)
//
// 每个入口返回 entry:{ platform, candidates:[url…], headers, winner }
//   candidates 已按「稳定 CDN 优先」排好;winner 是上次成功过的节点

'use strict'

const https = require('https')
const http = require('http')
const crypto = require('crypto')
const { URL } = require('url')

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
// 抖音 App 客户端 UA:feed 接口与自家 CDN 都认这个形态
const DOUYIN_CLIENT_UA = 'com.ss.android.ugc.aweme/290101 (Linux; U; Android 12; zh_CN; SM-G988N; Build/SP1A.210812.016; Cronet/TTNetVersion:d1da0ea9 2023-01-13 QuicVersion:51879282 2022-12-07)'
const CACHE_TTL_MS = 10 * 60 * 1000

function cacheKeyFor(ref) {
  if (ref.platform === 'bilibili') return 'bilibili:' + (ref.bvid || ref.aid) + ':' + ref.cid
  if (ref.platform === 'douyin') return 'douyin:' + ref.awemeId
  return ref.platform + ':' + (ref.sphId || ref.url)
}

// ---------- 小响应 GET(API 调用,跟随跳转) ----------
const apiAgent = new https.Agent({ keepAlive: true, maxSockets: 4 })

function redirectGet(url, headers, { maxRedirects = 3, timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const once = (target, left) => {
      const req = https.get(target, { headers, agent: apiAgent }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && left > 0) {
          res.resume()
          return once(new URL(res.headers.location, target).toString(), left - 1)
        }
        const chunks = []
        res.on('data', c => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }))
        res.on('error', reject)
      })
      req.on('error', err => reject(netError(err)))
      req.setTimeout(timeoutMs, () => req.destroy(timeoutError('接口超时')))
    }
    once(url, maxRedirects)
  })
}

/** 超时 / 网络错误都打上 code,入口据此让客户端重试,而不是当成「取不了」报给用户 */
function timeoutError(msg) {
  const e = new Error(msg)
  e.code = 'deadline'
  return e
}

function netError(err) {
  if (err && err.code === 'deadline') return err
  const e = new Error('网络开小差了,再试一次')
  e.code = 'net'
  e.cause = err && (err.code || err.message)
  return e
}

function postJson(url, body, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body))
    const req = https.request(url, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': data.length }, headers),
      timeout: timeoutMs || 10000,
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
    req.on('error', err => reject(netError(err)))
    req.on('timeout', () => req.destroy(timeoutError('请求超时')))
    req.write(data)
    req.end()
  })
}

const urlCache = new Map()   // cacheKey → entry

function remember(key, entry) {
  urlCache.set(key, entry)
  if (urlCache.size > 200) urlCache.clear()
  return entry
}

function cached(key) {
  const hit = urlCache.get(key)
  return hit && Date.now() - hit.ts < CACHE_TTL_MS ? hit : null
}

// ---------- bilibili:wbi 签名 → playurl → 音轨直链 ----------
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

// 选音轨:优先 192k / 132k / 64k 的普通 AAC(小程序自带解码器最稳,体积也小)。
// 码率最高的那条常是 Hi-Res 无损(30250)或杜比(30251):体积大好几倍,解码器也未必带了。
const BILI_AAC_PREF = [30280, 30232, 30216]
function pickBiliAudio(audios) {
  for (const id of BILI_AAC_PREF) {
    const hit = audios.find(a => a.id === id)
    if (hit) return hit
  }
  const plain = audios.filter(a => a.id !== 30250 && a.id !== 30251)
  return plain.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0] || audios[0]
}

/** 稳定 CDN(域名能对上白名单的)排前面,PCDN(只靠路径签名放行的)垫底 */
function stableFirst(urls) {
  const score = u => {
    try {
      return /(^|\.)(bilivideo\.com|bilivideo\.cn|akamaized\.net)$/.test(new URL(u).hostname.toLowerCase()) ? 0 : 1
    } catch (e) { return 2 }
  }
  return urls.slice().sort((a, b) => score(a) - score(b))
}

async function biliEntry(ref) {
  const key = cacheKeyFor(ref)
  const hit = cached(key)
  if (hit) return hit

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
  const t = pickBiliAudio(audios)
  // 主链 + 备链都收进来:主链常被甩到 PCDN 节点,备链多是稳定 CDN
  const cands = [t.baseUrl, t.base_url]
    .concat(Array.isArray(t.backupUrl) ? t.backupUrl : [t.backupUrl])
    .concat(Array.isArray(t.backup_url) ? t.backup_url : [t.backup_url])
    .filter(Boolean)
  return remember(key, { platform: 'bilibili', candidates: stableFirst([...new Set(cands)]), headers, winner: '' })
}

// ---------- 抖音:App 客户端 feed 接口(免登录免签名,客户端 UA 必需) ----------
const DOUYIN_FEED_HOSTS = ['aweme.snssdk.com', 'aweme-hl.snssdk.com', 'api.amemv.com']

async function douyinEntry(ref, refresh) {
  const key = cacheKeyFor(ref)
  const hit = cached(key)
  if (hit) return hit
  // 解析环节已把播放直链随 ref 带来:直接用,省掉一次接口调用。失效时由调用方要求 refresh 再走接口
  if (!refresh && Array.isArray(ref.urls)) {
    const carried = ref.urls.filter(u => /^https?:\/\//.test(u))
    if (carried.length) {
      return remember(key, { platform: 'douyin', candidates: carried, headers: { 'User-Agent': DOUYIN_CLIENT_UA }, winner: '', fromRef: true })
    }
  }

  let item = null
  for (const host of DOUYIN_FEED_HOSTS) {
    try {
      const res = await redirectGet('https://' + host + '/aweme/v1/feed/?aweme_id=' + ref.awemeId,
        { 'User-Agent': DOUYIN_CLIENT_UA })
      const list = (JSON.parse(res.body.toString('utf8')).aweme_list) || []
      // 接口会附带相关推荐,必须按 aweme_id 精确匹配
      item = list.find(a => String(a.aweme_id) === String(ref.awemeId)) || (list.length === 1 ? list[0] : null)
      if (item) break
    } catch (e) { /* 换下一个接入点 */ }
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
  return remember(key, { platform: 'douyin', candidates, headers: { 'User-Agent': DOUYIN_CLIENT_UA }, winner: '' })
}

// ---------- 视频号:mtotech 公共解析(主)/ 元宝 Cookie(备) ----------
let yuanbaoBadUntil = 0   // 元宝 Cookie 明确失效后,这段时间内不再试它(省下预算给主路)

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

async function channelsViaYuanbao(ref, cookie, budgetEnd) {
  // 1. 元宝:分享链接 → playable_url(token/eid);成功响应是 201
  const yb = await postJson('https://yuanbao.tencent.com/api/weixin/get_parse_result',
    { type: 'video_channel_url', url: ref.url, scene: 1 },
    yuanbaoHeaders(cookie), 8000)
  if (yb.status === 401) {
    yuanbaoBadUntil = Date.now() + CACHE_TTL_MS
    throw new Error('视频号解析的元宝 Cookie 失效了:去云开发控制台更新 fetchMedia 的 YUANBAO_COOKIE 环境变量')
  }
  if (yb.status < 200 || yb.status >= 300) throw new Error('视频号解析服务没响应(' + yb.status + '),稍后再试')
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
    { 'Content-Type': 'application/json', 'Origin': 'https://channels.weixin.qq.com', 'Referer': referer, 'User-Agent': UA }, 8000)
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
  return { candidates, headers: { 'User-Agent': UA } }
}

async function channelsViaMtotech(ref, budgetEnd) {
  // 实测延迟 1.7~5s:只在剩余预算内等,等不到就报超时让客户端重试
  const budget = Math.max(600, budgetEnd - Date.now() - 300)
  const res = await postJson('https://v.mtotech.com/api/resolve',
    { url: ref.url },
    { 'Content-Type': 'application/json', 'User-Agent': UA },
    budget)
  if (res.status !== 200) {
    if (res.status === 429) throw new Error('视频号解析公共通道限流了,稍等几秒再试')
    throw new Error('视频号解析服务没响应(' + res.status + '),稍后再试')
  }
  const j = res.json
  if (j && j.error) {
    if (/invalid/i.test(j.error)) throw new Error('这个视频号作品打不开(链接无效或已删除)')
    throw new Error('视频号解析失败(' + String(j.error).slice(0, 40) + ')')
  }
  const d = (j && j.data) || {}
  const candidates = [d.h264_url, d.h265_url].filter(Boolean)
  if (!candidates.length) throw new Error('这是图文作品或直播回放,没有可提取的视频声音')
  return { candidates, headers: { 'User-Agent': UA } }
}

async function channelsEntry(ref, budgetEnd) {
  const key = cacheKeyFor(ref)
  const hit = cached(key)
  if (hit) return hit

  const cookie = process.env.YUANBAO_COOKIE || ''
  let first = null
  if (cookie && Date.now() >= yuanbaoBadUntil) {
    try {
      return remember(key, Object.assign({ platform: 'channels', winner: '' }, await channelsViaYuanbao(ref, cookie, budgetEnd)))
    } catch (e) {
      first = e
      if (Date.now() >= budgetEnd) throw e
    }
  }
  try {
    return remember(key, Object.assign({ platform: 'channels', winner: '' }, await channelsViaMtotech(ref, budgetEnd)))
  } catch (e) {
    throw first && /Cookie/.test(first.message) ? first : e
  }
}

// ---------- 统一入口 ----------
/** 作品引用 → 媒体直链入口(带缓存)。budgetEnd 是本次调用的时间预算截止点 */
async function entryFor(ref, budgetEnd, refresh) {
  if (ref.platform === 'bilibili') return biliEntry(ref)
  if (ref.platform === 'douyin') return douyinEntry(ref, refresh)
  if (ref.platform === 'channels') return channelsEntry(ref, budgetEnd)
  const key = cacheKeyFor(ref)
  return cached(key) || remember(key, { platform: ref.platform, candidates: [ref.url], headers: { 'User-Agent': UA }, winner: '' })
}

/** 清掉全部解析缓存(直链过期/失效时调用),下次重新解析 */
function clearCaches() {
  urlCache.clear()
}

/** 只清掉「客户端带过来的直链」那部分缓存:它们可能已经过期,接口解析出来的照常留着 */
function forgetCarried() {
  for (const [k, e] of urlCache) if (e.fromRef) urlCache.delete(k)
}

module.exports = { UA, DOUYIN_CLIENT_UA, entryFor, cacheKeyFor, clearCaches, forgetCarried, _internals: { wbiSign, pickBiliAudio, redirectGet } }
