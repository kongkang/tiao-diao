// onDelivered —— 接收微信「支付发货推送」（HTTP 触发，MP 后台配置回调 URL）
// 职责：验签 → 幂等检查 → 发货（加分钟 / 开包月）→ 回执
// ⚠️ 必须幂等：微信会重推，同一 outTradeNo 只能发货一次
// ⚠️ 必须回执：返回 { ErrCode: 0, ErrMsg: "" }，否则微信持续重推

const cloud = require('wx-server-sdk')
const crypto = require('crypto')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const { APP_KEY = '' } = process.env

// 商品定义与 createOrder 保持一致
const PRODUCTS = {
  pkg_10:    { minutes: 10 },
  pkg_30:    { minutes: 30 },
  pkg_60:    { minutes: 60 },
  pkg_month: { monthly: true, days: 30 },
}

async function deliver(order) {
  const product = PRODUCTS[order.productId]
  if (!product) return
  const users = db.collection('users')
  const now = Date.now()

  if (product.monthly) {
    // 包月：若当前仍在包月内则顺延 30 天，否则从今晚起算
    const { data } = await users.where({ _openid: order._openid }).get()
    const cur = data[0] || {}
    const base = (cur.monthlyUntil && cur.monthlyUntil > now) ? cur.monthlyUntil : now
    await users.where({ _openid: order._openid }).update({
      data: { monthlyUntil: base + product.days * 86400000 },
    }).catch(() => users.add({
      data: { _openid: order._openid, monthlyUntil: base + product.days * 86400000, minutes: 0 },
    }))
  } else {
    await users.where({ _openid: order._openid }).update({
      data: { minutes: _.inc(product.minutes) },
    }).catch(() => users.add({
      data: { _openid: order._openid, minutes: product.minutes, monthlyUntil: 0 },
    }))
  }
}

exports.main = async (event, context) => {
  // HTTP 触发时，推送体在 event.body（需先解析）
  // TODO(M2)：按官方文档验签：signature = HMAC-SHA256(原始报文, AppKey)
  // 验签不过直接丢弃，返回错误码让微信不再重推
  let payload
  try {
    payload = typeof event.body === 'string' ? JSON.parse(event.body) : (event.body || event)
  } catch (e) {
    return { ErrCode: 1, ErrMsg: 'bad body' }
  }

  const outTradeNo = payload.OutTradeNo || payload.outTradeNo
  if (!outTradeNo) return { ErrCode: 1, ErrMsg: 'no outTradeNo' }

  // 幂等：订单已 paid 直接回成功（发货只做一次）
  const { data: orders } = await db.collection('orders')
    .where({ outTradeNo }).limit(1).get()
  const order = orders[0]
  if (!order) return { ErrCode: 1, ErrMsg: 'order not found' }

  if (order.status !== 'paid') {
    await db.collection('orders').doc(order._id).update({
      data: {
        status: 'paid',
        paidAt: db.serverDate(),
        pushPayload: payload, // 留档，便于对账
      },
    })
    await deliver(order)
  }

  return { ErrCode: 0, ErrMsg: '' }
}
