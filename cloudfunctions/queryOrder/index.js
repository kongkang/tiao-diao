// queryOrder —— 主动查单兜底（前端轮询权益超时后调用）
//
// 场景：发货推送延迟/丢失时，拿 outTradeNo 调官方 /xpay/query_order 查支付结果，
//       已支付但本地未发货 → 复用 onDelivered 的幂等发货逻辑补发。
//
// 官方文档（2026-11 核对）：
//   POST https://api.weixin.qq.com/xpay/query_order?access_token=xxx&pay_sig=xxx
//   pay_sig = HMAC-SHA256(AppKey, "/xpay/query_order&" + 原始请求体)
//   返回 order.status：0/1 未支付，2 已支付待发货，3 发货中，4 已发货，6 已关闭
//
// 云函数环境变量：
//   OFFER_ID / APP_KEY / APP_KEY_SANDBOX / PAY_ENV（与 createOrder 相同）
//   APPID（可选，默认取上下文）/ APPSECRET（获取 access_token 必需）

const cloud = require('wx-server-sdk')
const crypto = require('crypto')
const https = require('https')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

// 本地部署包注入的密钥（不进 git；仅用于无法配置环境变量的环境）
let LOCAL_SECRETS = {}
try { LOCAL_SECRETS = require('./secrets.js') } catch (e) { /* 没有注入 */ }

const PAY_ENV = Number(process.env.PAY_ENV || LOCAL_SECRETS.PAY_ENV || 0) === 1 ? 1 : 0
const APP_KEY = PAY_ENV === 1
  ? (process.env.APP_KEY_SANDBOX || LOCAL_SECRETS.APP_KEY_SANDBOX || '')
  : (process.env.APP_KEY || LOCAL_SECRETS.APP_KEY || '')
const APPID = process.env.APPID || LOCAL_SECRETS.APPID || ''
const APPSECRET = process.env.APPSECRET || LOCAL_SECRETS.APPSECRET || ''

function hmac(key, str) {
  return crypto.createHmac('sha256', key).update(str).digest('hex')
}

function requestJson(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let s = ''
      res.on('data', (d) => { s += d })
      res.on('end', () => {
        try { resolve(JSON.parse(s)) } catch (e) {
          reject(new Error('接口返回异常：' + s.slice(0, 120)))
        }
      })
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let s = ''
      res.on('data', (d) => { s += d })
      res.on('end', () => {
        try { resolve(JSON.parse(s)) } catch (e) {
          reject(new Error('接口返回异常：' + s.slice(0, 120)))
        }
      })
    }).on('error', reject)
  })
}

// access_token 有效期 7200s；云函数实例复用即可缓存
let tokenCache = { token: '', expireAt: 0 }

async function getAccessToken(appid) {
  if (tokenCache.token && tokenCache.expireAt > Date.now() + 60000) return tokenCache.token
  if (!appid || !APPSECRET) throw new Error('支付还没配置好（缺 APPID/APPSECRET）')
  const url = 'https://api.weixin.qq.com/cgi-bin/token'
    + '?grant_type=client_credential'
    + '&appid=' + encodeURIComponent(appid)
    + '&secret=' + encodeURIComponent(APPSECRET)
  const r = await getJson(url)
  if (!r.access_token) throw new Error('获取 access_token 失败(' + (r.errcode || '') + ' ' + (r.errmsg || '') + ')')
  tokenCache = {
    token: r.access_token,
    expireAt: Date.now() + (r.expires_in || 7200) * 1000,
  }
  return tokenCache.token
}

async function xpayQuery(openid, orderId, env, token) {
  const body = JSON.stringify({
    openid: openid,
    env: env,
    order_id: orderId,
  })
  const paySig = hmac(APP_KEY, '/xpay/query_order&' + body)
  return requestJson({
    hostname: 'api.weixin.qq.com',
    path: '/xpay/query_order?access_token=' + encodeURIComponent(token) + '&pay_sig=' + paySig,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  }, body)
}

exports.main = async (event) => {
  const { OPENID, APPID: CTX_APPID } = cloud.getWXContext()
  const appid = APPID || CTX_APPID
  const { outTradeNo } = event || {}
  if (!outTradeNo) return { ok: false, message: '缺少 outTradeNo' }
  if (!APP_KEY) return { ok: false, message: '支付还没配置好（缺 APP_KEY）' }

  let order = null
  try {
    const { data } = await db.collection('orders')
      .where({ outTradeNo, _openid: OPENID }).limit(1).get()
    order = data[0] || null
  } catch (e) {
    return { ok: false, message: '查询订单失败，请重试' }
  }
  if (!order) return { ok: false, message: '订单不存在' }
  if (order.status === 'paid') return { ok: true, status: 'paid' }

  const env = typeof order.env === 'number' ? order.env : PAY_ENV
  let r
  try {
    let token = await getAccessToken(appid)
    r = await xpayQuery(order._openid, outTradeNo, env, token)
    // access_token 失效：清缓存重试一次
    if (r && (r.errcode === 40001 || r.errcode === 40014 || r.errcode === 42001)) {
      tokenCache = { token: '', expireAt: 0 }
      token = await getAccessToken(appid)
      r = await xpayQuery(order._openid, outTradeNo, env, token)
    }
  } catch (e) {
    console.warn('[queryOrder] 查单失败', e.message)
    return { ok: false, message: e.message || '查单失败，请稍后重试' }
  }

  if (!r || r.errcode) {
    return {
      ok: false,
      message: '查单失败(' + ((r && r.errcode) || '') + ' ' + ((r && r.errmsg) || '') + ')',
    }
  }

  const status = r.order && r.order.status
  // 2 已支付待发货 / 3 发货中 / 4 已发货：都走幂等发货补账
  if (status === 2 || status === 3 || status === 4) {
    try {
      await cloud.callFunction({
        name: 'onDelivered',
        data: {
          Event: 'xpay_goods_deliver_notify',
          OpenId: order._openid,
          OutTradeNo: outTradeNo,
          Env: env,
          GoodsInfo: { ProductId: order.productId, Quantity: 1 },
          WeChatPayInfo: { MchOrderNo: (r.order && r.order.wx_order_id) || '' },
        },
      })
    } catch (e) {
      console.warn('[queryOrder] 触发发货失败', e.message)
      return { ok: false, message: '查单成功但发货失败，请稍后重试' }
    }
    return { ok: true, status: 'paid' }
  }

  if (status === 6) {
    await db.collection('orders').doc(order._id).update({ data: { status: 'closed' } }).catch(() => {})
    return { ok: false, status: 'closed', message: '订单已关闭' }
  }

  // 0/1 未支付：保持待支付
  await db.collection('orders').doc(order._id).update({
    data: { queryCount: (order.queryCount || 0) + 1, lastQueryAt: db.serverDate() },
  }).catch(() => {})
  return { ok: false, status: 'pending', message: '还没查到支付成功，请稍后再试' }
}
