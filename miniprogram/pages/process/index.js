const page = require('../../utils/page.js')
const session = require('../../services/session.js')
const engine = require('../../services/engine.js')
const fileSvc = require('../../services/file.js')
const audioSvc = require('../../services/audio.js')
const billing = require('../../services/billing.js')
const quality = require('../../services/quality.js')
const history = require('../../services/history.js')
const { fmtPitchLabel } = require('../../utils/format.js')

page({
  data: {
    percent: 0,
    indeterminate: false,
    estimateText: '',
    qualityText: '',
    longWarning: '',
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
    const q = quality.pickKbps(song.durationSec, 2, song.sampleRate)
    const estimateSec = quality.estimateProcessSec(song.durationSec, semitones)
    const sizeMB = q.estimatedBytes ? Math.max(1, Math.round(q.estimatedBytes / 1048576)) : 0

    this.setData({
      songName: song.name,
      pitchLabel: fmtPitchLabel(semitones),
      estimateText: quality.fmtEstimate(estimateSec),
      qualityText: q.reduced && !q.impossible
        ? '超长音频，将自动使用 ' + q.kbps + 'kbps（约 ' + sizeMB + 'MB）'
        : '',
      longWarning: song.durationSec > 600 ? '长音频处理时间较长，请保持小程序在前台' : '',
    })

    this.startRun()
  },

  async startRun() {
    const song = session.getSong()
    const semitones = session.getSemitones()
    this._running = true
    this._finished = false
    this.setData({ percent: 0, indeterminate: false })

    try {
      const s = await audioSvc.ensureSong(song)
      const q = quality.pickKbps(s.durationSec, 2, s.sampleRate)
      if (q.impossible) {
        throw new Error('这首歌转成 mp3 会超过微信单文件 100MB 上限，暂时无法生成')
      }

      const state = await fileSvc.beginResult(s.name, semitones, 'mp3')
      this._outState = state
      this._outStateDone = false

      try { wx.setKeepScreenOn({ keepScreenOn: true }) } catch (e) { /* */ }

      const res = await engine.process({
        token: s.token,
        semitones,
        kbps: q.kbps,
        onProgress: p => {
          if (!this._running) return
          if (p < 0) this.setData({ indeterminate: true })
          else this.setData({ percent: Math.min(99, p), indeterminate: false })
        },
        onMeta: m => {
          if (m && m.kbps && m.kbps !== q.kbps) {
            this.setData({ qualityText: '实际使用 ' + m.kbps + 'kbps' })
          }
        },
        onChunk: data => fileSvc.writeChunk(state, data),
      })

      const out = await fileSvc.finishResult(state)
      this._outStateDone = true
      this._outState = null
      this.setData({ percent: 100, indeterminate: false })

      // 处理成功后再扣费（失败不扣）。
      // 看广告解锁的已当场「支付」，不再扣分钟；包月/内测免费 consume 自然放行。
      if (session.getUnlockMode() !== 'ad') {
        const b = billing.calcBilling(s.durationSec)
        await billing.consume(b.minutes).catch(() => { /* 扣费失败不阻塞交付 */ })
      }

      // 记一笔转调历史（本地存储，上限 50 条）
      history.add({
        name: s.name,
        semitones,
        durationSec: Math.round(res.durationSec || s.durationSec),
        fileName: out.fileName,
      })

      session.setLastResult({
        path: out.path,
        fileName: out.fileName,
        name: s.name,
        semitones,
        bytes: out.bytes,
      })

      this._running = false
      this._finished = true
      try { wx.setKeepScreenOn({ keepScreenOn: false }) } catch (e) { /* */ }
      wx.redirectTo({ url: '/pages/result/index' })
    } catch (e) {
      this._running = false
      try { wx.setKeepScreenOn({ keepScreenOn: false }) } catch (e2) { /* */ }
      await this.cleanupPartial()
      this.handleError(e)
    }
  },

  async cleanupPartial() {
    const state = this._outState
    this._outState = null
    if (state && !this._outStateDone) {
      await fileSvc.discardResult(state).catch(() => { /* */ })
    }
  },

  handleError(e) {
    if (this._finished) return
    wx.showModal({
      title: '这次没成功',
      content: e.message || '处理时出了问题',
      confirmText: '再试一次',
      cancelText: '回去',
      success: res => {
        if (res.confirm) {
          this.setData({ percent: 0, indeterminate: false })
          this.startRun()
        } else {
          wx.navigateBack()
        }
      },
    })
  },

  onUnload() {
    this._running = false
    engine.abort()
    try { wx.setKeepScreenOn({ keepScreenOn: false }) } catch (e) { /* */ }
    if (this._outState && !this._outStateDone) {
      const state = this._outState
      this._outState = null
      fileSvc.discardResult(state).catch(() => { /* */ })
    }
  },
})
