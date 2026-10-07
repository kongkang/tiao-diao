// 虚拟支付封装（wx.requestVirtualPayment，2026-04 起虚拟商品强制通道）
// ⚠️ 双签名只能由云函数计算，AppKey / session_key 绝不能进前端代码
// ⚠️ 前端 success 只是弱确认，到账以云端权益为准（轮询 getEntitlement）
//
// 本地模拟模式（PAY_ENABLED=false 且管理页模拟成付费用户时）：
//   弹「模拟支付」确认框 → 确认后直接把商品写到本地权益，跑通完整购买闭环。
//   正式开关打开后此分支自动失效，无缝切真实支付。

const config = require('../config.js')
const cloud = require('./cloud.js')
const billing = require('./billing.js')

/** 模拟支付：确认框 → 本地到账。文案必须带「模拟」字样，绝不冒充真实支付 */
function buyProductLocal(product) {
  return new Promise((resolve, reject) => {
    const yuan = (product.price / 100).toFixed(product.price % 10 === 0 ? 1 : 2).replace(/\.0$/, '')
    wx.showModal({
      title: '模拟支付',
      content: '假装付 ' + yuan + ' 元，买「' + product.name + '」。\n（内测联调用，不扣真钱）',
      confirmText: '假装付了',
      cancelText: '再想想',
      success: res => {
        if (!res.confirm) return reject({ errMsg: 'simulate cancel', cancelled: true })
        const ent = billing.topUpLocal(product)
        resolve({ ok: true, simulated: true, entitlement: ent })
      },
      fail: () => reject({ errMsg: 'simulate fail' }),
    })
  })
}

/** 买商品：返回是否到账 */
async function buyProduct(product) {
  if (!config.PAY_ENABLED) {
    const ent = billing.readLocalEnt()
    if (ent.free) {
      wx.showToast({ title: '内测期间免费使用', icon: 'none' })
      return { ok: true, free: true }
    }
    return buyProductLocal(product)
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
