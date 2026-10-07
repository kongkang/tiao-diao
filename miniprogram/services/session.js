// 会话状态：当前这首歌的元数据在页面间传递
// v3：PCM 常驻 Worker（token 引用），session 只存元数据，不再持有 PCM。
// Worker 进程被杀后 token 失效 → audio.ensureSong() 会按 path 自动重新解码。

let song = null
// song = {
//   path, name, size, format,
//   token,                 // Worker 常驻数据的令牌
//   frames, sampleRate, channels, durationSec,
// }
let semitones = 0
let lastResult = null // { path, fileName, name, semitones }
// 本次处理的解锁方式：'ad' 看广告 | 'pay' 扣分钟 | 'monthly' 包月 | 'free' 内测免费
// process 页据此决定扣费：广告已当场支付，不再扣分钟；其余走 billing.consume
let unlockMode = 'free'

module.exports = {
  setSong(s) { song = s; semitones = 0; lastResult = null },
  getSong() { return song },
  setSemitones(n) { semitones = n },
  getSemitones() { return semitones },
  setLastResult(r) { lastResult = r },
  getLastResult() { return lastResult },
  setUnlockMode(m) { unlockMode = m || 'free' },
  getUnlockMode() { return unlockMode },

  clear() { song = null; semitones = 0; unlockMode = 'free' },
}
