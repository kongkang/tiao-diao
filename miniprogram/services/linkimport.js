// 链接导入服务:贴分享文案 → 云函数解析 → 分块提取音频拼成本地文件
// 免费范围:解析 + 试听(与本地选歌一致);下载/转调导出走现有 unlock 付费流程
// 云函数:parseMedia(解析) / fetchMedia(分块断点提取,单块限时,端上循环拉取)
//
// 提取协议:fetchMedia({ref, offset, startSec, maxSec})
//            → { chunkB64, nextOffset, totalBytes, ext, done, meta?, retry? }
// 端上一块块收下来,由 filewriter 攒成大批落盘成 USER_DATA_PATH 下的 import-*.{ext}
// (云函数单次返回上限 1MB,所以一块最多 720KB;来一块 append 一块会撞上本地存储配额的
//  平方计数,所以攒批写)
// 进度 = 已收到的字节 / totalBytes
//
// 云端会按文件结构只取音轨、视频太长时只取一段(详见 cloudfunctions/fetchMedia):
// 手机拿到的已经是普通大小的音频,不用再背整个视频。
// meta(第一块带回):{ durationSec 这一段多长, startSec 从视频第几秒开始, mediaDurationSec 视频总长, mode }
//
// 断点续传:同一个片段没提完(网络断了、云端响应慢)时,半成品留在本地;
//           用户点「再试一次」从断点接着提,不用从头来。断点 = 真正落盘了的字节数。

const config = require('../config.js')
const cloud = require('./cloud.js')
const { createWriter } = require('./filewriter.js')

const IMPORT_PREFIX = 'import-'
const MAX_ATTEMPTS = 200          // 分块循环硬上限(防死循环;云端一块最多 720KB,够拉约 140MB)
const STALL_LIMIT = 12            // 连续这么多次没有任何进展 → 先停下,让用户稍后续传
const CALL_ERROR_LIMIT = 5        // 云调用本身连续失败这么多次 → 判定网络不行

let partial = null   // 没提完的片段 { key, path, offset(已落盘), totalBytes, meta, ext }

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

function fsUnlink(path) {
  return new Promise(resolve => fs().unlink({ filePath: path, complete: () => resolve() }))
}

/** 清理以前导入留下的临时文件 */
function cleanupOldImports() {
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
          left++
          fsUnlink(wx.env.USER_DATA_PATH + '/' + name).then(done)
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

const WRITE_LIMITS = {
  maxBytes: config.MAX_FILE_MB * 1048576,
  overMessage: '这个音频超过微信单个文件 ' + config.MAX_FILE_MB + 'MB 的上限，取不了',
  diskFailMessage: () => '手机本地空间不够了（微信给小程序的存储已满），清理一下再试',
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
  const basePath = wx.env.USER_DATA_PATH + '/' + IMPORT_PREFIX + Date.now()
  let path = null
  let offset = 0          // 云端已经给的成品字节(下一块从这儿要)
  let totalBytes = 0
  let meta = null
  let ext = ''
  let w = null            // 攒批写入器(第一块到了、知道格式之后才建)
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
    w = createWriter(fs(), path, Object.assign({ append: true, appendFrom: offset }, WRITE_LIMITS))
    if (onProgress) onProgress({ bytes: offset, totalBytes })
  } else {
    partial = null
    await cleanupOldImports()
  }

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

      if (!w) {
        // 第一块:这时才知道是什么格式
        if (!r.ext) throw finalError('拿到的内容不是音频,换一个链接试试')
        ext = r.ext
        path = basePath + '.' + ext
        meta = r.meta || null
        w = createWriter(fs(), path, WRITE_LIMITS)
      }

      offset = r.nextOffset
      totalBytes = r.totalBytes || totalBytes
      await w.push(buf)   // 先收下(攒在内存里);写失败会在这儿抛出来
      // 断点只认已经落盘的:内存里攒着的还不算
      partial = { key, path, offset: w.onDiskBytes, totalBytes, meta, ext }
      if (onProgress) onProgress({ bytes: offset, totalBytes })
      if (r.done) finished = true
    }

    if (!w) throw interrupted('还没提取到音频。点「再试一次」接着提')
    if (!finished) throw interrupted('这个视频太长,这次没提完。点「再试一次」会从断点接着提')
    await w.flush()
    const done = { path, ext, sizeBytes: w.onDiskBytes, meta }
    partial = null
    return done
  } catch (e) {
    // 太大(超过单文件上限)重试也没用;其余(网络 / 云端慢 / 写失败 / 没提完)都是中断,可以续
    if (e && e.code === 'over') e.final = true
    if (!(e && e.final)) e.resume = true
    if (w) {
      if (e.resume) {
        // 把攒着的尽量落盘;落不下去就只认已经落盘的那部分
        await w.flush().catch(() => { /* */ })
        if (w.onDiskBytes > 0) {
          partial = { key, path, offset: w.onDiskBytes, totalBytes, meta, ext }
        } else {
          partial = null
          await w.discard().catch(() => { /* */ })
        }
      } else {
        // 取不了:半成品不留
        partial = null
        await w.discard().catch(() => { /* */ })
      }
    } else if (e.final) {
      partial = null
    }
    throw e
  }
}

module.exports = { parse, fetchAudioToFile }
