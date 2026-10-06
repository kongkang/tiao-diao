const page = require('../../utils/page.js')
const config = require('../../config.js')
const session = require('../../services/session.js')
const engine = require('../../services/engine.js')
const audioSvc = require('../../services/audio.js')
const { fmtDurationChinese, fmtPitchLabel } = require('../../utils/format.js')

/** 秒 → "0:15" / "4:12" 播放器时钟 */
function fmtClock(sec) {
  const s = Math.max(0, Math.round(sec))
  return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2)
}

page({
  data: {
    song: null,
    durationText: '',
    durationFloor: 0,      // 滑杆上限 = 整首歌秒数
    semitones: 2,
    semitonesDisplay: '+2',
    pitchLabel: '升 2 个半音',
    // 播放器状态：idle 未在播 | processing 正在调 | playing 播放中 | paused 已暂停
    playState: 'idle',
    statusText: '点 ▶ 先听 15 秒',
    previewStart: 0,       // 播放指针（秒，整首歌里的位置）
    playPercent: 0,
    playTimeText: '0:00',
    playTotalText: '0:00',
  },

  onLoad() {
    const song = session.getSong()
    if (!song) {
      wx.reLaunch({ url: '/pages/index/index' })
      return
    }
    // ⚠️ 只把界面要显示的字段放进 setData（song 里除名字/声道外还有 token 等，整塞无益）
    this._durationSec = song.durationSec
    this.setData({
      song: { name: song.name, channels: song.channels },
      durationText: fmtDurationChinese(song.durationSec),
      durationFloor: Math.max(1, Math.floor(song.durationSec)),
      playTotalText: fmtClock(song.durationSec),
    })
    this.updateSemitones(session.getSemitones() || 2, true)
  },

  /** 播放器状态 + 顶部一句人话提示，集中在这改 */
  setPlayState(state) {
    const map = {
      idle: this._hasPreviewed ? '点 ▶ 接着听 15 秒' : '点 ▶ 先听 15 秒',
      processing: '正在帮你调调…',
      playing: '正在听（' + this.data.pitchLabel + '）',
      paused: '暂停了，点 ▶ 接着听',
    }
    this.setData({ playState: state, statusText: map[state] })
  },

  updateSemitones(n, silent) {
    n = Math.max(-12, Math.min(12, n))
    this.setData({
      semitones: n,
      semitonesDisplay: (n > 0 ? '+' : '') + n,
      pitchLabel: fmtPitchLabel(n),
    })
    // 播放中的状态文案带调级，跟着刷新
    if (this.data.playState === 'playing') this.setPlayState('playing')
    if (!silent) this.onTuneChanged()
  },

  /** 改调/拖进度条共用：立即停旧声 → 全局 loading 倒计时 → 防抖 0.8s 重唱 */
  onTuneChanged() {
    if (!this._hasPreviewed) return // 还没主动听过，不自动出声（避免惊吓）
    // 作废旧请求：它在播放/在等 Worker 都直接掐掉，收尾静默退场
    this._previewSeq = (this._previewSeq || 0) + 1
    this._playStarted = false
    audioSvc.stopPreview()
    this.stopProgressTicker()
    this.setPlayState('processing')
    this.startCountdown()
    clearTimeout(this._previewTimer)
    this._previewTimer = setTimeout(() => this.doPreviewSafe(), 800)
  },

  /** 全局 loading + 倒计时：有实测耗时就按实测×1.5 估，首次用 10s 冗余时长（一般 5~6s） */
  startCountdown() {
    this.stopCountdown()
    let left = this._lastCostMs
      ? Math.min(15, Math.max(3, Math.ceil((this._lastCostMs / 1000) * 1.5)))
      : 10
    const show = () => wx.showLoading({
      title: left > 0 ? '正在帮你调调，稍等 ' + left + 's' : '马上就好',
      mask: false,
    })
    show()
    this._countdownTimer = setInterval(() => { left -= 1; show() }, 1000)
  },

  stopCountdown() {
    clearInterval(this._countdownTimer)
    this._countdownTimer = null
    wx.hideLoading()
  },

  /** 进度条拖动中：只动指针和时钟，不打断播放（松手才算数） */
  onSeeking(e) {
    this._seeking = true
    const v = Number(e.detail.value) || 0
    this.setData({ previewStart: v, playTimeText: fmtClock(v) })
  },

  /** 松手落定：拖的是整首歌的进度条，从落点听 15 秒 */
  onSeek(e) {
    this._seeking = false
    const v = Number(e.detail.value) || 0
    this.setData({ previewStart: v, playTimeText: fmtClock(v) })
    this.onTuneChanged()
  },

  onUp() { this.updateSemitones(this.data.semitones + 1) },
  onDown() { this.updateSemitones(this.data.semitones - 1) },

  onNext() {
    session.setSemitones(this.data.semitones)
    wx.navigateTo({ url: '/pages/unlock/index' })
  },

  /** 播放器按钮：播放 / 暂停 / 续播 三态切换 */
  onPlayToggle() {
    const st = this.data.playState
    if (st === 'processing') return // 正在调，按钮禁用态（WXML 已 disabled，双保险）
    if (st === 'playing') {
      audioSvc.pausePreview()
      this.setPlayState('paused')
      return
    }
    if (st === 'paused') {
      audioSvc.resumePreview()
      this.setPlayState('playing')
      return
    }
    // idle → 从当前指针位置开始听 15 秒
    this._hasPreviewed = true
    this._previewSeq = (this._previewSeq || 0) + 1
    this._playStarted = false
    audioSvc.stopPreview()
    this.setPlayState('processing')
    this.startCountdown()
    this.doPreviewSafe()
  },

  /** 串行守卫：Worker 同时只能跑一个请求，撞上了就排队，前一轮收尾后自动接上 */
  doPreviewSafe() {
    if (this._busy) { this._pendingPreview = true; return }
    this.doPreview()
  },

  /** 试听本体：Worker 里从指针处切 15 秒变调后回放 */
  async doPreview() {
    const song = session.getSong()
    if (!song) return wx.reLaunch({ url: '/pages/index/index' })

    // 序号守卫：旧播放被打断后其 finally 仍会执行（微任务），
    // 不能让它关掉新一轮的状态、污染新一轮的进度条
    this._previewSeq = (this._previewSeq || 0) + 1
    const seq = this._previewSeq
    this._busy = true
    const t0 = Date.now()
    try {
      const s = await audioSvc.ensureSong(song)
      // 起点限制在 [0, duration - PREVIEW_SEC]（歌尾不足 15 秒就从能播满的位置起）
      const start = Math.min(this.data.previewStart, Math.max(0, s.durationSec - config.PREVIEW_SEC))

      const res = await engine.preview({
        token: s.token,
        semitones: this.data.semitones,
        startSec: start,
        maxSec: config.PREVIEW_SEC,
        sampleRate: s.sampleRate,
        channels: s.channels,
      })
      this._lastCostMs = Date.now() - t0   // 实测耗时，给下次倒计时当基数
      if (seq !== this._previewSeq) return // 等待期间用户又改了调/拖了条，结果直接丢弃

      this._playStartSec = start                        // 本段在整首歌里的起点
      this._playedSec = res.data.byteLength / 8 / s.sampleRate
      this._playStarted = true
      this.stopCountdown()
      this.setPlayState('playing')
      this.startProgressTicker()
      await audioSvc.playInterleavedF32(res.data, s.sampleRate)
    } catch (e) {
      const msg = e.message || ''
      if (msg.indexOf('正在处理中') !== -1) {
        // Worker 还忙着上一轮：排队，等它收尾后自动接上
        this._pendingPreview = true
      } else if (msg.indexOf('已取消') === -1 && seq === this._previewSeq) {
        wx.showToast({ title: msg || '试听失败', icon: 'none' })
      }
    } finally {
      this._busy = false
      if (seq === this._previewSeq) {
        this.stopCountdown()
        this.stopProgressTicker()
        // 播完指针前进到听完的位置（再点 ▶ 接着听下一段）；到歌尾自动回开头
        let pos = this.data.previewStart
        if (this._playStarted) {
          pos = this._playStartSec + this._playedSec
          if (pos >= this._durationSec - 0.5) pos = 0
        }
        this._playStarted = false
        this.setData({
          previewStart: pos,
          playTimeText: fmtClock(pos),
          playPercent: this._durationSec ? (pos / this._durationSec) * 100 : 0,
        })
        this.setPlayState('idle')
      }
      // 有排队的请求就接上（不管本轮是否已作废，排队意愿永远指向最新调级/位置）
      if (this._pendingPreview) {
        this._pendingPreview = false
        this.doPreviewSafe()
      }
    }
  },

  /** 进度条心跳：250ms 刷一次，秒数变了才刷文字（少打扰渲染层）；拖动中不刷，避免跟手打架 */
  startProgressTicker() {
    this.stopProgressTicker()
    this._progressTimer = setInterval(() => {
      if (this._seeking) return
      const st = audioSvc.getPreviewState()
      if (!st || !this._durationSec) return
      const pos = (this._playStartSec || 0) + st.positionSec
      const pct = Math.min(100, (pos / this._durationSec) * 100)
      const t = fmtClock(pos)
      if (t !== this.data.playTimeText) {
        this.setData({ playTimeText: t, playPercent: pct, previewStart: pos })
      } else {
        this.setData({ playPercent: pct, previewStart: pos })
      }
    }, 250)
  },

  stopProgressTicker() {
    clearInterval(this._progressTimer)
    this._progressTimer = null
  },

  /** 离开页面（下一步/返回/切后台）一律停声。
   *  关键：wx.navigateTo 不触发 onUnload（页面压栈存活），必须靠 onHide 兜底，
   *  否则试听会在解锁页继续放（2026-10-06 用户实测踩坑）。 */
  teardownPlayback() {
    this._previewSeq = (this._previewSeq || 0) + 1   // 作废旧请求：结果落地也直接丢弃
    this._playStarted = false
    clearTimeout(this._previewTimer)
    this.stopCountdown()
    this.stopProgressTicker()
    audioSvc.stopPreview()
    if (this._busy) engine.abort()   // 正在等 Worker：终止请求，给全曲处理让路（常驻数据没了 ensureSong 会自动重解码，无感）
    if (this.data.playState !== 'idle') this.setPlayState('idle')
  },

  onHide() { this.teardownPlayback() },

  onUnload() { this.teardownPlayback() },
})
