// queryOrder —— 主动查单兜底（前端轮询权益超时后调用）
// 场景：发货推送延迟/丢失时，拿 outTradeNo 向微信查支付结果，
//       已支付但本地未发货 → 补发货（复用幂等逻辑）
// 输入：{ outTradeNo }

const cloud = require('wx-server-sdk')
const crypto = require('crypto')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

const { OFFER_ID = '', APP_KEY = '', ZONE_ID = '1' } = process.env

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const { outTradeNo } = event
  if (!outTradeNo) return { ok: false, message: '缺少 outTradeNo' }

  const { data: orders } = await db.collection('orders')
    .where({ outTradeNo, _openid: OPENID }).limit(1).get()
  const order = orders[0]
  if (!order) return { ok: false, message: '订单不存在' }

  // 已发货：直接返回
  if (order.status === 'paid') return { ok: true, status: 'paid' }

  // TODO(M2)：调微信「查询订单」接口（POST https://api.weixin.qq.com/xpay/query_order）
  //   签名：HMAC-SHA256(请求体, AppKey)，用 cloud.openapi 或 urllib 发起
  //   返回 PayState=0(已支付) 时补发货：
  //   await cloud.callFunction({ name: 'onDelivered', data: { OutTradeNo: outTradeNo } })
  // 骨架阶段先标记待人工核对，避免误发货：
  await db.collection('orders').doc(order._id).update({
    data: { status: 'confirming', queryCount: (order.queryCount || 0) + 1 },
  })

  return {
    ok: true,
    status: 'confirming',
    message: '订单确认中，稍后会自动到账；若长时间未到账请联系客服',
  }
}
