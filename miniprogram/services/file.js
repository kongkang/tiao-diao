// 结果文件：分块写入用户目录 + 发回微信
// ⚠️ 小程序不能直接存进手机存储，shareFileMessage 是唯一出口
// ⚠️ shareFileMessage 必须由用户点击手势触发
// ⚠️ appendFile 不会自动建文件：首块必须 writeFile 创建，后续才 appendFile

const config = require('../config.js')
const { safeBaseName } = require('../utils/format.js')

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
 * 不创建空文件（appendFile 不能建文件，首块由 writeChunk 用 writeFile 创建）。
 * @returns {Promise<{path,fileName,started,bytes}>}
 */
async function beginResult(origName, semitones, ext) {
  const fileName = buildResultName(origName, semitones, ext)
  const path = wx.env.USER_DATA_PATH + '/' + fileName
  await cleanupOldResults(path)
  return { path, fileName, started: false, bytes: 0 }
}

/** 写一块结果（首块 writeFile 创建/截断，后续 appendFile） */
function writeChunk(state, data) {
  return new Promise((resolve, reject) => {
    const len = data ? data.byteLength : 0
    if (!len) return resolve()
    if (state.bytes + len > MAX_BYTES) {
      return reject(new Error('转出来的文件超过微信单文件 100MB 上限，这首歌太长了'))
    }
    const fail = err => {
      const msg = (err && err.errMsg) || ''
      if (/1300202|100M|上限|maximum size|storage limit/i.test(msg)) {
        return reject(new Error('微信单个文件最多 100MB（本地空间也可能满了），这首歌太长或旧文件太多'))
      }
      reject(new Error('保存失败：' + msg))
    }
    if (!state.started) {
      fs().writeFile({
        filePath: state.path,
        data,
        success: () => { state.started = true; state.bytes += len; resolve() },
        fail,
      })
    } else {
      fs().appendFile({
        filePath: state.path,
        data,
        success: () => { state.bytes += len; resolve() },
        fail,
      })
    }
  })
}

/** 收尾：确认文件存在并返回最终大小 */
function finishResult(state) {
  return new Promise((resolve, reject) => {
    if (!state.started) return reject(new Error('没有生成任何音频数据'))
    fs().stat({
      path: state.path,
      success: res => resolve({
        path: state.path,
        fileName: state.fileName,
        bytes: (res.stats && res.stats.size) || state.bytes,
      }),
      fail: err => reject(new Error('保存失败：' + ((err && err.errMsg) || ''))),
    })
  })
}

/** 失败/退出：删掉半成品 */
function discardResult(state) {
  return new Promise(resolve => {
    if (!state || !state.started || !state.path) return resolve()
    fs().unlink({ filePath: state.path, complete: () => resolve() })
  })
}

/** 小文件一次性写入（兼容旧调用/测试） */
async function writeResult(origName, semitones, data, ext) {
  const state = await beginResult(origName, semitones, ext)
  await writeChunk(state, data)
  return finishResult(state)
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
