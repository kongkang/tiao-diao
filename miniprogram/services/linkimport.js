// 链接导入服务:贴分享文案 → 云函数解析 → 分块提取音频拼成本地文件
// 免费范围:解析 + 试听(与本地选歌一致);下载/转调导出走现有 unlock 付费流程
// 云函数:parseMedia(解析) / fetchMedia(分块断点提取,单块限时,端上循环拉取)
//
// 提取协议:fetchMedia({ref, offset}) → { chunkB64, nextOffset, totalBytes, ext, done }
// 端上 writeFile(首块)+ appendFile(后续)拼成 USER_DATA_PATH 下的 import-*.{ext}
// 进度 = nextOffset / totalBytes(服务器拿不到总长时给 0,进度按字节数展示)

const cloud = require('./cloud.js')

const IMPORT_PREFIX = 'import-'
const MAX_ATTEMPTS = 80        // 分块循环硬上限(防死循环;按 1.5MB/块够拉 120MB)
const STALL_LIMIT = 3          // 连续多次没有任何进展 → 判定中断

/** 解析分享文案 → { platform, platformName, title, cover, durationSec, ref } */
function parse(text) {
  return cloud.call('parseMedia', { text })
}

function fs() {
  return wx.getFileSystemManager()
}

function fsWrite(path, data) {
  return new Promise((resolve, reject) => {
    fs().writeFile({ filePath: path, data, success: resolve, fail: err => reject(new Error('写入失败:' + ((err && err.errMsg) || ''))) })
  })
}

function fsAppend(path, data) {
  return new Promise((resolve, reject) => {
    fs().appendFile({ filePath: path, data, success: resolve, fail: err => reject(new Error('写入失败:' + ((err && err.errMsg) || ''))) })
  })
}

function fsUnlink(path) {
  return new Promise(resolve => fs().unlink({ filePath: path, complete: () => resolve() }))
}

/** 清理上一次导入留下的临时文件(当前的不动) */
function cleanupOldImports(keepPath) {
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
        for (const name of files) {
          if (name.indexOf(IMPORT_PREFIX) !== 0) continue
          const p = wx.env.USER_DATA_PATH + '/' + name
          if (p === keepPath) continue
          left++
          fsUnlink(p).then(done)
        }
        if (!left) { finished = true; resolve() }
      },
      fail() { resolve() },
    })
  })
}

/**
 * 分块提取音频到本地临时文件
 * @returns {Promise<{path, ext, sizeBytes}>}
 */
async function fetchAudioToFile(ref, onProgress) {
  const basePath = wx.env.USER_DATA_PATH + '/' + IMPORT_PREFIX + Date.now()
  await cleanupOldImports(basePath)

  let path = null
  let offset = 0
  let totalBytes = 0
  let stalled = 0
  let callErrors = 0

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    let r
    try {
      r = await cloud.call('fetchMedia', { ref, offset })
      callErrors = 0
    } catch (e) {
      // 云调用偶发失败(冷启动/网络抖动):同断点自动重试,进度不丢
      if (++callErrors >= 3) throw new Error('提取中断了(网络不稳),点「再试一次」会从断点继续')
      await sleep(400)
      continue
    }
    if (r.retry) {
      if (++stalled >= STALL_LIMIT * 2) throw new Error('音频服务器暂时不给力,稍后再试')
      continue
    }
    stalled = 0

    const buf = wx.base64ToArrayBuffer(r.chunkB64 || '')
    if (!buf.byteLength) {
      if (++stalled >= STALL_LIMIT) throw new Error('提取卡住了,稍后再试')
      continue
    }

    if (!path) path = basePath + '.' + (r.ext || 'mp3')
    if (offset === 0) await fsWrite(path, buf)
    else await fsAppend(path, buf)

    offset = r.nextOffset
    totalBytes = r.totalBytes || totalBytes
    if (onProgress) onProgress({ bytes: offset, totalBytes })

    if (r.done) {
      return { path, ext: r.ext || 'mp3', sizeBytes: offset }
    }
  }
  if (path) await fsUnlink(path)   // 半成品删掉
  throw new Error('这个音频太长了,提取没跑完。换个短一点的试试')
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** 云存储 fileID → 本地临时文件路径(保留给旧版兼容;当前主流程用 fetchAudioToFile) */
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

module.exports = { parse, fetchAudioToFile, downloadToTemp }
