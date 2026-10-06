// 结果文件：写入用户目录 + 发回微信
// ⚠️ 小程序不能直接存进手机存储，shareFileMessage 是唯一出口
// ⚠️ shareFileMessage 必须由用户点击手势触发

const config = require('../config.js')
const { safeBaseName } = require('../utils/format.js')

/** 结果文件名：【小程序名-升N半音】原始名字.后缀
 *  调级文案（专业术语）：升N半音 / 降N半音 / 原调
 *  后缀取实际输出编码 ext（当前链路只产 mp3 就一律 .mp3；
 *  若未来支持输出原格式——如 wav 原曲出 wav——res.ext 会自然带原后缀） */
function buildResultName(origName, semitones, ext) {
  const pitchText = semitones > 0 ? '升' + semitones + '半音'
    : (semitones < 0 ? '降' + (-semitones) + '半音' : '原调')
  return '【' + config.APP_NAME + '-' + pitchText + '】' + safeBaseName(origName) + '.' + ext
}

/** 写结果文件，返回 { path, fileName } */
function writeResult(origName, semitones, data, ext) {
  const fileName = buildResultName(origName, semitones, ext)
  const path = `${wx.env.USER_DATA_PATH}/${fileName}`
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().writeFile({
      filePath: path,
      data, // ArrayBuffer
      success: () => resolve({ path, fileName }),
      fail: err => reject(new Error('保存失败：' + (err.errMsg || ''))),
    })
  })
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

module.exports = { writeResult, shareResult, buildResultName }
