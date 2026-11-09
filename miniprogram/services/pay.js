// 虚拟支付封装（wx.requestVirtualPayment，2026-04 起虚拟商品强制通道）
//
// 官方流程（2026-11 核对）：
//   前端取 wx.login 的新 code → 云函数 createOrder 换 session_key 并算双签名
//   → wx.requestVirtualPayment 拉起支付 → 发货推送 / 主动查单到账
//
// ⚠️ 双签名只能由云函数计算，AppKey / session_key 绝不能进前端代码
// ⚠️ 前端 success 只是弱确认，到账以云端权益为准（轮询 getEntitlement）
//
// 本地模拟模式（PAY_ENABLED=false 且管理页模拟成付费用户时）：
//   弹「模拟支付」确认框 → 确认后直接把商品写到本地权益，跑通完整购买闭环。
//   正式开关打开后此分支自动失效，无缝切真实支付。

const config = require('../config.js')
const cloud = require('./cloud.js')
const billing = require('./billing.js')

const ERR_TEXT = {
  '-1': '支付没成功，请再试一次',
  '-2': '已取消支付',
  '-4': '支付被风控拦截，请稍后再试',
  '-15005': '登录状态异常，请返回重试',
  '-15006': '支付签名校验失败（服务端配置问题）',
  '-15007': '登录已过期，请重试',
  '-15008': '商户进件未完成，暂时不能收款',
  '-15010': '商品还没发布，请稍后再试',
  '-15011': '支付环境配置错误（现网不能用沙箱）',
  '-15013': '商品价格与后台不一致（配置问题）',
  '-15014': '商品刚发布，约 10 分钟后生效',
  '-15016': '支付参数格式错误（配置问题）',
  '-15017': '收款功能受限，请联系管理员',
  '-15018': '商品审核未通过，暂时不能购买',
  '-15019': '商户受限，暂时不能收款',
  '-15020': '操作太快了，请稍后再试',
  '-15021': '交易太频繁，请稍后再试',
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function wxLogin() {
  return new Promise((resolve, reject) => wx.login({ success: resolve, fail: reject }))
}

function versionCompare(v1, v2) {
  const a = String(v1 || '').split('.').map(n => parseInt(n, 10) || 0)
  const b = String(v2 || '').split('.').map(n => parseInt(n, 10) || 0)
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const x = a[i] || 0
    const y = b[i] || 0
    if (x > y) return 1
    if (x < y) return -1
  }
  return 0
}

/** 基础库 >= 2.19.2 或 canIUse 判定接口可用 */
function isSupported() {
  try {
    const info = wx.getAppBaseInfo ? wx.getAppBaseInfo() : wx.getSystemInfoSync()
    if (versionCompare(info.SDKVersion, '2.19.2') >= 0) return true
    return !!(wx.canIUse && wx.canIUse('requestVirtualPayment'))
  } catch (e) {
    return false
  }
}

/** iOS 端走 Apple 支付：iOS 15+、微信 8.0.68+、单笔最低 1 元 */
function checkIosCompat(product) {
  let platform = ''
  let system = ''
  let wxVersion = ''
  try {
    const dev = wx.getDeviceInfo ? wx.getDeviceInfo() : wx.getSystemInfoSync()
    platform = dev.platform || ''
    system = dev.system || ''
    const app = wx.getAppBaseInfo ? wx.getAppBaseInfo() : wx.getSystemInfoSync()
    wxVersion = app.version || ''
  } catch (e) { /* 取不到就放行，交给微信侧校验 */ }

  if (platform !== 'ios' && platform !== 'ipados') return true

  if (wxVersion && versionCompare(wxVersion, '8.0.68') < 0) {
    wx.showModal({
      title: '微信版本太低',
      content: 'iPhone 上购买需要微信 8.0.68 或更高版本，请先更新微信。',
      showCancel: false,
      confirmText: '知道了',
    })
    return false
  }

  const m = /iOS\s+(\d+)/i.exec(system)
  if (m && Number(m[1]) < 15) {
    wx.showModal({
      title: '系统版本太低',
      content: 'iPhone 上购买需要 iOS 15 或更高版本，请先升级系统。',
      showCancel: false,
      confirmText: '知道了',
    })
    return false
  }

  if (product && product.price < 100) {
    wx.showModal({
      title: '这个商品 iPhone 上买不了',
      content: 'iPhone 端单笔最低 1 元。可以先选其他面额，或在安卓手机上购买。',
      showCancel: false,
      confirmText: '知道了',
    })
    return false
  }
  return true
}

function errText(err) {
  const code = err && (err.errCode !== undefined ? err.errCode : err.errcode)
  const key = code === undefined || code === null ? '' : String(code)
  if (ERR_TEXT[key]) return ERR_TEXT[key]
  return (err && (err.errMsg || err.message)) || '支付没成功，请再试一次'
}

/** 购买前权益快照 → 判断是否到账 */
function achieved(before, after, product) {
  const b = before || {}
  const a = after || {}
  if (product.monthly) return (a.monthlyUntil || 0) > (b.monthlyUntil || 0)
  return (a.minutes || 0) >= (b.minutes || 0) + (product.minutes || 0)
}

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

/** 买商品：返回是否到账；opts.onProgress(stage) 给页面显示等待进度 */
async function buyProduct(product, opts) {
  const onProgress = (opts && opts.onProgress) || function () {}
  if (!config.PAY_ENABLED) {
    const ent = billing.readLocalEnt()
    if (ent.free) {
      wx.showToast({ title: '内测期间免费使用', icon: 'none' })
      return { ok: true, free: true }
    }
    return buyProductLocal(product)
  }

  if (!cloud.available()) throw new Error('当前微信版本不支持支付，请更新微信后重试')
  if (!isSupported()) throw new Error('微信版本太低，请更新微信后再支付')
  if (!checkIosCompat(product)) return { ok: false, cancelled: true, compat: false }

  // 支付前先确认云端可用，并记下购买前权益作为到账基线
  let before
  try {
    before = await cloud.call('getEntitlement')
  } catch (e) {
    throw new Error(config.PAY_OFFLINE_FREE
      ? '支付服务还没准备好，请稍后再试（其他功能不受影响）'
      : '支付服务暂时不可用，请稍后再试')
  }

  // 每次支付前重新 login 拿新 code（code 只能用一次）
  const { code } = await wxLogin()
  const order = await cloud.call('createOrder', { code, productId: product.id })
  if (!order || !order.signData || !order.paySig || !order.signature) {
    throw new Error('下单失败，请稍后再试')
  }

  onProgress('paying')
  try {
    await new Promise((resolve, reject) => {
      wx.requestVirtualPayment({
        signData: order.signData,
        paySig: order.paySig,
        signature: order.signature,
        mode: order.mode || 'short_series_goods',
        success: resolve,
        fail: reject,
      })
    })
  } catch (e) {
    const codeNum = e && e.errCode
    if (codeNum === -2 || /cancel/i.test((e && e.errMsg) || '')) {
      return { ok: false, cancelled: true }
    }
    console.warn('[pay] requestVirtualPayment 失败', codeNum, (e && e.errMsg) || e)
    throw new Error(errText(e))
  }

  // success 只是弱确认：以云端权益到账为准。
  // 关键：支付成功后立刻并行查单（queryOrder），不再先干等 10 次权益轮询，
  // 否则没配发货推送时要等 30 秒才触发查单，用户会以为钱丢了。
  onProgress('confirming')
  const t0 = Date.now()
  let stopped = false
  let queryBusy = false

  const queryLoop = (async () => {
    const delays = [1200, 2500, 3000, 3000, 4000, 4000, 5000, 5000]
    for (let i = 0; i < delays.length && !stopped; i++) {
      await sleep(delays[i])
      if (stopped) break
      if (queryBusy) continue
      queryBusy = true
      try {
        // 支付刚完成时微信侧可能还没入账，查不到就等下一轮；查到会触发幂等发货
        await cloud.call('queryOrder', { outTradeNo: order.outTradeNo })
      } catch (e) {
        console.warn('[pay] 查单未成功，稍后重试', e.message)
      }
      queryBusy = false
    }
  })()

  try {
    for (let i = 0; i < 24; i++) {
      await sleep(1000)
      if (Date.now() - t0 > 2000 && i % 2 === 1) onProgress('delivering')
      const ent = await cloud.call('getEntitlement').catch(() => null)
      if (ent && achieved(before, ent, product)) {
        stopped = true
        onProgress('arrived')
        return { ok: true }
      }
    }
  } finally {
    stopped = true
    queryLoop.catch(() => {})
  }

  // 最后再查一次单 + 短轮询，仍不到账就交给页面提示稍后查看
  try {
    await cloud.call('queryOrder', { outTradeNo: order.outTradeNo })
  } catch (e) {
    console.warn('[pay] 主动查单失败', e.message)
  }
  for (let i = 0; i < 3; i++) {
    await sleep(1200)
    const ent = await cloud.call('getEntitlement').catch(() => null)
    if (ent && achieved(before, ent, product)) {
      onProgress('arrived')
      return { ok: true }
    }
  }

  // 钱可能已扣但到账延迟：不回滚、不重复发起，提示稍后查看
  return {
    ok: false,
    pending: true,
    message: '支付已成功，权益到账稍有延迟，请稍后到「我的」页查看',
  }
}

module.exports = { buyProduct }
