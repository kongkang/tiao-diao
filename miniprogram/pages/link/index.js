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
    parsed: null,      // { ref, platformName, title, cover, durationSec, durationText }
    slice: null,       // 视频太长时的选段:{ startMin, maxStartMin, fromMin, maxMin, takenText }
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
        this.setData({ urlText: text, parsed: null, slice: null })
        this.onParse()
      },
      fail: () => wx.showToast({ title: '读不到剪贴板', icon: 'none' }),
    })
  },

  onClear() {
    this.setData({ urlText: '', parsed: null, slice: null })
  },

  async onParse() {
    const text = this.data.urlText.trim()
    if (!text) return wx.showToast({ title: '先把链接粘进来', icon: 'none' })
    if (this.data.parsing) return
    this.setData({ parsing: true, parsed: null, slice: null })
    try {
      const r = await linkimport.parse(text)
      const maxSec = config.IMPORT_MAX_SEC
      this.setData({
        parsing: false,
        parsed: {
          ref: r.ref,
          platformName: r.platformName || '',
          title: r.title || '音频',
          cover: r.cover || '',
          durationSec: r.durationSec || 0,
          durationText: r.durationSec > 0 ? fmtDurationChinese(r.durationSec) : '',
        },
        // 视频比一段的上限还长:让用户选从第几分钟开始
        slice: r.durationSec > maxSec ? this.makeSlice(r.durationSec, 0) : null,
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

  /** 选段状态:从视频第 startMin 分钟处起,取 config.IMPORT_MAX_SEC 这么长 */
  makeSlice(durationSec, startMin) {
    const maxSec = config.IMPORT_MAX_SEC
    const maxStartMin = Math.max(0, Math.floor((durationSec - maxSec) / 60))   // 再往后就取不满一段了
    const s = Math.max(0, Math.min(startMin, maxStartMin))
    return {
      startMin: s,
      maxStartMin,
      fromMin: s + 1,
      maxMin: Math.round(maxSec / 60),
      takenText: fmtDurationChinese(Math.min(maxSec, durationSec - s * 60)),
    }
  },

  onSliceUp() {
    if (!this.data.slice || this.data.importing) return
    const p = this.data.parsed
    if (this.data.slice.startMin >= this.data.slice.maxStartMin) return
    this.setData({ slice: this.makeSlice(p.durationSec, this.data.slice.startMin + 1) })
  },

  onSliceDown() {
    if (!this.data.slice || this.data.importing) return
    const p = this.data.parsed
    if (this.data.slice.startMin <= 0) return
    this.setData({ slice: this.makeSlice(p.durationSec, this.data.slice.startMin - 1) })
  },

  showProgress(pr) {
    const title = pr.totalBytes > 0
      ? '正在提取音频 ' + Math.min(99, Math.round((pr.bytes / pr.totalBytes) * 100)) + '%'
      : '正在提取音频…'
    wx.showLoading({ title, mask: true })
  },

  /** 提取音频 → 确认手机能解出声音 → 灌进现有转调管线(pitch 页开始试听,付费在解锁页,口径不变) */
  async onImport() {
    const p = this.data.parsed
    if (!p || this.data.importing) return
    const startSec = this.data.slice ? this.data.slice.startMin * 60 : 0
    this.setData({ importing: true })
    this.showProgress({ bytes: 0, totalBytes: 0 })
    let stage = 'fetch'
    try {
      const r = await linkimport.fetchAudioToFile(p.ref, { startSec, maxSec: config.IMPORT_MAX_SEC }, pr => this.showProgress(pr))

      // 提取完还不算数:确认手机真的能把它解出声音。解不出就在这里拦下,不带坏文件进下一步
      stage = 'verify'
      wx.showLoading({ title: '正在确认音频', mask: true })
      const meta = r.meta || {}
      const song = await audioSvc.importSongFromPath(r.path, p.title, r.sizeBytes, { expectedSec: meta.durationSec })
      wx.hideLoading()
      // 视频太长只取了一段:在选调页标明是哪一段
      if (meta.mode === 'slice' || meta.startSec > 0) {
        song.sliceText = '视频第 ' + fmtDurationChinese(meta.startSec) + ' 起的一段'
      }
      session.setSong(song)
      this.setData({ importing: false })
      wx.navigateTo({ url: '/pages/pitch/index' })
    } catch (e) {
      wx.hideLoading()
      this.setData({ importing: false })
      this.showError(e, stage)
    }
  },

  /**
   * 取不了(云端拒绝 / 手机上解不出)就只给「知道了」;中断了才给「再试一次」(会从断点接着提)
   * stage = 'verify' 表示音频已经提取到了,是手机这边解不了 —— 再提一次也没用,
   * 除非是文件不完整或内存不足这种重试一次可能就好的
   */
  showError(e, stage) {
    const msg = (e && e.message) || '再试一次看看'
    const mayHelp = /不完整|内存不足|处理被中断/.test(msg)
    const final = stage === 'verify' ? !mayHelp : !!(e && e.final)
    wx.showModal({
      title: final ? (stage === 'verify' ? '提取到了，但手机上放不了' : '这个链接取不了') : '提取没成功',
      content: msg,
      showCancel: !final,
      confirmText: final ? '知道了' : '再试一次',
      cancelText: '返回',
      success: res => { if (!final && res.confirm) this.onImport() },
    })
  },
})
