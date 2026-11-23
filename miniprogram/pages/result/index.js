const page = require('../../utils/page.js')
const session = require('../../services/session.js')
const fileSvc = require('../../services/file.js')

function fmtTime(sec) {
  const s = Math.floor(sec)
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0')
}

page({
  data: {
    result: null,
    imported: false,   // 链接导入的歌：结果页多一个「发原曲」（本次已付费，不另扣）
    playing: false,
    progress: 0,
    timeText: '0:00',
  },

  onLoad() {
    const result = session.getLastResult()
    if (!result) {
      wx.reLaunch({ url: '/pages/index/index' })
      return
    }
    const song = session.getSong()
    this.setData({ result, imported: !!(song && song.imported) })

    this.player = wx.createInnerAudioContext()
    this.player.src = result.path
    this.player.onEnded(() => this.setData({ playing: false, progress: 0, timeText: '0:00' }))
    this.player.onTimeUpdate(() => {
      const p = this.player.currentTime || 0
      const d = this.player.duration || 1
      this.setData({ progress: (p / d) * 100, timeText: fmtTime(p) })
    })
    this.player.onError(() => {
      wx.showToast({ title: '播放失败，但文件已生成，直接发送即可', icon: 'none' })
      this.setData({ playing: false })
    })
  },

  onPlayToggle() {
    if (this.data.playing) {
      this.player.pause()
      this.setData({ playing: false })
    } else {
      this.player.play()
      this.setData({ playing: true })
    }
  },

  async onShare() {
    try {
      const r = await fileSvc.shareResult(this.data.result.path, this.data.result.fileName)
      if (r !== 'cancel') {
        wx.showModal({
          title: '发出去了',
          content: '回到微信，长按那条音乐，点「保存」就到手机里了。',
          showCancel: false,
          confirmText: '知道了',
        })
      }
    } catch (e) {
      wx.showToast({ title: e.message || '发送失败', icon: 'none' })
    }
  },

  /** 链接导入的原曲：随本次下载一起解锁，不重复扣费 */
  async onShareOriginal() {
    const song = session.getSong()
    if (!song || !song.path) return
    const name = (song.name || '原曲') + '.' + (song.format || 'mp3')
    try {
      const r = await fileSvc.shareResult(song.path, name)
      if (r !== 'cancel') {
        wx.showToast({ title: '发出去了，长按那条音频就能保存', icon: 'none', duration: 2500 })
      }
    } catch (e) {
      const msg = /exist|not find|not found/i.test(e.message || '')
        ? '原曲的临时文件被系统清掉了，重新导入一次就好'
        : (e.message || '发送失败')
      wx.showToast({ title: msg, icon: 'none', duration: 2500 })
    }
  },

  onNewSong() {
    wx.reLaunch({ url: '/pages/index/index' })
  },

  /** 换个调重转：同一首歌回选调页，30 分钟内不重复扣费（M0 内测免费） */
  onRetry() {
    wx.reLaunch({ url: '/pages/pitch/index' })
  },

  onUnload() {
    if (this.player) {
      try { this.player.stop(); this.player.destroy() } catch (e) { /* */ }
      this.player = null
    }
  },
})
