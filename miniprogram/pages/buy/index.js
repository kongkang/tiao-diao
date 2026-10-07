const page = require('../../utils/page.js')
const config = require('../../config.js')
const billing = require('../../services/billing.js')
const pay = require('../../services/pay.js')

page({
  data: {
    products: config.PRODUCTS,
    selected: 'pkg_30',
    entitlement: null,
    needMinutes: 0,
    payEnabled: config.PAY_ENABLED,
    canBuy: false,     // 正式支付开 或 处于付费用户态（内测模拟）时才可买
    buying: false,
  },

  async onLoad() {
    await this.refreshEnt()
  },

  /** 权益实时刷新（充值后回到本页、或从解锁页再进来都要重读） */
  async onShow() {
    await this.refreshEnt()
  },

  async refreshEnt() {
    const ent = await billing.getEntitlement().catch(() => null)
    this.setData({
      entitlement: ent,
      canBuy: config.PAY_ENABLED || !!(ent && !ent.free),
    })
  },

  onPick(e) {
    this.setData({ selected: e.currentTarget.dataset.id })
  },

  onBetaTap() {
    wx.showToast({ title: '内测期间全部免费', icon: 'none' })
  },

  async onBuy() {
    if (!this.data.canBuy) { this.onBetaTap(); return }
    if (this.data.buying) return
    const product = config.PRODUCTS.find(p => p.id === this.data.selected)
    if (!product) return

    this.setData({ buying: true })
    // 模拟支付走 showModal 确认，套 loading 会盖住确认框，只在真实支付时用
    if (config.PAY_ENABLED) wx.showLoading({ title: '正在支付', mask: true })
    try {
      const r = await pay.buyProduct(product)
      wx.hideLoading()
      if (r.free) return // 内测免费模式已提示
      if (r.ok) {
        wx.showToast({
          title: r.simulated ? '已到账（模拟支付）' : '购买成功',
          icon: 'success',
          duration: 2000,
        })
        await this.refreshEnt()
      }
    } catch (e) {
      wx.hideLoading()
      const msg = e.errMsg || e.message || ''
      if (msg.indexOf('cancel') > -1) return // 用户取消，不打扰
      wx.showToast({ title: '支付没成功，再试一次', icon: 'none' })
    } finally {
      this.setData({ buying: false })
    }
  },
})
