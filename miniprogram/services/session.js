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

module.exports = {
  setSong(s) { song = s; semitones = 0; lastResult = null },
  getSong() { return song },
  setSemitones(n) { semitones = n },
  getSemitones() { return semitones },
  setLastResult(r) { lastResult = r },
  getLastResult() { return lastResult },

  clear() { song = null; semitones = 0 },
}
