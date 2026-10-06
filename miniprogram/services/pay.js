// 虚拟支付封装（wx.requestVirtualPayment，2026-04 起虚拟商品强制通道）
// ⚠️ 双签名只能由云函数计算，AppKey / session_key 绝不能进前端代码
// ⚠️ 前端 success 只是弱确认，到账以云端权益为准（轮询 getEntitlement）

const config = require('../config.js')
const cloud = require('./cloud.js')

/** 买商品：返回是否到账 */
async function buyProduct(product) {
  if (!config.PAY_ENABLED) {
    wx.showToast({ title: '内测期间免费使用', icon: 'none' })
    return { ok: true, free: true }
  }
  // 每次支付前重新 login 拿新 code
  const { code } = await new Promise((resolve, reject) =>
    wx.login({ success: resolve, fail: reject }))

  const order = await cloud.call('createOrder', { code, productId: product.id })

  await new Promise((resolve, reject) => {
    wx.requestVirtualPayment({
      signData: order.signData,
      paySig: order.paySig,
      signature: order.signature,
      mode: 'short_series_goods',
      success: resolve,
      fail: reject,
    })
  })

  // 轮询权益到账（发货推送可能延迟，另有云函数主动查单兜底）
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 1500))
    const ent = await cloud.call('getEntitlement')
    if (ent.monthly || ent.minutes >= (ent._minutesBefore || 0) + (product.minutes || 0)) {
      return { ok: true }
    }
  }
  // 超时：触发主动查单
  await cloud.call('queryOrder', { outTradeNo: order.outTradeNo })
  const ent = await cloud.call('getEntitlement')
  return { ok: !!(ent.monthly || ent.minutes > 0) }
}

module.exports = { buyProduct }
