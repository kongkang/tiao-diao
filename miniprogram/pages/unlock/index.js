const page = require('../../utils/page.js')
const config = require('../../config.js')
const session = require('../../services/session.js')
const billing = require('../../services/billing.js')
const ad = require('../../services/ad.js')
const { fmtDurationChinese, fmtPitchLabel } = require('../../utils/format.js')

const LABELS = { free: '限时免费', balance: '额度下载', monthly: '包月下载' }

page({
  data: {
    song: null,
    durationText: '',
    pitchLabel: '',
    billing: null,
    entitlement: { free: true, monthly: false, minutes: 0, monthlyDaysLeft: 0 },
    selected: 'free',          // free | balance | monthly
    confirmText: '限时免费',
    rechargePriceText: '1',    // 60 分钟档价格（元）
    rechargeMinutes: 60,
    monthlyPriceText: '9.9',
  },

  async onLoad() {
    const song = session.getSong()
    if (!song) {
      wx.reLaunch({ url: '/pages/index/index' })
      return
    }
    const semitones = session.getSemitones()
    const b = billing.calcBilling(song.durationSec)
    const p60 = config.PRODUCTS.find(p => p.id === 'pkg_60') || { price: 100, minutes: 60 }
    const pMonth = config.PRODUCTS.find(p => p.id === 'pkg_month') || { price: 990 }

    // ⚠️ 同上：setData 只放显示字段，PCM 大数据留在 session（真机白屏根因）
    this.setData({
      song: { name: song.name },
      durationText: fmtDurationChinese(song.durationSec),
      pitchLabel: fmtPitchLabel(semitones),
      billing: b,
      rechargePriceText: String(p60.price / 100),
      rechargeMinutes: p60.minutes,
      monthlyPriceText: String(pMonth.price / 100),
    })

    await this.refreshEnt()
  },

  /** 权益实时刷新：从买分钟页返回时余额已变，onShow 必须重读。
   *  默认选中规则：包月 → 包月；有额度 → 额度；都没有 → 免费。 */
  async onShow() {
    if (!this.data.song) return // onLoad 早退（无歌）时不刷
    await this.refreshEnt()
  },

  async refreshEnt() {
    // 云端读不到时：PAY_ENABLED 且未开兜底免费 → 按「无权益」处理
    const fallback = config.PAY_ENABLED
      ? { free: false, monthly: false, minutes: 0, monthlyDaysLeft: 0, offline: true }
      : { free: true, monthly: false, minutes: 0, monthlyDaysLeft: 0 }
    const ent = await billing.getEntitlement().catch(() => fallback)

    let selected = 'free'
    if (!ent.free && ent.monthly) selected = 'monthly'
    else if (!ent.free && (ent.minutes || 0) > 0) selected = 'balance'

    this.setData({
      entitlement: ent,
      selected: selected,
      confirmText: LABELS[selected],
    })
  },

  onPick(e) {
    const selected = e.currentTarget.dataset.v
    if (!LABELS[selected]) return
    this.setData({ selected: selected, confirmText: LABELS[selected] })
  },

  onGoRecharge() {
    wx.navigateTo({ url: '/pages/buy/index?pick=pkg_60' })
  },

  onGoMonthly() {
    wx.navigateTo({ url: '/pages/buy/index?pick=pkg_month' })
  },

  /** 底部按钮：按当前选中的档位执行 */
  async onConfirm() {
    const selected = this.data.selected
    const bill = this.data.billing

    if (selected === 'free') {
      // 注意：这里不能套 wx.showLoading —— 演示/真实广告都会整屏接管制，
      // loading 遮罩会盖在广告页上面（真实广告 watchOne 内部自带超时兜底）
      const r = await ad.unlockByAd(bill.adCount)
      if (!r.ok) {
        if (r.reason === 'skipped') {
          wx.showModal({
            title: '视频还没看完',
            content: '要看完才能继续哦，再看一次可以吗？',
            confirmText: '再看一次',
            cancelText: '算了',
            success: res => { if (res.confirm) this.onConfirm() },
          })
        } else if (r.reason === 'daily_limit') {
          wx.showToast({ title: '今天的免费次数用完啦', icon: 'none' })
        }
        return
      }
      if (r.free) {
        wx.showToast({ title: '今天没有视频，这次免费帮你转', icon: 'none', duration: 2000 })
        session.setUnlockMode('free')
      } else {
        session.setUnlockMode('ad')
      }
      return this.gotoProcess()
    }

    if (selected === 'balance') {
      // 确认时重读权益（可能刚从买分钟页充值回来，或余额被并发扣减）
      const fallback = config.PAY_ENABLED
        ? { free: false, monthly: false, minutes: 0, offline: true }
        : this.data.entitlement
      const ent = await billing.getEntitlement().catch(() => fallback)
      this.setData({ entitlement: ent })
      if (ent.offline) {
        wx.showModal({
          title: '暂时连不上服务',
          content: '支付和余额现在查不到，请稍后再试。',
          showCancel: false,
          confirmText: '知道了',
        })
        return
      }
      if (ent.monthly) { // 期间刚买了包月：按包月放行
        session.setUnlockMode('monthly')
        return this.gotoProcess()
      }
      if (!ent.free && (ent.minutes || 0) >= bill.minutes) {
        session.setUnlockMode('pay')
        return this.gotoProcess()
      }
      wx.showModal({
        title: '额度不够',
        content: '当前余额 ' + (ent.minutes || 0) + ' 分钟，本次要 ' + bill.minutes +
          ' 分钟。限时优惠 ' + this.data.rechargePriceText + ' 元得 ' + this.data.rechargeMinutes + ' 分钟。',
        confirmText: '去充值',
        cancelText: '算了',
        success: res => { if (res.confirm) this.onGoRecharge() },
      })
      return
    }

    if (selected === 'monthly') {
      const fallback = config.PAY_ENABLED
        ? { free: false, monthly: false, minutes: 0, offline: true }
        : this.data.entitlement
      const ent = await billing.getEntitlement().catch(() => fallback)
      this.setData({ entitlement: ent })
      if (ent.offline) {
        wx.showModal({
          title: '暂时连不上服务',
          content: '支付和余额现在查不到，请稍后再试。',
          showCancel: false,
          confirmText: '知道了',
        })
        return
      }
      if (ent.monthly) {
        session.setUnlockMode('monthly')
        return this.gotoProcess()
      }
      wx.showModal({
        title: '包月下载',
        content: '30 天无限量，' + this.data.monthlyPriceText + ' 元。不用看视频，不用算分钟数。',
        confirmText: '去开通',
        cancelText: '算了',
        success: res => { if (res.confirm) this.onGoMonthly() },
      })
    }
  },

  gotoProcess() {
    wx.navigateTo({ url: '/pages/process/index' })
  },
})
