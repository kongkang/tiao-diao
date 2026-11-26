// 结果文件：分块写入用户目录 + 发回微信
// ⚠️ 小程序不能直接存进手机存储，shareFileMessage 是唯一出口
// ⚠️ shareFileMessage 必须由用户点击手势触发
// 落盘走 filewriter（攒批写）：来一块 append 一块又慢、又会撞上本地存储配额的平方计数，
// 攒成大批再写。调用方（处理页）只管 beginResult / writeChunk / finishResult，不用关心批。

const config = require('../config.js')
const { safeBaseName } = require('../utils/format.js')
const { createWriter } = require('./filewriter.js')

const PREFIX = '【' + config.APP_NAME + '-'
const MAX_BYTES = (config.MAX_OUTPUT_MB || 95) * 1024 * 1024

/** 结果文件名：【小程序名-升N半音】原始名字.后缀
 *  调级文案（专业术语）：升N半音 / 降N半音 / 原调 */
function buildResultName(origName, semitones, ext) {
  const pitchText = semitones > 0 ? '升' + semitones + '半音'
    : (semitones < 0 ? '降' + (-semitones) + '半音' : '原调')
  return PREFIX + pitchText + '】' + safeBaseName(origName) + '.' + ext
}

function fs() {
  return wx.getFileSystemManager()
}

/** 删除旧结果（只删本小程序的结果前缀，保留头像等用户文件），释放 200MB 配额 */
function cleanupOldResults(keepPath) {
  return new Promise(resolve => {
    fs().readdir({
      dirPath: wx.env.USER_DATA_PATH,
      success(res) {
        const files = (res && res.files) || []
        let left = 0
        let finished = false
        const done = () => {
          if (finished) return
          left--
          if (left <= 0) { finished = true; resolve() }
        }
        for (let i = 0; i < files.length; i++) {
          const name = files[i]
          if (name.indexOf(PREFIX) !== 0) continue
          const p = wx.env.USER_DATA_PATH + '/' + name
          if (keepPath && p === keepPath) continue
          left++
          fs().unlink({ filePath: p, complete: done })
        }
        if (!left) { finished = true; resolve() }
      },
      fail() { resolve() },   // 清理失败不阻塞主流程
    })
  })
}

/**
 * 开始一次结果写入：算文件名、清旧文件、返回 state。
 * 数据先攒在内存里，攒满一批才落盘（首块 writeFile 创建，后续 appendFile）。
 * @returns {Promise<{path,fileName,w}>}  w 是攒批写入器，调用方不用碰
 */
async function beginResult(origName, semitones, ext) {
  const fileName = buildResultName(origName, semitones, ext)
  const path = wx.env.USER_DATA_PATH + '/' + fileName
  await cleanupOldResults(path)
  return {
    path,
    fileName,
    w: createWriter(fs(), path, {
      maxBytes: MAX_BYTES,
      overMessage: '转出来的文件超过微信单文件 100MB 上限，这首歌太长了',
      diskFailMessage: msg => /1300202|100M|上限|maximum size|storage limit/i.test(msg)
        ? '手机本地空间不够了（微信给小程序的存储已满），清理一下旧文件再试'
        : '保存失败：' + msg,
    }),
  }
}

/** 收一块结果（多数时候只是攒进内存，攒满一批才真正写文件） */
function writeChunk(state, data) {
  return state.w.push(data)
}

/** 收尾：把攒着的全部落盘，确认文件存在并返回最终大小 */
async function finishResult(state) {
  await state.w.flush()
  if (!state.w.onDiskBytes) throw new Error('没有生成任何音频数据')
  return new Promise((resolve, reject) => {
    fs().stat({
      path: state.path,
      success: res => resolve({
        path: state.path,
        fileName: state.fileName,
        bytes: (res.stats && res.stats.size) || state.w.onDiskBytes,
      }),
      fail: err => reject(new Error('保存失败：' + ((err && err.errMsg) || ''))),
    })
  })
}

/** 失败/退出：丢掉没落盘的，删掉半成品 */
function discardResult(state) {
  return state && state.w ? state.w.discard() : Promise.resolve()
}

/** 发回微信聊天（用户点按钮触发） */
function shareResult(path, fileName) {
  return new Promise((resolve, reject) => {
    wx.shareFileMessage({
      filePath: path,
      fileName,
      success: resolve,
      fail: err => {
        // 用户取消分享不算错误
        if (err && /cancel/i.test(err.errMsg || '')) return resolve('cancel')
        reject(new Error('发送失败：' + (err.errMsg || '')))
      },
    })
  })
}

module.exports = {
  buildResultName,
  beginResult,
  writeChunk,
  finishResult,
  discardResult,
  cleanupOldResults,
  writeResult,
  shareResult,
}
