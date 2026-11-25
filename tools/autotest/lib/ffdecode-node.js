// Node 版 ffdecode WASM harness —— 在开发者工具之外直接跑小程序自带的那份解码器
//
// WASI 桩、调用方式与 workers/pitch.js 的 loadFf()/pullChunk() 保持一致。
// 用途:云函数切片产物(mp4slice/fmp4slice)在进模拟器之前先在这里过一遍;
//      任何要确认「自带解码器到底怎么表现」的实验都可以用它。
//
// 用法:
//   const ff = require('./lib/ffdecode-node')
//   await ff.load()
//   const h = ff.open(bufferOrPath)        // 整文件进堆(与 Worker 一致)
//   ff.seek(30); ff.pullSec(10)            // {frames, peak, sec, ms}
//   ff.decodeAll()                         // Float32Array,交错 float
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const ROOT = path.resolve(__dirname, '../../..')
const WASM = path.join(ROOT, 'miniprogram/wasm/ffdecode.wasm.br')
const PULL = 16384   // 与 Worker 的 PULL_FRAMES 一致

let exp = null

function F(n) {
  return exp[n] || exp['_' + n]
}

async function load() {
  if (exp) return
  const raw = zlib.brotliDecompressSync(fs.readFileSync(WASM))
  const imports = {
    env: { emscripten_notify_memory_growth() {} },
    wasi_snapshot_preview1: {
      fd_write(fd, iovs, iovn, nwr) {
        const dv = new DataView(exp.memory.buffer)
        let total = 0
        for (let i = 0; i < iovn; i++) total += dv.getUint32(iovs + i * 8 + 4, true)
        dv.setUint32(nwr, total, true)
        return 0
      },
      fd_read(fd, iovs, iovn, nread) {
        new DataView(exp.memory.buffer).setUint32(nread, 0, true)
        return 0
      },
      fd_close() { return 0 },
      clock_time_get(clk, lo, hi, out) {
        const dv = new DataView(exp.memory.buffer)
        const ms = Date.now()
        dv.setUint32(out, ms >>> 0, true)
        dv.setUint32(out + 4, Math.floor(ms / 4294967296), true)
        return 0
      },
      environ_sizes_get(pc, pbs) {
        const dv = new DataView(exp.memory.buffer)
        dv.setUint32(pc, 0, true)
        dv.setUint32(pbs, 0, true)
        return 0
      },
      environ_get() { return 0 },
      fd_fdstat_get() { return 8 },
      fd_seek() { return 8 },
    },
  }
  const { instance } = await WebAssembly.instantiate(raw, imports)
  exp = instance.exports
  if (exp._initialize) exp._initialize()
}

/** 打开(整文件 malloc 进堆);失败抛错,err 为 ff_err 错误码 */
function open(file) {
  const bytes = Buffer.isBuffer(file) ? file : fs.readFileSync(file)
  const ptr = F('malloc')(bytes.length)
  if (!ptr) throw new Error('malloc failed ' + bytes.length)
  new Uint8Array(exp.memory.buffer).set(bytes, ptr)
  if (F('ff_open')(ptr, bytes.length) < 0) {
    F('free')(ptr)
    const e = new Error((Buffer.isBuffer(file) ? 'buffer(' + bytes.length + 'B)' : path.basename(file)) + ' open failed')
    e.ffErr = F('ff_err')()
    throw e
  }
  return { ptr, size: bytes.length, rate: F('ff_rate')(), ch: F('ff_channels')(), dur: F('ff_duration_sec')() }
}

function reopen(h) {
  if (F('ff_open')(h.ptr, h.size) < 0) throw new Error('reopen failed err=' + F('ff_err')())
}

function seek(sec) {
  return F('ff_seek')(sec)
}

/** 下一个待拉样本的时间(秒,0 起);当前帧没有时间戳返回 -1 */
function tell() {
  return F('ff_tell')()
}

function close(h) {
  F('ff_close')()
  F('free')(h.ptr)
}

/** 从当前位置拉最多 sec 秒;返回 {frames, peak, sec, ms}。解码出错抛错 */
function pullSec(sec) {
  const p = F('malloc')(PULL * 2 * 4)
  const rate = F('ff_rate')() || 44100
  const want = Math.round(sec * rate)
  let frames = 0
  let peak = 0
  const t0 = Date.now()
  try {
    while (frames < want) {
      const got = F('ff_pull')(p, PULL)
      if (got < 0) {
        const e = new Error('pull err=' + F('ff_err')())
        e.ffErr = F('ff_err')()
        throw e
      }
      if (got === 0) break
      const v = new Float32Array(exp.memory.buffer, p, got)
      for (let i = 0; i < got; i++) {
        const a = Math.abs(v[i])
        if (a > peak) peak = a
      }
      frames += got / 2
    }
  } finally {
    F('free')(p)
  }
  return { frames, peak, sec: frames / rate, ms: Date.now() - t0 }
}

/** 从当前位置顺序解码到结尾,返回交错 float(与 ffmpeg 的 f32le 输出同布局) */
function decodeAll(maxSec) {
  const p = F('malloc')(PULL * 2 * 4)
  const rate = F('ff_rate')() || 44100
  const limit = maxSec ? Math.round(maxSec * rate) * 2 : Infinity
  const out = []
  let total = 0
  try {
    while (total < limit) {
      const got = F('ff_pull')(p, PULL)
      if (got < 0) {
        const e = new Error('pull err=' + F('ff_err')())
        e.ffErr = F('ff_err')()
        throw e
      }
      if (got === 0) break
      out.push(new Float32Array(new Float32Array(exp.memory.buffer, p, got)))
      total += got
    }
  } finally {
    F('free')(p)
  }
  const all = new Float32Array(total)
  let o = 0
  for (const c of out) { all.set(c, o); o += c.length }
  return all
}

module.exports = { load, open, reopen, seek, tell, close, pullSec, decodeAll, F }
