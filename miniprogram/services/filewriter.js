// 攒批写文件：数据先攒在内存里，攒满一批再落盘；批的大小逐次翻倍（有上限）
//
// 为什么不「来一块写一块」：
//   1) 微信的 appendFile 一次一次跨进程，长音频几百块就是几百次，慢；
//   2) 更要紧的是本地存储配额怎么算。开发者工具模拟器里实测（2026-11-26）：
//      每 appendFile 一次，配额里加的不是「这一块的大小」，而是「追加后整个文件的大小」，
//      累计量随块数平方增长 —— 720KB 一块写 24 块（真实才 17MB）就报
//      「the maximum size of the file storage limit is exceeded」（名义上限 200MB）。
//      换 360KB / 1440KB 一块，能写的块数跟着变，但「Σ 每次追加后的文件大小」都卡在 200MB 上下。
//   攒成大批再写，追加次数降到个位数：一个 50MB 的文件只占 150MB 左右的「配额」。
//   真机是不是也这么算没法在开发机上验证 —— 攒批写对两种算法都安全。
//
// 内存：任意时刻最多攒一批（上限 MAX_FLUSH_BYTES）。

const FIRST_FLUSH_BYTES = 4 * 1024 * 1024
const MAX_FLUSH_BYTES = 16 * 1024 * 1024

/**
 * @param {object} fs   wx.getFileSystemManager()
 * @param {string} path
 * @param {object} opts
 *   maxBytes        收下的总字节数超过它就报错（0 = 不限）
 *   overMessage     超限时的报错文案
 *   diskFailMessage (errMsg) → 写失败时的文案；不给就原样带 errMsg
 *   append          接着一个已有的文件往后追加（断点续传用）
 *   appendFrom      已有文件的字节数（配合 append）
 * @returns writer {push(data)→Promise, flush()→Promise, discard()→Promise,
 *                   bytes 已收下, onDiskBytes 已落盘}
 */
function createWriter(fs, path, opts) {
  const o = opts || {}
  const maxBytes = o.maxBytes || 0
  let cap = FIRST_FLUSH_BYTES
  let buf = new ArrayBuffer(cap)
  let pos = 0                  // 这一批里已经攒了多少
  let started = !!o.append     // 已经往这个文件写过
  let onDisk = o.append ? (o.appendFrom || 0) : 0
  let accepted = onDisk
  let chain = Promise.resolve()   // 落盘串行
  let failed = null

  function diskError(err) {
    const raw = (err && err.errMsg) || String(err || '')
    console.warn('[filewriter] 写入失败', path, raw)
    const e = new Error(o.diskFailMessage ? o.diskFailMessage(raw) : '保存失败：' + raw)
    e.detail = raw
    return e
  }

  function writeOut(data) {
    const first = !started
    return new Promise((resolve, reject) => {
      fs[first ? 'writeFile' : 'appendFile']({ filePath: path, data, success: resolve, fail: err => reject(diskError(err)) })
    }).then(() => {
      started = true
      onDisk += data.byteLength
    }, err => {
      failed = err
      throw err
    })
  }

  function push(data) {
    if (failed) return Promise.reject(failed)
    const len = data ? data.byteLength : 0
    if (!len) return chain
    if (maxBytes && accepted + len > maxBytes) {
      failed = new Error(o.overMessage || '文件太大了，存不下')
      failed.code = 'over'   // 调用方据此区分「太大,重试没用」和「写失败,可以重来」
      return Promise.reject(failed)
    }
    accepted += len
    let src = new Uint8Array(data)
    while (src.length) {
      const room = buf.byteLength - pos
      if (!room) {
        // 这一批满了：排到落盘队列，换一块更大的接着攒。
        // 必须把「此刻这一块缓冲区」交出去 —— 排队的是稍后才执行的闭包，
        // 直接引用变量的话，执行时它已经指向新的一批，会把新数据重复写一遍
        const full = buf
        chain = chain.then(() => writeOut(full))
        cap = Math.min(MAX_FLUSH_BYTES, cap * 2)
        buf = new ArrayBuffer(cap)
        pos = 0
        continue
      }
      const n = Math.min(room, src.length)
      new Uint8Array(buf, pos, n).set(src.subarray(0, n))
      pos += n
      src = src.subarray(n)
    }
    return chain
  }

  function flush() {
    if (failed) return Promise.reject(failed)
    if (!pos) return chain
    const data = pos === buf.byteLength ? buf : buf.slice(0, pos)
    pos = 0
    chain = chain.then(() => writeOut(data))
    return chain
  }

  /** 作废：丢掉还没落盘的，删掉已落盘的半成品 */
  function discard() {
    if (!failed) failed = new Error('已取消')
    pos = 0
    buf = new ArrayBuffer(0)
    cap = 0
    // 等在途的那一批落定再删（否则文件可能在删之后才被创建出来，留下半成品）
    return chain.catch(() => { /* 写失败也要接着清理 */ }).then(() => new Promise(resolve => {
      if (!started) return resolve()
      started = false
      fs.unlink({ filePath: path, complete: () => resolve() })
    }))
  }

  return {
    push,
    flush,
    discard,
    get bytes() { return accepted },
    get onDiskBytes() { return onDisk },
  }
}

module.exports = { createWriter, FIRST_FLUSH_BYTES, MAX_FLUSH_BYTES }
