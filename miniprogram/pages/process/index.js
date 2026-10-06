const page = require('../../utils/page.js')
const config = require('../../config.js')
const session = require('../../services/session.js')
const engine = require('../../services/engine.js')
const fileSvc = require('../../services/file.js')
const audioSvc = require('../../services/audio.js')
const billing = require('../../services/billing.js')
const history = require('../../services/history.js')
const { fmtPitchLabel } = require('../../utils/format.js')

page({
  data: {
    percent: 0,
    estimateText: '',
    songName: '',
    pitchLabel: '',
    minutes: 0,
  },

  onLoad() {
    const song = session.getSong()
    if (!song) {
      wx.reLaunch({ url: '/pages/index/index' })
      return
    }
    const semitones = session.getSemitones()
    const b = billing.calcBilling(song.durationSec)

    this.setData({
      songName: song.name,
      pitchLabel: fmtPitchLabel(semitones),
      estimateText: song.durationSec > 240 ? '20~40 秒' : '10~20 秒',
    })

    this.startRun()
  },

  async startRun() {
    const song = session.getSong()
    const semitones = session.getSemitones()

    try {
      const s = await audioSvc.ensureSong(song)

      const res = await engine.process({
        token: s.token,
        semitones,
        encode: config.ENCODE,
        onProgress: p => this.setData({ percent: Math.min(99, p) }),
      })

      this.setData({ percent: 100 })

      // 写结果文件（文件名：【小程序名-升N半音】原名.后缀）
      const out = await fileSvc.writeResult(s.name, semitones, res.data, res.ext)

      // 处理成功后再扣费（失败不扣）
      const b = billing.calcBilling(s.durationSec)
      await billing.consume(b.minutes).catch(() => { /* 扣费失败不阻塞交付 */ })

      // 记一笔转调历史（本地存储，上限 50 条）
      history.add({
        name: s.name,
        semitones,
        durationSec: s.durationSec,
        fileName: out.fileName,
      })

      session.setLastResult({
        path: out.path,
        fileName: out.fileName,
        name: s.name,
        semitones,
      })

      wx.redirectTo({ url: '/pages/result/index' })
    } catch (e) {
      this.handleError(e)
    }
  },

  handleError(e) {
    wx.showModal({
      title: '这次没成功',
      content: e.message || '处理时出了问题',
      confirmText: '再试一次',
      cancelText: '回去',
      success: res => {
        if (res.confirm) {
          this.setData({ percent: 0 })
          this.startRun()
        } else {
          wx.navigateBack()
        }
      },
    })
  },

  onUnload() {
    // 用户中途返回：终止 Worker，释放内存
    engine.abort()
  },
})
