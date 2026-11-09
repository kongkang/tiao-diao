// createOrder —— 创建虚拟支付订单，返回 wx.requestVirtualPayment 所需三件套
//
// 官方文档（2026-11 核对，小程序虚拟支付）：
//   paySig    = HMAC-SHA256(AppKey, "requestVirtualPayment&" + signData)
//   signature = HMAC-SHA256(session_key, signData)
//   signData 必须与前端传给 wx.requestVirtualPayment 的字符串一个字符都不差
//   ⚠️ AppKey / AppSecret 只能放云函数环境变量，绝不可进前端
//
// 云函数环境变量（云开发控制台 → 云函数 → createOrder → 配置 → 环境变量）：
//   OFFER_ID        虚拟支付 OfferID（MP 后台 → 虚拟支付 → 基本配置）
//   APP_KEY         现网 AppKey（env=0）
//   APP_KEY_SANDBOX 沙箱 AppKey（env=1，可选；沙箱仅开发者工具可用）
//   PAY_ENV         0=现网（默认；体验版/正式版只能 0） 1=沙箱
//   APPSECRET       小程序 AppSecret（code2session 换 session_key）
//   APPID           可选，默认取 cloud.getWXContext().APPID

const cloud = require('wx-server-sdk')
const crypto = require('crypto')
const https = require('https')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

// 商品表必须与 MP 后台「虚拟支付 → 道具管理」完全一致（ID + 价格，单位分），
// 否则客户端会报 -15013。2026-11-09 收敛为两个商品：60 分钟 1 元、包月 9.9 元。
const PRODUCTS = {
  pkg_60:    { price: 100, minutes: 60 },
  pkg_month: { price: 990, monthly: true, days: 30 },
}

// 本地部署包注入的密钥（不进 git；仅用于无法配置环境变量的环境）
let LOCAL_SECRETS = {}
try { LOCAL_SECRETS = require('./secrets.js') } catch (e) { /* 没有注入 */ }

const OFFER_ID = process.env.OFFER_ID || LOCAL_SECRETS.OFFER_ID || ''
const PAY_ENV = Number(process.env.PAY_ENV || LOCAL_SECRETS.PAY_ENV || 0) === 1 ? 1 : 0
const APP_KEY = PAY_ENV === 1
  ? (process.env.APP_KEY_SANDBOX || LOCAL_SECRETS.APP_KEY_SANDBOX || '')
  : (process.env.APP_KEY || LOCAL_SECRETS.APP_KEY || '')

function hmac(key, str) {
  return crypto.createHmac('sha256', key).update(str).digest('hex')
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

/** wx.login 的 code 只能用一次；换 session_key 用于用户态签名 */
async function code2session(appid, secret, code) {
  const url = 'https://api.weixin.qq.com/sns/jscode2session'
    + '?appid=' + encodeURIComponent(appid)
    + '&secret=' + encodeURIComponent(secret)
    + '&js_code=' + encodeURIComponent(code)
    + '&grant_type=authorization_code'
  const r = await getJson(url)
  if (r.errcode) throw new Error('code2session ' + r.errcode + ' ' + (r.errmsg || ''))
  if (!r.openid || !r.session_key) throw new Error('code2session 缺少 openid/session_key')
  return r
}

/** outTradeNo：8~32 字符，只允许数字/字母/_-|*@，不能以下划线开头 */
function newOutTradeNo() {
  return 'T' + Date.now() + crypto.randomBytes(4).toString('hex') // 1+13+8=22 位
}

/** 首次调用时集合可能还没建：add 失败就建集合重试一次 */
async function addWithEnsure(collection, data) {
  try {
    return await db.collection(collection).add({ data })
  } catch (e) {
    const msg = String((e && e.message) || '')
    if (!/not exist|不存在|DATABASE_COLLECTION_NOT_EXIST/i.test(msg)) throw e
    try { await db.createCollection(collection) } catch (e2) { /* 已存在 */ }
    return db.collection(collection).add({ data })
  }
}

exports.main = async (event) => {
  const { OPENID, APPID } = cloud.getWXContext()
  const { productId, code } = event || {}
  const product = PRODUCTS[productId]
  if (!product) return { ok: false, message: '商品不存在：' + productId }
  if (!OFFER_ID || !APP_KEY) return { ok: false, message: '支付还没配置好（缺 OFFER_ID/APP_KEY）' }
  if (!code) return { ok: false, message: '登录态缺失，请重试' }

  const appid = process.env.APPID || LOCAL_SECRETS.APPID || APPID
  const secret = process.env.APPSECRET || LOCAL_SECRETS.APPSECRET || ''
  if (!appid || !secret) return { ok: false, message: '支付还没配置好（缺 APPID/APPSECRET）' }

  let sessionKey = ''
  try {
    const s = await code2session(appid, secret, code)
    sessionKey = s.session_key
    // code2session 返回的 openid 理论上与上下文一致；不一致直接拒绝
    if (s.openid && OPENID && s.openid !== OPENID) {
      return { ok: false, message: '登录态与当前用户不一致，请重试' }
    }
  } catch (e) {
    console.warn('[createOrder] code2session 失败', e.message)
    return { ok: false, message: '登录态失效，请重试' }
  }

  const outTradeNo = newOutTradeNo()
  // 字段顺序固定，前端原样回传；attach 必填（发货推送原样带回）
  const signData = JSON.stringify({
    offerId: String(OFFER_ID),
    buyQuantity: 1,
    env: PAY_ENV,
    currencyType: 'CNY',
    productId: productId,
    goodsPrice: product.price,
    outTradeNo: outTradeNo,
    attach: productId,
  })
  const paySig = hmac(APP_KEY, 'requestVirtualPayment&' + signData)
  const signature = hmac(sessionKey, signData)

  // 先落单：发货推送按 outTradeNo 找单；签名材料不落库
  try {
    await addWithEnsure('orders', {
      _openid: OPENID,
      outTradeNo: outTradeNo,
      productId: productId,
      priceFen: product.price,
      env: PAY_ENV,
      status: 'created',
      createdAt: db.serverDate(),
    })
  } catch (e) {
    console.warn('[createOrder] 落单失败', e.message)
    return { ok: false, message: '创建订单失败，请重试' }
  }

  return {
    ok: true,
    outTradeNo: outTradeNo,
    signData: signData,
    paySig: paySig,
    signature: signature,
    mode: 'short_series_goods',
  }
}
