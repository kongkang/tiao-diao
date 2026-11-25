// 链接导入服务:贴分享文案 → 云函数解析 → 分块提取音频拼成本地文件
// 免费范围:解析 + 试听(与本地选歌一致);下载/转调导出走现有 unlock 付费流程
// 云函数:parseMedia(解析) / fetchMedia(分块断点提取,单块限时,端上循环拉取)
//
// 提取协议:fetchMedia({ref, offset, startSec, maxSec})
//            → { chunkB64, nextOffset, totalBytes, ext, done, meta?, retry? }
//            云函数单次返回上限 1MB,所以一块最多 720KB(base64 后约 0.94MB)
// 端上 writeFile(首块)+ appendFile(后续)拼成 USER_DATA_PATH 下的 import-*.{ext}
// 进度 = nextOffset / totalBytes(服务器拿不到总长时给 0,进度按字节数展示)
//
// 云端会按文件结构只取音轨、视频太长时只取一段(详见 cloudfunctions/fetchMedia):
// 手机拿到的已经是普通大小的音频,不用再背整个视频。
// meta(第一块带回):{ durationSec 这一段多长, startSec 从视频第几秒开始, mediaDurationSec 视频总长, mode }
//
// 断点续传:同一个片段没提完(网络断了、云端响应慢)时,半成品留在本地;
//           用户点「再试一次」从断点接着提,不用从头来。

const config = require('../config.js')
const cloud = require('./cloud.js')

const IMPORT_PREFIX = 'import-'
const MAX_ATTEMPTS = 200          // 分块循环硬上限(防死循环;云端一块最多 720KB,够拉约 140MB)
const STALL_LIMIT = 12            // 连续这么多次没有任何进展 → 先停下,让用户稍后续传
const CALL_ERROR_LIMIT = 5        // 云调用本身连续失败这么多次 → 判定网络不行

let partial = null   // 没提完的片段 { key, path, offset, totalBytes, meta, ext }

/** 云端明确说「取不了」:重试没用,直接告诉用户。半成品不留 */
function finalError(message) {
  const e = new Error(message || '提取没成功')
  e.final = true
  return e
}

/** 中途断了(网络 / 云端慢 / 太长):半成品留着,下次从断点接着提 */
function interrupted(message) {
  const e = new Error(message)
  e.resume = true
  return e
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** 解析分享文案 → { platform, platformName, title, cover, durationSec, ref } */
function parse(text) {
  return cloud.call('parseMedia', { text })
}

function fs() {
  return wx.getFileSystemManager()
}

function fileExists(path) {
  try { fs().accessSync(path); return true } catch (e) { return false }
}

function fsWrite(path, data) {
  return new Promise((resolve, reject) => {
    fs().writeFile({ filePath: path, data, success: resolve, fail: err => reject(finalError('手机上存不下这个音频:' + ((err && err.errMsg) || ''))) })
  })
}

function fsAppend(path, data) {
  return new Promise((resolve, reject) => {
    fs().appendFile({ filePath: path, data, success: resolve, fail: err => reject(interrupted('手机上存不下这个音频,清理一下空间再试')) })
  })
}

function fsUnlink(path) {
  return new Promise(resolve => fs().unlink({ filePath: path, complete: () => resolve() }))
}

/** 清理以前导入留下的临时文件(没提完、正在续传的那个不动) */
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

/** 同一个视频的同一段才算「同一个片段」 */
function sliceKey(ref, slice) {
  return JSON.stringify(ref) + '|' + slice.startSec + '|' + slice.maxSec
}

/**
 * 分块提取音频到本地临时文件
 * @param {object} ref   parseMedia 给的引用,原样传回
 * @param {object} opts  { startSec 从视频第几秒开始, maxSec 这一段最多多长 }
 * @param {function} onProgress  ({bytes, totalBytes})
 * @returns {Promise<{path, ext, sizeBytes, meta}>}
 *   失败时抛的错带标记:e.final = 取不了(换一个);e.resume = 中断了(再试一次会接着提)
 */
async function fetchAudioToFile(ref, opts, onProgress) {
  const slice = {
    startSec: Math.max(0, (opts && opts.startSec) || 0),
    maxSec: Math.max(1, (opts && opts.maxSec) || config.IMPORT_MAX_SEC),
  }
  const key = sliceKey(ref, slice)
  let path = null
  let offset = 0
  let totalBytes = 0
  let meta = null
  let ext = ''
  let stalled = 0
  let callErrors = 0
  let finished = false

  // 上次同一个片段没提完、文件还在:从断点接着提
  if (partial && partial.key === key && partial.offset > 0 && fileExists(partial.path)) {
    path = partial.path
    offset = partial.offset
    totalBytes = partial.totalBytes
    meta = partial.meta
    ext = partial.ext
    if (onProgress) onProgress({ bytes: offset, totalBytes })
  } else {
    partial = null
    path = wx.env.USER_DATA_PATH + '/' + IMPORT_PREFIX + Date.now()
    await cleanupOldImports(null)
  }
  const basePath = path

  try {
    for (let i = 0; i < MAX_ATTEMPTS && !finished; i++) {
      if (callErrors >= CALL_ERROR_LIMIT) {
        throw interrupted('网络不太稳,提取中断了。点「再试一次」会从断点接着提')
      }

      let r
      try {
        r = await cloud.rawCall('fetchMedia', { ref, offset, startSec: slice.startSec, maxSec: slice.maxSec })
      } catch (e) {
        callErrors++
        await sleep(400)
        continue
      }
      callErrors = 0
      if (!r || typeof r.ok !== 'boolean') { callErrors++; await sleep(400); continue }

      // 云端明确说取不了(没有声音 / 加密 / 不支持…):重试没用
      if (r.ok === false) throw finalError(r.message)

      if (r.retry || !r.chunkB64) {
        // 这一轮预算内没读到新字节(冷启动在解析、网络慢):原 offset 再来
        if (r.done) { finished = true; break }
        if (r.totalBytes) totalBytes = r.totalBytes
        if (++stalled >= STALL_LIMIT) throw interrupted('音频这边响应太慢。点「再试一次」会从断点接着提')
        await sleep(300)
        continue
      }
      stalled = 0

      const buf = wx.base64ToArrayBuffer(r.chunkB64)
      if (!buf.byteLength) throw finalError('拿到的内容不是音频,换一个链接试试')

      if (offset === 0) {
        if (!r.ext) throw finalError('拿到的内容不是音频,换一个链接试试')
        ext = r.ext
        path = basePath + '.' + ext
        meta = r.meta || null
        await fsWrite(path, buf)
      } else {
        await fsAppend(path, buf)
      }

      offset = r.nextOffset
      totalBytes = r.totalBytes || totalBytes
      partial = { key, path, offset, totalBytes, meta, ext }
      if (onProgress) onProgress({ bytes: offset, totalBytes })
      if (r.done) finished = true
    }

    if (!finished) throw interrupted('这个视频太长,这次没提完。点「再试一次」会从断点接着提')
    const done = { path, ext, sizeBytes: offset, meta }
    partial = null
    return done
  } catch (e) {
    if (!(e && e.resume)) {
      // 取不了:半成品不留
      partial = null
      if (path) await fsUnlink(path).catch(() => { /* */ })
    }
    throw e
  }
}

module.exports = { parse, fetchAudioToFile }
