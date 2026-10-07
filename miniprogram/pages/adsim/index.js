// 演示广告页 —— 内测期联调「看广告解锁」全流程用（ad.js AD_ENABLED=false 且管理页开启演示时进入）
// 状态机与真实激励视频对齐：看完 isEnded=true → 发奖励；中途关/返回 → isEnded=false → 可重看。
// 通过 EventChannel 向 ad.js 回传 simResult，本页不直接决定放行。

const page = require('../../utils/page.js')

page({
  data: {
    idx: 1,
    total: 1,
    sec: 5,
    left: 5,
    ended: false,
  },

  onLoad(q) {
    const sec = Math.max(3, Math.min(30, parseInt(q.sec, 10) || 5))
    this.setData({
      idx: parseInt(q.idx, 10) || 1,
      total: parseInt(q.total, 10) || 1,
      sec,
      left: sec,
    })
    this._done = false
    this._timer = setInterval(() => {
      if (this._done) return
      const left = this.data.left - 1
      if (left <= 0) {
        clearInterval(this._timer)
        this.setData({ left: 0, ended: true })
      } else {
        this.setData({ left })
      }
    }, 1000)
  },

  /** 看完，领奖励 */
  onReward() { this.finish(true) },

  /** 中途跳过（不领奖励） */
  onSkip() { this.finish(false) },

  finish(isEnded) {
    if (this._done) return
    this._done = true
    clearInterval(this._timer)
    this.emitResult(isEnded)
    wx.navigateBack()
  },

  emitResult(isEnded) {
    try {
      const ch = this.getOpenerEventChannel && this.getOpenerEventChannel()
      if (ch && ch.emit) ch.emit('simResult', { isEnded })
    } catch (e) { /* 通道异常按中途关闭处理，ad.js 兜底超时 */ }
  },

  onUnload() {
    clearInterval(this._timer)
    // 用户用系统返回手势离开 = 中途关闭
    if (!this._done) {
      this._done = true
      this.emitResult(false)
    }
  },
})
