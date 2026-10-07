// 我的页 —— 极简设计（目标用户：老年京剧票友）
// 原则：少文字、大图标、大数字。本地用户 ID / openid 等技术信息只在管理页看。
// 登录 = 点头像（微信官方「选头像」能力，一步完成）；称呼可后补，默认「歌友」。

const page = require('../../utils/page.js')
const config = require('../../config.js')
const identity = require('../../services/identity.js')
const history = require('../../services/history.js')
const billing = require('../../services/billing.js')
const { fmtPitchLabel, fmtDateTime } = require('../../utils/format.js')

const HIS_SHOW = 10 // 本页最多展示条数（全量在管理页）

page({
  data: {
    me: null,            // { avatarUrl, nickname } 或 null=未登录
    ent: { free: true },
    songsLeft: 0,
    historyList: [],
    historyTotal: 0,
    isAdmin: false,
    editingName: false,
    nickname: '',
    appName: config.APP_NAME,
  },

  onShow() {
    const profile = identity.getProfile()
    const ent = billing.readLocalEnt()
    this.setData({
      me: profile,
      ent,
      songsLeft: Math.max(1, Math.round(ent.minutes / 5)),
      historyList: history.list().slice(0, HIS_SHOW).map(r => Object.assign({}, r, {
        timeText: fmtDateTime(r.ts),
        pitchLabel: fmtPitchLabel(r.semitones),
      })),
      historyTotal: history.list().length,
      isAdmin: identity.isAdmin(),
    })
  },

  /** 选完微信头像：一步登录（称呼默认「歌友」，可再改） */
  async onChooseAvatar(e) {
    const tempPath = e && e.detail && e.detail.avatarUrl
    if (!tempPath) return
    wx.showLoading({ title: '正在登录', mask: true })
    const profile = await identity.saveProfile({ avatarTempPath: tempPath })
    wx.hideLoading()
    this.setData({ me: profile, editingName: !profile.nickname || profile.nickname === '歌友' })
    if (this.data.editingName) {
      this.setData({ nickname: '' })
      wx.showToast({ title: '登录成功', icon: 'success' })
    } else {
      wx.showToast({ title: '头像已更新', icon: 'success' })
    }
  },

  /** 点名字 → 展开「改称呼」 */
  onEditName() {
    if (!this.data.me) return
    this.setData({ editingName: true, nickname: this.data.me.nickname === '歌友' ? '' : this.data.me.nickname })
  },

  onNickInput(e) { this.setData({ nickname: e.detail.value }) },

  async onSaveName() {
    const profile = await identity.saveProfile({ nickname: this.data.nickname })
    this.setData({ me: profile, editingName: false })
    wx.showToast({ title: '称呼已改好', icon: 'success' })
  },

  /** 权益卡：付费态点击 → 买分钟（内测为模拟支付）；内测免费态无操作 */
  onTapEnt() {
    if (this.data.ent.free) return
    wx.navigateTo({ url: '/pages/buy/index' })
  },

  onGoAdmin() {
    wx.navigateTo({ url: '/pages/admin/index' })
  },

  onLogout() {
    wx.showModal({
      title: '退出登录？',
      content: '转歌记录和剩余分钟都还在，只退出头像和称呼',
      confirmText: '退出',
      cancelText: '算了',
      success: res => {
        if (!res.confirm) return
        identity.clearProfile()
        this.onShow()
      },
    })
  },
})
