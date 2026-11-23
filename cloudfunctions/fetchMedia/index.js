// fetchMedia —— 把 parseMedia 给的 ref 落成云存储里的音频文件
// 输入:{ ref }  ← 前端把 parseMedia 返回的 ref 原样传回
// 输出:{ ok, fileID, ext, sizeBytes, title }
//
// 流程:平台直链(带 Referer)→ 下载(≤80MB)→ 嗅探确为音频 → 传云存储
// 安全:域名按平台白名单 + 私网段 DNS 拦截(ref 来自前端,可被伪造,必须守)
// 计费:本函数不涉及;免费,下载/转调导出的付费走现有 unlock 流程。

const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const https = require('https')
const http = require('http')
const dns = require('dns').promises
const crypto = require('crypto')
const { URL } = require('url')

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
const MAX_BYTES = 80 * 1024 * 1024        // 与小程序端 IMPORT_MAX_MB 一致
const DL_TIMEOUT_MS = 45000

// ---------- 域名白名单(ref.platform 决定) ----------
// bilibili 特例:官方常把音轨甩到 PCDN 边缘节点(域名不可预测,如 *.edge.xxxx.cn),
// 这些节点从云上大多连不通;但 B站媒体路径必以 /upgcxcode/ 开头,以路径签名兜底放行。
const HOST_ALLOWLIST = {
  bilibili: (h, u) =>
    /(^|\.)(bilivideo\.com|bilivideo\.cn|akamaized\.net)$/.test(h) ||
    !!(u && u.pathname && u.pathname.startsWith('/upgcxcode/')),
  changba: h => /(^|\.)changba\.com$/.test(h) || /(^|\.)lncetimes\.com$/.test(h),
  kge: h => /(^|\.)qq\.com$/.test(h),
}

// ---------- 私网段拦截(与 parseMedia 同款) ----------
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
  const addrs = await dns.lookup(host, { all: true }).catch(() => null)
  if (!addrs || !addrs.length) throw new Error('音频服务器连不上,过一会儿再试')
  for (const a of addrs) if (isPrivateIP(a)) throw new Error('音频来源地址不对')
}

// ---------- bilibili:wbi 签名 → playurl → 最佳音轨直链 ----------
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

async function biliAudioCandidates(ref) {
  const headers = {
    'User-Agent': UA,
    Referer: 'https://www.bilibili.com/',
    Cookie: 'buvid3=' + crypto.randomUUID() + 'infoc',
  }
  const nav = JSON.parse((await httpsGet('https://api.bilibili.com/x/web-interface/nav', headers)).body.toString('utf8'))
  const img = ((nav.data && nav.data.wbi_img && nav.data.wbi_img.img_url) || '').match(/\/(\w+)\.png/)
  const sub = ((nav.data && nav.data.wbi_img && nav.data.wbi_img.sub_url) || '').match(/\/(\w+)\.png/)
  if (!img || !sub) throw new Error('B站接口开小差(wbi),过一会儿再试')
  const { query, w_rid } = wbiSign({
    bvid: ref.bvid || undefined,
    aid: !ref.bvid && ref.aid ? ref.aid : undefined,
    cid: ref.cid, qn: 64, fnval: 16, fnver: 0, fourk: 1, platform: 'web',
  }, img[1], sub[1])
  const p = JSON.parse((await httpsGet('https://api.bilibili.com/x/player/wbi/playurl?' + query + '&w_rid=' + w_rid, headers)).body.toString('utf8'))
  if (p.code !== 0) throw new Error('B站播放信息拿不到(' + p.code + '),重新解析一次试试')
  const audios = (p.data && p.data.dash && p.data.dash.audio) || []
  if (!audios.length) throw new Error('这个视频拿不到音轨(可能是特殊格式)')
  audios.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))
  // 主链 + 备链都收进来:主链常被甩到 PCDN 节点,备链多是稳定 CDN
  const t = audios[0]
  const cands = [t.baseUrl, t.base_url]
    .concat(Array.isArray(t.backupUrl) ? t.backupUrl : [t.backupUrl])
    .concat(Array.isArray(t.backup_url) ? t.backup_url : [t.backup_url])
    .filter(Boolean)
  return { candidates: [...new Set(cands)], headers }
}

// ---------- 基础 HTTP(GET,手动跟重定向,流式限大小) ----------
function httpsGet(url, headers, { timeoutMs = 12000, maxRedirects = 3 } = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('http://') ? http : https
    const req = mod.get(url, { headers }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && maxRedirects > 0) {
        res.resume()
        const next = new URL(res.headers.location, url).toString()
        return httpsGet(next, headers, { timeoutMs, maxRedirects: maxRedirects - 1 }).then(resolve, reject)
      }
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, finalUrl: url, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    req.setTimeout(timeoutMs, () => req.destroy(new Error('请求超时')))
  })
}

function downloadMedia(url, headers) {
  return new Promise((resolve, reject) => {
    const tryOnce = (target, redirectsLeft) => {
      const mod = target.startsWith('http://') ? http : https
      const req = mod.get(target, { headers }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
          res.resume()
          return tryOnce(new URL(res.headers.location, target).toString(), redirectsLeft - 1)
        }
        if (res.statusCode !== 200) {
          res.resume()
          return reject(new Error('音频服务器返回 ' + res.statusCode + ',这个链接可能过期了,重新解析一次'))
        }
        const len = parseInt(res.headers['content-length'] || '0', 10)
        if (len > MAX_BYTES) {
          res.resume()
          return reject(new Error('这个音频太大了(超过 80MB),换个短一点的'))
        }
        const chunks = []
        let size = 0
        res.on('data', c => {
          size += c.length
          if (size > MAX_BYTES) {
            req.destroy()
            res.resume()
            return reject(new Error('这个音频太大了(超过 80MB),换个短一点的'))
          }
          chunks.push(c)
        })
        res.on('end', () => resolve({ buf: Buffer.concat(chunks), status: res.statusCode }))
      })
      req.on('error', e => reject(/destroyed|socket hang up/i.test(e.message)
        ? new Error('音频传到一半断了,再试一次')
        : e))
      req.setTimeout(DL_TIMEOUT_MS, () => req.destroy(new Error('下载超时:音频太长或网络不稳,换个短一点的')))
    }
    tryOnce(url, 3)
  })
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

// ---------- 云存储:清理 24h 前的本用户导入 + 记录本次 ----------
async function cleanupAndRecord(openid, fileID, title) {
  try {
    const cutoff = Date.now() - 24 * 3600 * 1000
    const old = await db.collection('media_imports')
      .where({ openid, createdAt: _.lt(cutoff) }).limit(20).get()
    const ids = (old.data || []).map(d => d.fileID).filter(Boolean)
    if (ids.length) await cloud.deleteFile({ fileList: ids })
    await db.collection('media_imports').where({ openid, createdAt: _.lt(cutoff) }).remove()
  } catch (e) {
    // 集合还没建/权限问题:不影响主流程,只是旧文件清不掉(见交接文档)
  }
  try {
    await db.collection('media_imports').add({
      data: { openid, fileID, title: String(title || '').slice(0, 60), createdAt: Date.now() },
    })
  } catch (e) { /* 同上 */ }
}

// ---------- 入口 ----------
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) return { ok: false, message: '请在微信里打开后再试' }

  const ref = event && event.ref
  if (!ref || !HOST_ALLOWLIST[ref.platform]) {
    return { ok: false, message: '提取信息不完整,重新解析一次' }
  }

  try {
    let candidates
    let headers = { 'User-Agent': UA }
    if (ref.platform === 'bilibili') {
      if (!ref.cid) return { ok: false, message: '提取信息不完整,重新解析一次' }
      const r = await biliAudioCandidates(ref)
      candidates = r.candidates
      headers = r.headers
    } else {
      if (!ref.url) return { ok: false, message: '提取信息不完整,重新解析一次' }
      candidates = [ref.url]
    }

    // 逐个候选尝试:白名单 + 私网拦截 → 下载;PCDN 主链挂了自动换备链
    let buf = null
    let lastErr = null
    for (const target of candidates) {
      try {
        await assertFetchable(target, ref.platform)
        buf = (await downloadMedia(target, headers)).buf
        break
      } catch (e) {
        lastErr = e
      }
    }
    if (!buf) {
      throw lastErr || new Error('音频下载失败,再试一次')
    }
    const ext = sniffExt(buf)
    if (!ext) throw new Error('拿到的内容不是音频(平台接口可能变了),重新解析一次试试')

    const cloudPath = 'imports/' + OPENID + '/' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.' + ext
    const up = await cloud.uploadFile({ cloudPath, fileBuffer: buf })
    if (!up || !up.fileID) throw new Error('音频转存失败,再试一次')

    cleanupAndRecord(OPENID, up.fileID, ref.title)

    return { ok: true, fileID: up.fileID, ext, sizeBytes: buf.length, title: ref.title || '' }
  } catch (e) {
    const msg = (e && e.message) || ''
    if (/太长|太大|过期|重新解析|不是音频|失败|断|超时|连不上|不对|拿不到/.test(msg)) {
      return { ok: false, message: msg }
    }
    console.warn('[fetchMedia] 未归类错误', (e && e.stack) || e)
    return { ok: false, message: '提取没成功,再试一次' }
  }
}

// 本地联调测试用(云端不影响):直接 require 后调 _internal
exports._internal = { wbiSign, biliAudioCandidates, sniffExt, downloadMedia, assertFetchable, MAX_BYTES }
