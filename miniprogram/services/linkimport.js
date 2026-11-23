// 链接导入服务:贴分享文案 → 云函数解析 → 云端提取音频转存云存储 → 下载到本地临时文件
// 免费范围:解析 + 试听(与本地选歌一致);下载/转调导出走现有 unlock 付费流程
// 云函数:parseMedia(解析) / fetchMedia(提取+转存,最长约 1 分钟)

const cloud = require('./cloud.js')

/** 解析分享文案 → { platform, platformName, title, cover, durationSec, ref }
 *  失败会 throw Error(message),message 是给人看的中文短句 */
function parse(text) {
  return cloud.call('parseMedia', { text })
}

/** 按 ref 提取音频,转存到云存储 → { fileID, ext, sizeBytes } */
async function fetchAudio(ref) {
  try {
    return await cloud.call('fetchMedia', { ref })
  } catch (e) {
    // cloud.call 对调用失败统一抛"网络或支付服务不可用",这里按提取场景转成人话
    throw new Error('提取没完成:音频可能太长,或网络不稳。先试 5 分钟以内的,成功率高')
  }
}

/** 云存储 fileID → 本地临时文件路径(wx.cloud 通道,不受域名白名单限制) */
function downloadToTemp(fileID) {
  if (!cloud.available()) return Promise.reject(new Error('云服务不可用,请更新微信后重试'))
  return new Promise((resolve, reject) => {
    wx.cloud.downloadFile({
      fileID,
      success: res => {
        if (res.tempFilePath) resolve({ tempFilePath: res.tempFilePath })
        else reject(new Error('下载没完成,再试一次'))
      },
      fail: err => reject(new Error(err && err.errMsg ? '音频下载失败:' + err.errMsg : '音频下载失败,再试一次')),
    })
  })
}

module.exports = { parse, fetchAudio, downloadToTemp }
