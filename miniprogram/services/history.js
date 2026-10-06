// 转调历史 —— 纯本地存储（2026-10-06）
// 记录用户转过哪些歌：歌名、调了几级、时长、结果文件名、时间。
// ⚠️ 只存元数据，不存音频文件本身（结果文件在系统临时目录，微信会定期清理，
//    历史里的 fileName 仅作展示，不保证文件还在）。
// 上限 50 条，超出丢弃最旧的。后续接服务器时由云函数同步，读取方不用改。

const KEY = 'td_history'
const MAX = 50

function list() {
  try {
    const h = wx.getStorageSync(KEY)
    return Array.isArray(h) ? h : []
  } catch (e) {
    return []
  }
}

/**
 * 记一笔（转调成功时调用）
 * @param {{name:string, semitones:number, durationSec:number, fileName:string}} rec
 */
function add(rec) {
  try {
    const h = list()
    h.unshift({
      name: rec.name || '未知',
      semitones: rec.semitones || 0,
      durationSec: Math.round(rec.durationSec || 0),
      fileName: rec.fileName || '',
      ts: Date.now(),
    })
    if (h.length > MAX) h.length = MAX
    wx.setStorageSync(KEY, h)
  } catch (e) {
    console.warn('[history] 写入失败', e)
  }
}

function clear() {
  try { wx.removeStorageSync(KEY) } catch (e) { /* */ }
}

module.exports = { list, add, clear, MAX }
