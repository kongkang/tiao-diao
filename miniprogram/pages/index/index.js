const page = require('../../utils/page.js')
const audio = require('../../services/audio.js')
const session = require('../../services/session.js')
const billing = require('../../services/billing.js')
const identity = require('../../services/identity.js')
const history = require('../../services/history.js')
const { fmtPitchLabel, fmtDateTime } = require('../../utils/format.js')

// 管理员隐藏手势：3 秒内连点 🎵 图标 5 次，解锁本地管理员模式
const ADMIN_TAP_NEED = 5
const ADMIN_TAP_WINDOW_MS = 3000

page({
  data: {
    entitlement: null,
    historyList: [],
    isAdmin: false,
    me: {}, // 登录资料（头像/称呼），空对象=未登录
  },

  onShow() {
    // 查权益（内测模式返回 free:true，余额条隐藏、显示内测横幅）
    billing.getEntitlement()
      .then(ent => this.setData({ entitlement: ent }))
      .catch(() => this.setData({ entitlement: { free: true } }))

    // 转调历史（本地，最多显示最近 5 条；全量在管理页/我的页）
    this.setData({
      historyList: history.list().slice(0, 5).map(r => Object.assign({}, r, {
        timeText: fmtDateTime(r.ts),
        pitchLabel: fmtPitchLabel(r.semitones),
      })),
      isAdmin: identity.isAdmin(),
      me: identity.getProfile() || {},
    })
  },

  async onChoose() {
    try {
      const song = await audio.loadSong()
      session.setSong(song)
      wx.navigateTo({ url: '/pages/pitch/index' })
    } catch (e) {
      const msg = e.message || ''
      if (msg.indexOf('没有选择文件') > -1 || msg.indexOf('cancel') > -1) return // 用户取消，不打扰
      wx.showModal({
        title: '打不开这首歌',
        content: msg,
        showCancel: false,
        confirmText: '知道了',
      })
    }
  },

  /** 🎵 图标连点 5 次 → 解锁本地管理员（普通用户发现不了，也不影响使用） */
  onHeroTap() {
    const now = Date.now()
    if (!this._tapTimes) this._tapTimes = []
    this._tapTimes = this._tapTimes.filter(t => now - t < ADMIN_TAP_WINDOW_MS)
    this._tapTimes.push(now)
    if (this._tapTimes.length >= ADMIN_TAP_NEED) {
      this._tapTimes = []
      if (identity.isAdmin()) return // 已经是，不重复提示
      identity.unlockAdminLocal()
      this.setData({ isAdmin: true })
      wx.showToast({ title: '管理员模式已开启', icon: 'none' })
    }
  },

  onGoAdmin() {
    wx.navigateTo({ url: '/pages/admin/index' })
  },

  /** 左上角头像 → 我的页（登录/资料/权益/历史） */
  onGoMe() {
    wx.navigateTo({ url: '/pages/me/index' })
  },
})
