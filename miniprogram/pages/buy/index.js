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
    buying: false,
  },

  async onLoad() {
    const ent = await billing.getEntitlement().catch(() => null)
    this.setData({ entitlement: ent })
  },

  onPick(e) {
    this.setData({ selected: e.currentTarget.dataset.id })
  },

  onBetaTap() {
    wx.showToast({ title: '内测期间全部免费', icon: 'none' })
  },

  async onBuy() {
    if (!config.PAY_ENABLED) { this.onBetaTap(); return }
    if (this.data.buying) return
    const product = config.PRODUCTS.find(p => p.id === this.data.selected)
    if (!product) return

    this.setData({ buying: true })
    wx.showLoading({ title: '正在支付', mask: true })
    try {
      const r = await pay.buyProduct(product)
      wx.hideLoading()
      if (r.free) return // 内测模式已提示
      if (r.ok) {
        wx.showToast({ title: '购买成功', icon: 'success' })
        const ent = await billing.getEntitlement().catch(() => null)
        this.setData({ entitlement: ent })
      }
    } catch (e) {
      wx.hideLoading()
      const msg = e.errMsg || e.message || ''
      if (msg.indexOf('cancel') > -1) return
      wx.showToast({ title: '支付没成功，再试一次', icon: 'none' })
    } finally {
      this.setData({ buying: false })
    }
  },
})
