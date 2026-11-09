const page = require('../../utils/page.js')
const config = require('../../config.js')
const billing = require('../../services/billing.js')
const pay = require('../../services/pay.js')

page({
  data: {
    products: config.PRODUCTS,
    selected: 'pkg_60',
    entitlement: null,
    needMinutes: 0,
    payEnabled: config.PAY_ENABLED,
    canBuy: false,     // 正式支付开 或 处于付费用户态（内测模拟）时才可买
    buying: false,

    // 支付等待 / 到账庆祝
    paying: false,
    payStatusTitle: '正在确认支付结果',
    payStatusSub: '请在支付窗口完成付款',
    paySuccess: false,
    successTitle: '',
    successAmount: '',
    successSub: '',
    payPending: false,
    pendingMessage: '',
  },

  async onLoad(options) {
    // 从解锁页「去充值/去开通」进来时预选对应商品
    const pick = options && options.pick
    if (pick && config.PRODUCTS.some(p => p.id === pick)) {
      this.setData({ selected: pick })
    }
    await this.refreshEnt()
  },

  /** 权益实时刷新（充值后回到本页、或从解锁页再进来都要重读） */
  async onShow() {
    await this.refreshEnt()
  },

  async refreshEnt() {
    const ent = await billing.getEntitlement().catch(() => null)
    // 真实支付：只有云端权益读成功才允许下单（readEnt 兜底返回 offline 时禁用）
    // 内测模拟：本地付费态才允许走模拟支付
    const canBuy = config.PAY_ENABLED
      ? !!(ent && !ent.offline)
      : !!(ent && !ent.free)
    this.setData({ entitlement: ent, canBuy })
  },

  onPick(e) {
    this.setData({ selected: e.currentTarget.dataset.id })
  },

  onBetaTap() {
    const title = config.PAY_ENABLED ? '支付服务连接中，请稍后再试' : '内测期间全部免费'
    wx.showToast({ title: title, icon: 'none' })
  },

  /** 支付等待进度：确认支付 → 更新权益 → 到账 */
  setPayStage(stage) {
    const map = {
      paying: ['正在确认支付结果', '请在支付窗口完成付款'],
      confirming: ['正在确认支付结果', '已收到付款，马上为您更新权益'],
      delivering: ['正在更新你的权益', '请稍候，不要关闭页面'],
      arrived: ['已到账', '正在刷新你的权益…'],
    }
    const item = map[stage] || map.confirming
    this.setData({ payStatusTitle: item[0], payStatusSub: item[1] })
  },

  noop() {},

  async onBuy() {
    if (!this.data.canBuy) { this.onBetaTap(); return }
    if (this.data.buying) return
    const product = config.PRODUCTS.find(p => p.id === this.data.selected)
    if (!product) return

    const real = config.PAY_ENABLED
    this.setData({
      buying: true,
      paying: real,           // 内测模拟走 showModal，不盖支付确认框
      paySuccess: false,
      payPending: false,
      payStatusTitle: '正在确认支付结果',
      payStatusSub: '请在支付窗口完成付款',
    })
    try {
      const r = await pay.buyProduct(product, {
        onProgress: (stage) => this.setPayStage(stage),
      })
      if (r.free) { this.setData({ paying: false }); return }
      if (r.cancelled) { this.setData({ paying: false }); return }

      if (r.ok) {
        if (r.simulated) {
          this.setData({ paying: false })
          wx.showToast({ title: '已到账（模拟支付）', icon: 'success', duration: 2000 })
          await this.refreshEnt()
          return
        }
        // 权益已确认到账，才切庆祝动画；用户点「开心收下」才收起
        this.setData({
          paying: false,
          paySuccess: true,
          successTitle: product.monthly ? '包月已开通' : '充值成功',
          successAmount: product.monthly ? '30 天无限量' : '+' + product.minutes + ' 分钟',
          successSub: product.monthly
            ? '尊贵的包月用户，30 天随便转 ✨'
            : '尊贵的付费用户，权益已到账 ✨',
        })
        await this.refreshEnt()
        return
      }

      if (r.pending) {
        this.setData({
          paying: false,
          payPending: true,
          pendingMessage: r.message || '支付已成功，权益到账稍有延迟，请稍后刷新',
        })
      }
    } catch (e) {
      this.setData({ paying: false })
      const msg = (e && (e.message || e.errMsg)) || ''
      if (/cancel/i.test(msg)) return // 用户取消，不打扰
      wx.showToast({ title: msg || '支付没成功，再试一次', icon: 'none', duration: 3000 })
    } finally {
      this.setData({ buying: false })
    }
  },

  onSuccessClose() {
    this.setData({ paySuccess: false })
    this.refreshEnt()
  },

  /** 支付完成后的主操作：返回上一页（通常是解锁/下载页） */
  onSuccessBack() {
    this.setData({ paySuccess: false, payPending: false })
    wx.navigateBack({
      delta: 1,
      fail: () => wx.reLaunch({ url: '/pages/index/index' }),
    })
  },

  onPendingRefresh() {
    this.setData({ payPending: false })
    this.refreshEnt()
    wx.showToast({ title: '已刷新', icon: 'none' })
  },
})
