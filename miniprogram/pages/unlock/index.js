const page = require('../../utils/page.js')
const session = require('../../services/session.js')
const billing = require('../../services/billing.js')
const ad = require('../../services/ad.js')
const { fmtDurationChinese } = require('../../utils/format.js')

page({
  data: {
    song: null,
    durationText: '',
    pitchLabel: '',
    billing: null,
    entitlement: { free: true },
    selected: 'ad',
    confirmText: '开始看视频',
    adTimeText: '',
  },

  async onLoad() {
    const song = session.getSong()
    if (!song) {
      wx.reLaunch({ url: '/pages/index/index' })
      return
    }
    const semitones = session.getSemitones()
    const b = billing.calcBilling(song.durationSec)
    const ent = await billing.getEntitlement().catch(() => ({ free: true }))

    // ⚠️ 同上：setData 只放显示字段，PCM 大数据留在 session（真机白屏根因）
    this.setData({
      song: { name: song.name },
      durationText: fmtDurationChinese(song.durationSec),
      pitchLabel: fmtPitchLabel(semitones),
      billing: b,
      entitlement: ent,
      adTimeText: b.adCount === 1 ? '30 秒' : (b.adCount === 2 ? '1 分钟' : '1 分半'),
    })
    this.updateConfirmText()

    // 包月用户直接放行
    if (!ent.free && ent.monthly) this.setData({ selected: 'monthly' })
  },

  updateConfirmText() {
    const { selected, billing } = this.data
    let text = '开始看视频'
    if (selected === 'pay') text = '付 ¥' + billing.priceYuan + ' 直接转'
    if (selected === 'monthly') text = '包月畅用，直接转'
    this.setData({ confirmText: text })
  },

  onPick(e) {
    this.setData({ selected: e.currentTarget.dataset.v })
    this.updateConfirmText()
  },

  onGoMonthly() {
    wx.navigateTo({ url: '/pages/buy/index' })
  },

  /** 正式版确认：按所选方式解锁 */
  async onConfirm() {
    const { selected, billing } = this.data
    if (selected === 'monthly') return this.gotoProcess()

    if (selected === 'ad') {
      wx.showLoading({ title: '正在加载视频', mask: true })
      const r = await ad.unlockByAd(billing.adCount)
      wx.hideLoading()
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
      }
      return this.gotoProcess()
    }

    if (selected === 'pay') {
      const ent = this.data.entitlement
      if (!ent.free && ent.minutes < billing.minutes) {
        wx.showModal({
          title: '分钟数不够了',
          content: '你还剩 ' + ent.minutes + ' 分钟，这首歌要 ' + billing.minutes + ' 分钟',
          confirmText: '去买分钟',
          cancelText: '算了',
          success: res => { if (res.confirm) this.onGoMonthly() },
        })
        return
      }
      return this.gotoProcess()
    }
  },

  /** 内测：直接开始 */
  onStartFree() { this.gotoProcess() },

  gotoProcess() {
    wx.navigateTo({ url: '/pages/process/index' })
  },
})
