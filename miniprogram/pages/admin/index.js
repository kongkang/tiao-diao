// 管理页 —— 本地版（2026-10-06）
// 入口：首页 🎵 图标连点 5 次解锁（本地模式）；
//       或 openid 命中 config.ADMIN_OPENIDS 白名单（云模式，部署后自动生效）。
// 功能：身份查看 / 权益模拟（提前联调订阅流程）/ 转调历史 / 开关状态。

const page = require('../../utils/page.js')
const config = require('../../config.js')
const identity = require('../../services/identity.js')
const history = require('../../services/history.js')
const billing = require('../../services/billing.js')
const ad = require('../../services/ad.js')
const { fmtPitchLabel, fmtDurationChinese, fmtDateTime } = require('../../utils/format.js')

page({
  data: {
    user: null,
    isAdmin: false,
    adminByWhitelist: false,
    entitlement: null,
    historyList: [],
    flags: null,
    sdkVersion: '',
    adSim: false,
  },

  onLoad() {
    let sdk = ''
    try { sdk = wx.getAppBaseInfo().SDKVersion || '' } catch (e) { /* 低版本兜底 */ }
    this.setData({
      flags: {
        AD_ENABLED: config.AD_ENABLED,
        PAY_ENABLED: config.PAY_ENABLED,
        CLOUD_LOGIN_ENABLED: config.CLOUD_LOGIN_ENABLED,
        ENCODE: config.ENCODE,
        whitelistCount: (config.ADMIN_OPENIDS || []).length,
      },
      sdkVersion: sdk,
    })
    this.refresh()
  },

  onShow() {
    this.refresh()
  },

  refresh() {
    const user = identity.getUser()
    const ent = billing.readLocalEnt()
    this.setData({
      user: Object.assign({}, user, { firstLaunchText: fmtDateTime(user.firstLaunchAt) }),
      isAdmin: identity.isAdmin(),
      adminByWhitelist: !!user.openid &&
        (config.ADMIN_OPENIDS || []).indexOf(user.openid) > -1,
      entitlement: ent,
      entText: ent.free ? '内测免费（默认）'
        : ent.monthly ? '包月用户（模拟）· 还剩 ' + ent.monthlyDaysLeft + ' 天'
        : '普通用户 · 余额 ' + ent.minutes + ' 分钟',
      historyList: history.list().map(r => Object.assign({}, r, {
        timeText: fmtDateTime(r.ts),
        pitchLabel: fmtPitchLabel(r.semitones),
        durationText: fmtDurationChinese(r.durationSec),
      })),
      adSim: ad.isSimEnabled(),
    })
  },

  // ---- 广告演示 ----
  onToggleAdSim() {
    const next = ad.setSimEnabled(!ad.isSimEnabled())
    this.refresh()
    wx.showToast({ title: next ? '演示广告已开启' : '演示广告已关闭', icon: 'none' })
  },

  onCopy(e) {
    const v = e.currentTarget.dataset.v
    if (!v) return
    wx.setClipboardData({ data: String(v) })
  },

  // ---- 权益模拟 ----
  onSimFree() {
    billing.resetLocalEnt()
    this.refresh()
    wx.showToast({ title: '已恢复内测免费', icon: 'none' })
  },
  onSimNormal() {
    billing.writeLocalEnt({ free: false, monthly: false, minutes: 0 })
    this.refresh()
    wx.showToast({ title: '已模拟普通用户', icon: 'none' })
  },
  onSimMinutes() {
    billing.writeLocalEnt({ free: false, monthly: false, minutes: 30 })
    this.refresh()
    wx.showToast({ title: '已模拟 30 分钟余额', icon: 'none' })
  },
  onSimMonthly() {
    billing.writeLocalEnt({
      free: false, monthly: true, minutes: 0,
      monthlyUntil: Date.now() + 30 * 86400000,
    })
    this.refresh()
    wx.showToast({ title: '已模拟包月用户', icon: 'none' })
  },

  // ---- 历史 ----
  onClearHistory() {
    wx.showModal({
      title: '清空历史记录？',
      content: '只清记录，不影响其他功能',
      confirmText: '清空',
      cancelText: '算了',
      success: res => {
        if (!res.confirm) return
        history.clear()
        this.refresh()
      },
    })
  },

  // ---- 管理员模式 ----
  onLockAdmin() {
    if (this.data.adminByWhitelist) {
      wx.showToast({ title: '白名单管理员无法退出', icon: 'none' })
      return
    }
    identity.lockAdminLocal()
    wx.showModal({
      title: '已退出管理员模式',
      content: '首页的管理入口已隐藏。连点首页 🎵 图标 5 次可重新开启。',
      showCancel: false,
      success: () => wx.navigateBack(),
    })
  },
})
