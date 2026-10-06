// createOrder —— 创建虚拟支付订单，返回 requestVirtualPayment 所需三件套
// 输入：{ code, productId }
// 输出：{ ok, outTradeNo, signData, paySig, signature }
// ⚠️ AppKey 只能放这里（云函数环境变量），前端绝对不可见

const cloud = require('wx-server-sdk')
const crypto = require('crypto')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

// 商品表必须与 MP 后台「虚拟支付-道具管理」完全一致（否则 -15013）
// 单位：分。⚠️ ¥9.9 档位待 M0 真机验证，不合法则依次退 950 / 1000
const PRODUCTS = {
  pkg_10:    { price: 100, minutes: 10 },
  pkg_30:    { price: 300, minutes: 30 },
  pkg_60:    { price: 600, minutes: 60 },
  pkg_month: { price: 990, monthly: true, days: 30 },
}

// 环境变量（部署时在云函数配置里填）：
//   OFFER_ID   虚拟支付 OfferID
//   APP_KEY    虚拟支付 AppKey（支付密钥）
//   ZONE_ID    分区 ID，无分区概念填 "1"
const { OFFER_ID = '', APP_KEY = '', ZONE_ID = '1' } = process.env

function hmacSha256(key, str) {
  return crypto.createHmac('sha256', key).update(str).digest('hex')
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const { productId } = event
  const product = PRODUCTS[productId]
  if (!product) return { ok: false, message: '商品不存在：' + productId }
  if (!OFFER_ID || !APP_KEY) return { ok: false, message: '云函数未配置 OFFER_ID/APP_KEY' }

  const outTradeNo = 'T' + Date.now() + Math.random().toString(36).slice(2, 8)
  const ts = Math.floor(Date.now() / 1000)

  // 1) 落一张待支付订单（幂等锚点：outTradeNo 唯一）
  await db.collection('orders').add({
    data: {
      _openid: OPENID,
      outTradeNo,
      productId,
      priceFen: product.price,
      status: 'created', // created → paid(发货推送) / confirmed(queryOrder 兜底)
      createdAt: db.serverDate(),
    },
  })

  // 2) signData：业务数据串（微信规定格式）
  const signData = JSON.stringify({
    offerId: OFFER_ID,
    buyQuantity: 1,
    env: 0,                    // 0=现网；1=沙箱（联调时改 1）
    zoneId: ZONE_ID,
    currencyType: 'CNY',
    productId,
    goodsPrice: product.price, // 必须与 MP 后台道具价一致
    outTradeNo,
    attach: '',
  })

  // TODO(M2)：session_key 需先用 event.code 走 jscode2session 换取。
  // 骨架阶段先占位，联调时补：
  const sessionKey = 'TODO_session_key_from_jscode2session'

  // 3) paySig = HMAC-SHA256(signData, session_key)
  const paySig = hmacSha256(sessionKey, signData)

  // 4) signature = HMAC-SHA256(请求串, AppKey)
  //    请求串 = "requestVirtualPayment&" + paySig 相关字段拼串
  //    ⚠️ 以官方文档《小程序虚拟支付-服务端签名》为准，联调时核对
  const signature = hmacSha256(APP_KEY, signData + '&offer_id=' + OFFER_ID)

  return { ok: true, outTradeNo, signData, paySig, signature, ts }
}
