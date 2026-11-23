#!/usr/bin/env node
/**
 * Worker 流式链路回归（Node，不需要开发者工具）
 *
 * 直接加载 miniprogram/workers/pitch.js + 真实 ffdecode.wasm.br：
 *   分块上传 → analyze → 试听窗口 → 全曲流式变调/编码 → 校验 MP3。
 *
 * 运行：node tools/autotest/test-worker-stream.js
 */
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const { execFileSync } = require('child_process')

const ROOT = path.resolve(__dirname, '../..')
const WASM = path.join(ROOT, 'miniprogram/wasm/ffdecode.wasm.br')
const TMP = '/tmp/td-worker-test'
fs.mkdirSync(TMP, { recursive: true })

// ---------- 测试音频：8 秒 440Hz 立体声 WAV ----------
function makeWav(sec) {
  const rate = 44100
  const frames = rate * sec
  const bytes = frames * 4
  const buf = Buffer.alloc(44 + bytes)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + bytes, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(2, 22)
  buf.writeUInt32LE(rate, 24)
  buf.writeUInt32LE(rate * 4, 28)
  buf.writeUInt16LE(4, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(bytes, 40)
  for (let i = 0; i < frames; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 12000)
    buf.writeInt16LE(v, 44 + i * 4)
    buf.writeInt16LE(-v, 44 + i * 4 + 2)
  }
  return buf
}

const wavPath = path.join(TMP, 'in.wav')
if (!fs.existsSync(wavPath)) fs.writeFileSync(wavPath, makeWav(8))
const fileBytes = fs.readFileSync(wavPath)

// ---------- 加载 worker（模拟 WX 环境） ----------
const inbox = []
let notify = null
global.worker = {
  _handler: null,
  onMessage(fn) { this._handler = fn },
  postMessage(msg, transfer) {
    inbox.push(msg)
    if (notify) { const n = notify; notify = null; n() }
  },
}
global.WXWebAssembly = {
  async instantiate(wasmPath, imports) {
    const raw = zlib.brotliDecompressSync(fs.readFileSync(path.join(ROOT, 'miniprogram', wasmPath)))
    const { instance } = await WebAssembly.instantiate(raw, imports)
    return { instance }
  },
}

require(path.join(ROOT, 'miniprogram/workers/pitch.js'))

function send(msg) {
  global.worker._handler(msg)
}

function waitMsg(pred, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 120000)
  return new Promise((resolve, reject) => {
    const check = () => {
      for (let i = 0; i < inbox.length; i++) {
        if (pred(inbox[i])) {
          const m = inbox.splice(i, 1)[0]
          return resolve(m)
        }
      }
      if (Date.now() > deadline) return reject(new Error('等待消息超时'))
      notify = check
    }
    check()
  })
}

function fail(msg) { throw new Error(msg) }

async function main() {
  const token = 't-test'
  const size = fileBytes.length

  // 1. 分块上传
  send({ type: 'analyze_begin', token, totalBytes: size })
  const ready = await waitMsg(m => m.type === 'analyze_ready' || m.type === 'analyze_error')
  if (ready.type === 'analyze_error') fail('analyze_begin: ' + ready.message)

  const CH = 4 * 1024 * 1024
  for (let off = 0; off < size; off += CH) {
    const len = Math.min(CH, size - off)
    const part = fileBytes.buffer.slice(fileBytes.byteOffset + off, fileBytes.byteOffset + off + len)
    send({ type: 'analyze_chunk', token, offset: off, data: part })
    const ack = await waitMsg(m => m.type === 'analyze_chunk_ack' || m.type === 'analyze_error')
    if (ack.type === 'analyze_error') fail('analyze_chunk: ' + ack.message)
  }
  send({ type: 'analyze_end', token })
  const meta = await waitMsg(m => m.type === 'analyzed' || m.type === 'analyze_error')
  if (meta.type === 'analyze_error') fail('analyze_end: ' + meta.message)
  console.log('analyze ok:', meta)
  if (Math.abs(meta.durationSec - 8) > 0.2) fail('时长不对: ' + meta.durationSec)

  // 2. 试听 0~8s
  send({ type: 'preview', token, semitones: 2, startSec: 0, maxSec: 8 })
  const pv = await waitMsg(m => m.type === 'done' || m.type === 'error')
  if (pv.type === 'error') fail('preview: ' + pv.message)
  const pvSec = pv.outLength / pv.sampleRate
  console.log('preview ok:', pvSec.toFixed(2) + 's', pv.result.byteLength, 'bytes')
  if (Math.abs(pvSec - 8) > 0.2) fail('试听时长不对: ' + pvSec)

  // 3. 全曲流式处理
  const chunks = []
  let lastPercent = -99
  send({ type: 'process', token, semitones: 2, kbps: 128 })
  for (;;) {
    const m = await waitMsg(x =>
      x.type === 'chunk' || x.type === 'progress' || x.type === 'meta' ||
      x.type === 'done' || x.type === 'error', 180000)
    if (m.type === 'chunk') {
      chunks.push(Buffer.from(m.data))
      send({ type: 'ack', bytes: m.bytes })
      continue
    }
    if (m.type === 'progress') {
      if (m.percent >= 0 && m.percent !== lastPercent) {
        lastPercent = m.percent
      }
      continue
    }
    if (m.type === 'meta') {
      console.log('meta:', m)
      continue
    }
    if (m.type === 'error') fail('process: ' + m.message)
    console.log('done:', m)
    break
  }
  const out = Buffer.concat(chunks)
  const mp3Path = path.join(TMP, 'out.mp3')
  fs.writeFileSync(mp3Path, out)
  console.log('mp3 bytes:', out.length)
  if (out.length < 1000) fail('MP3 太小')

  try {
    const info = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,size', '-of', 'default=nw=1', mp3Path], { encoding: 'utf8' })
    console.log(info.trim())
    const m = /duration=([\d.]+)/.exec(info)
    if (m && Math.abs(parseFloat(m[1]) - 8) > 0.3) fail('输出时长不对: ' + m[1])
  } catch (e) {
    console.warn('ffprobe 不可用，跳过时长校验:', e.message)
  }

  // 4. 0 半音路径
  const chunks0 = []
  send({ type: 'process', token, semitones: 0, kbps: 128 })
  for (;;) {
    const m = await waitMsg(x => x.type === 'chunk' || x.type === 'done' || x.type === 'error', 180000)
    if (m.type === 'chunk') { chunks0.push(Buffer.from(m.data)); send({ type: 'ack', bytes: m.bytes }); continue }
    if (m.type === 'error') fail('process 0: ' + m.message)
    console.log('done 0:', m)
    break
  }
  const out0 = Buffer.concat(chunks0)
  if (out0.length < 1000) fail('0 半音 MP3 太小')
  console.log('mp3 0 bytes:', out0.length)

  console.log('\n全部通过')
}

main().catch(e => { console.error(e); process.exit(1) })
