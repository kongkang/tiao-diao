const page = require('../../utils/page.js')
const config = require('../../config.js')
const linkimport = require('../../services/linkimport.js')
const audioSvc = require('../../services/audio.js')
const session = require('../../services/session.js')
const { fmtDurationChinese } = require('../../utils/format.js')

page({
  data: {
    enabled: !!config.LINK_IMPORT_ENABLED,
    urlText: '',
    parsing: false,
    parsed: null,      // { platformName, title, cover, durationText }
    importing: false,
  },

  onInput(e) {
    this.setData({ urlText: e.detail.value })
  },

  /** 粘贴即解析：少一步是一步 */
  onPaste() {
    wx.getClipboardData({
      success: res => {
        const text = (res.data || '').trim()
        if (!text) return wx.showToast({ title: '剪贴板是空的', icon: 'none' })
        this.setData({ urlText: text, parsed: null })
        this.onParse()
      },
      fail: () => wx.showToast({ title: '读不到剪贴板', icon: 'none' }),
    })
  },

  onClear() {
    this.setData({ urlText: '', parsed: null })
  },

  async onParse() {
    const text = this.data.urlText.trim()
    if (!text) return wx.showToast({ title: '先把链接粘进来', icon: 'none' })
    if (this.data.parsing) return
    this.setData({ parsing: true, parsed: null })
    try {
      const r = await linkimport.parse(text)
      this.setData({
        parsing: false,
        parsed: {
          ref: r.ref,
          platformName: r.platformName || '',
          title: r.title || '音频',
          cover: r.cover || '',
          durationText: r.durationSec > 0 ? fmtDurationChinese(r.durationSec) : '',
        },
      })
    } catch (e) {
      this.setData({ parsing: false })
      wx.showModal({
        title: '没解析出来',
        content: e.message || '网络开小差了,再试一次',
        showCancel: false,
        confirmText: '知道了',
      })
    }
  },

  /** 提取音频 → 本地 → 灌进现有转调管线(pitch 页开始试听,付费在解锁页,口径不变) */
  async onImport() {
    const p = this.data.parsed
    if (!p || this.data.importing) return
    this.setData({ importing: true })
    wx.showLoading({ title: '正在提取音频…', mask: true })
    try {
      const r = await linkimport.fetchAudioToFile(p.ref, pr => {
        const title = pr.totalBytes > 0
          ? '正在提取音频 ' + Math.min(99, Math.round((pr.bytes / pr.totalBytes) * 100)) + '%'
          : '已提取 ' + Math.round(pr.bytes / 1024) + 'KB'
        wx.showLoading({ title, mask: true })
      })
      wx.hideLoading()
      this.setData({ importing: false })
      // 真正的时长/格式以本地解码为准,后面的计费口径和本地选歌完全一致
      const song = await audioSvc.importSongFromPath(r.path, p.title, r.sizeBytes)
      session.setSong(song)
      wx.navigateTo({ url: '/pages/pitch/index' })
    } catch (e) {
      wx.hideLoading()
      this.setData({ importing: false })
      wx.showModal({
        title: '提取没成功',
        content: e.message || '再试一次看看',
        confirmText: '再试一次',
        cancelText: '返回',
        success: res => { if (res.confirm) this.onImport() },
      })
    }
  },
})
