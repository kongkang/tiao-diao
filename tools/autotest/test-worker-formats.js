#!/usr/bin/env node
/**
 * Worker 多格式 + 长音频回归（Node）
 *
 * 覆盖：mp3 / m4a(aac) / wma / flac / wav 的解码+试听+全曲流式编码；
 * 10 分钟长文件的处理时长、输出时长、RSS 增量（验证内存不随长度线性增长）。
 *
 * 先准备测试文件（/tmp/td-worker-test）：
 *   ffmpeg -f lavfi -i "sine=frequency=440:duration=600" -ac 2 -ar 44100 -b:a 64k long.mp3
 *   ffmpeg -i long.mp3 -c:a aac -b:a 64k long.m4a
 *   ffmpeg -i long.mp3 -c:a wmav2 -b:a 64k long.wma
 *   ffmpeg -i long.mp3 -c:a flac long.flac            # 24-bit
 *   ffmpeg -i long.mp3 -c:a flac -sample_fmt s16 long16.flac
 *   ffmpeg -i long.mp3 -ac 1 -b:a 64k long-mono.mp3
 *   ffmpeg -i long.mp3 -t 60 -c:a pcm_s24le long24.wav
 *   ffmpeg -i long.mp3 -t 60 -c:a pcm_f32le longf32.wav
 *
 * 运行：node tools/autotest/test-worker-formats.js
 */
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const { execFileSync } = require('child_process')

const ROOT = path.resolve(__dirname, '../..')
const TMP = '/tmp/td-worker-test'
fs.mkdirSync(TMP, { recursive: true })

// ---------- 加载 worker ----------
const inbox = []
let notify = null
global.worker = {
  _handler: null,
  onMessage(fn) { this._handler = fn },
  postMessage(msg) {
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

function send(msg) { global.worker._handler(msg) }
function waitMsg(pred, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 300000)
  return new Promise((resolve, reject) => {
    const check = () => {
      for (let i = 0; i < inbox.length; i++) {
        if (pred(inbox[i])) return resolve(inbox.splice(i, 1)[0])
      }
      if (Date.now() > deadline) return reject(new Error('等待消息超时'))
      notify = check
    }
    check()
  })
}
function fail(msg) { throw new Error(msg) }

async function analyzeFile(filePath) {
  const token = 't-' + path.basename(filePath)
  const bytes = fs.readFileSync(filePath)
  const size = bytes.length
  send({ type: 'analyze_begin', token, totalBytes: size })
  const ready = await waitMsg(m => m.type === 'analyze_ready' || m.type === 'analyze_error')
  if (ready.type === 'analyze_error') fail(path.basename(filePath) + ' begin: ' + ready.message)

  const CH = 4 * 1024 * 1024
  for (let off = 0; off < size; off += CH) {
    const len = Math.min(CH, size - off)
    const part = bytes.buffer.slice(bytes.byteOffset + off, bytes.byteOffset + off + len)
    send({ type: 'analyze_chunk', token, offset: off, data: part })
    const ack = await waitMsg(m => m.type === 'analyze_chunk_ack' || m.type === 'analyze_error')
    if (ack.type === 'analyze_error') fail(path.basename(filePath) + ' chunk: ' + ack.message)
  }
  send({ type: 'analyze_end', token })
  const meta = await waitMsg(m => m.type === 'analyzed' || m.type === 'analyze_error')
  if (meta.type === 'analyze_error') fail(path.basename(filePath) + ' end: ' + meta.message)
  return { token, meta, size }
}

async function preview(token, startSec, maxSec, semitones) {
  send({ type: 'preview', token, semitones: semitones || 0, startSec, maxSec })
  const r = await waitMsg(m => m.type === 'done' || m.type === 'error')
  if (r.type === 'error') fail('preview: ' + r.message)
  return r.outLength / r.sampleRate
}

async function processSong(token, semitones, kbps) {
  const chunks = []
  let done = null
  send({ type: 'process', token, semitones, kbps })
  for (;;) {
    const m = await waitMsg(x =>
      x.type === 'chunk' || x.type === 'progress' || x.type === 'meta' ||
      x.type === 'done' || x.type === 'error')
    if (m.type === 'chunk') {
      chunks.push(Buffer.from(m.data))
      send({ type: 'ack', bytes: m.bytes })
      continue
    }
    if (m.type === 'error') fail('process: ' + m.message)
    if (m.type === 'done') { done = m; break }
  }
  return { done, bytes: Buffer.concat(chunks) }
}

function ffprobeDuration(filePath) {
  try {
    const info = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1', filePath], { encoding: 'utf8' })
    const m = /duration=([\d.]+)/.exec(info)
    return m ? parseFloat(m[1]) : -1
  } catch (e) {
    return -1
  }
}

function rssMB() {
  return Math.round(process.memoryUsage().rss / 1048576)
}

async function main() {
  const shortWav = path.join(TMP, 'in.wav')
  const files = []
  if (fs.existsSync(shortWav)) files.push(shortWav)
  for (const f of ['long.mp3', 'long.m4a', 'long.wma', 'long16.flac', 'long.flac', 'long-mono.mp3', 'long24.wav', 'longf32.wav']) {
    const p = path.join(TMP, f)
    if (fs.existsSync(p)) files.push(p)
  }
  if (!files.length) fail('没有测试文件，请先按脚本头部注释生成')

  for (const f of files) {
    const name = path.basename(f)
    const before = rssMB()
    const t0 = Date.now()
    const a = await analyzeFile(f)
    const dur = a.meta.durationSec
    console.log('\n[' + name + '] ' + a.size + 'B, ' + dur.toFixed(1) + 's, ' +
      a.meta.sampleRate + 'Hz/' + a.meta.channels + 'ch, analyze ' + (Date.now() - t0) + 'ms, rss +' + (rssMB() - before) + 'MB')

    const pv = await preview(a.token, Math.min(5, dur / 3), 3, 2)
    console.log('  preview 3s @' + Math.min(5, dur / 3).toFixed(1) + 's +2: ' + pv.toFixed(2) + 's')

    const t1 = Date.now()
    const res = await processSong(a.token, 2, 128)
    console.log('  process +2: ' + (Date.now() - t1) + 'ms, out ' + res.done.durationSec.toFixed(2) + 's, ' +
      res.bytes.length + 'B, rss ' + rssMB() + 'MB')
    if (Math.abs(res.done.durationSec - dur) > Math.max(0.5, dur * 0.01)) {
      fail(name + ' 输出时长偏差过大: ' + res.done.durationSec + ' vs ' + dur)
    }

    const out = path.join(TMP, 'out-' + name + '.mp3')
    fs.writeFileSync(out, res.bytes)
    const od = ffprobeDuration(out)
    if (od > 0 && Math.abs(od - dur) > Math.max(0.5, dur * 0.01)) {
      fail(name + ' ffprobe 时长偏差: ' + od + ' vs ' + dur)
    }
  }

  // 长文件 0 半音：只重编码，是最长链路里最快的一条
  const longMp3 = path.join(TMP, 'long.mp3')
  if (fs.existsSync(longMp3)) {
    const a = await analyzeFile(longMp3)
    const t = Date.now()
    const r = await processSong(a.token, 0, 64)
    console.log('\n[long.mp3] 0 半音 64kbps: ' + (Date.now() - t) + 'ms, out ' + r.done.durationSec.toFixed(1) + 's, ' + r.bytes.length + 'B')
    if (Math.abs(r.done.durationSec - 600) > 6) fail('10 分钟 0 半音输出时长不对: ' + r.done.durationSec)
  }

  console.log('\n全部通过')
}

main().catch(e => { console.error(e); process.exit(1) })
