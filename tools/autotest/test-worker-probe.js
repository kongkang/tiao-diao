#!/usr/bin/env node
/**
 * Worker 解码自检(probe)回归(不需要开发者工具)
 *
 * 给 workers/pitch.js 的运行环境打桩(postMessage / WXWebAssembly),在 Node 里原样加载它,
 * 走真实的 analyze → probe → preview 协议。自检是「解析成功才允许下一步」这道门的依据,
 * 这里把它该放行的、该拦下的都钉住。
 *
 * 运行：node tools/autotest/test-worker-probe.js
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const zlib = require('zlib')
const { execFileSync } = require('child_process')

const ROOT = path.resolve(__dirname, '../..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'td-worker-probe-'))

// ---------- Worker 运行环境桩 ----------
const inbox = []
let onMessage = null
global.worker = {
  postMessage(msg) { inbox.push(msg) },
  onMessage(fn) { onMessage = fn },
}
global.WXWebAssembly = {
  instantiate(file, imports) {
    const raw = zlib.brotliDecompressSync(fs.readFileSync(path.join(ROOT, 'miniprogram', file)))
    return WebAssembly.instantiate(raw, imports)
  },
}
require(path.join(ROOT, 'miniprogram/workers/pitch.js'))

function send(msg) { onMessage(msg) }

function wait(type, timeoutMs) {
  const i = inbox.findIndex(m => m.type === type)
  if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0])
  return new Promise((resolve, reject) => {
    const t0 = Date.now()
    const timer = setInterval(() => {
      const j = inbox.findIndex(m => m.type === type)
      if (j >= 0) { clearInterval(timer); resolve(inbox.splice(j, 1)[0]); return }
      const err = inbox.findIndex(m => m.type === 'error' || m.type === 'analyze_error')
      if (err >= 0) { clearInterval(timer); reject(new Error('Worker 报错: ' + inbox[err].message)); return }
      if (Date.now() - t0 > (timeoutMs || 30000)) { clearInterval(timer); reject(new Error('等不到 ' + type)) }
    }, 5)
  })
}

/** 像主线程那样把文件喂进去(4MB 分块) */
async function analyze(bytes, label) {
  const token = 't-' + (label || Math.random())
  send({ type: 'analyze_begin', token, totalBytes: bytes.length })
  await wait('analyze_ready')
  for (let off = 0; off < bytes.length; off += 4 * 1024 * 1024) {
    send({ type: 'analyze_chunk', token, offset: off, data: bytes.subarray(off, Math.min(off + 4 * 1024 * 1024, bytes.length)) })
    await wait('analyze_chunk_ack')
  }
  send({ type: 'analyze_end', token })
  const meta = await wait('analyzed')
  return { token, meta }
}

function probe(token) {
  send({ type: 'probe', token })
  return wait('probe_result')
}

function preview(token, startSec, maxSec) {
  send({ type: 'preview', token, semitones: 0, startSec, maxSec })
  return wait('done')
}

// ---------- 夹具 ----------
const F = {}
function mk(name, args) {
  const file = path.join(TMP, name)
  execFileSync('ffmpeg', ['-v', 'error', '-y'].concat(args, [file]))
  return fs.readFileSync(file)
}
const sine = (d, extra) => ['-f', 'lavfi', '-i'].concat(['sine=frequency=440:sample_rate=44100:duration=' + d], extra || [])

function buildFixtures() {
  F.wav = mk('sine.wav', sine(30), ['-c:a', 'pcm_s16le'])
  F.m4a = mk('sine.m4a', sine(30), ['-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart'])
  F.mp3 = mk('sine.mp3', sine(30), ['-c:a', 'libmp3lame', '-b:a', '96k'])
  F.silent = mk('silent.wav', ['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', '30', '-c:a', 'pcm_s16le'])
  F.lateStart = mk('late.wav', ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=30,adelay=15000|15000', '-c:a', 'pcm_s16le'])
  // 截断:只留前 60% 的字节。wav 头里写的还是完整时长,但数据只到 18 秒
  F.truncatedWav = F.wav.subarray(0, Math.floor(F.wav.length * 0.6))
  F.truncatedM4a = F.m4a.subarray(0, Math.floor(F.m4a.length * 0.6))
  // 冒充媒体的垃圾
  F.garbage = Buffer.concat([F.m4a.subarray(0, 40), Buffer.alloc(200000, 0x5a)])
  // 分片式「中段切片」:init + 中间几片,头部写的还是整段时长(和 B站中段截取一个形态)
  F.midSlice = (() => {
    const full = mk('frag.m4a', ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=60',
      '-c:a', 'aac', '-ac', '2', '-movflags', '+dash+empty_moov+default_base_moof', '-frag_duration', '2000000'])
    const tops = []
    let p = 0
    while (p + 8 <= full.length) {
      const size = full.readUInt32BE(p)
      if (size === 0) { tops.push({ type: 'mfra', start: p, end: full.length }); break }
      tops.push({ type: full.toString('latin1', p + 4, p + 8), start: p, end: p + size })
      p += size
    }
    // (ffmpeg 的 dash 模式每个分片前都有一个 sidx,所以要按 moof 列表来数,不能隔一个算一个)
    const moofs = tops.filter(b => b.type === 'moof')
    assert.strictEqual(moofs.length, 30, '夹具应是 30 个 2 秒分片')
    return Buffer.concat([full.subarray(0, moofs[0].start), full.subarray(moofs[10].start, moofs[20].start)])   // 第 10~20 片 = 20 秒
  })()
}

// ---------- 用例 ----------
const tests = []
function test(name, fn) { tests.push({ name, fn }) }

async function main() {
  buildFixtures()

  for (const [name, bytes] of [['wav', () => F.wav], ['m4a', () => F.m4a], ['mp3', () => F.mp3]]) {
    test(name + ' · 正常文件:通过,时长与声明一致', async () => {
      const { token, meta } = await analyze(bytes())
      const r = await probe(token)
      assert.strictEqual(r.ok, true, name + ' 应通过: ' + r.message)
      assert(Math.abs(r.durationSec - 30) < 0.5, name + ' 时长 ' + r.durationSec)
      assert(r.peak > 0.01, name + ' 应有声音')   // 夹具正弦波默认幅度 1/8
      void meta
    })
    test(name + ' · 自检之后试听仍从开头开始', async () => {
      const { token } = await analyze(bytes())
      await probe(token)
      const pv = await preview(token, 0, 2)
      assert.strictEqual(pv.outLength, 2 * 44100, name + ' 应从 0 秒起给足 2 秒')
    })
  }
  test('截断的 wav(只剩 60%)· 解码器按实际数据算时长,通过', async () => {
    const { token } = await analyze(F.truncatedWav)
    const r = await probe(token)
    assert.strictEqual(r.ok, true, r.message)
    assert(Math.abs(r.durationSec - 18) < 1.5, '时长应接近 18 秒: ' + r.durationSec)
  })
  test('截断的 m4a(只剩 60%)· 打开时就拦下', async () => {
    await assert.rejects(analyze(F.truncatedM4a), /Worker 报错/)
  })
  test('分片式中段切片(头部写整段时长)· 实测出真实长度', async () => {
    const { token } = await analyze(F.midSlice)
    const r = await probe(token)
    assert.strictEqual(r.ok, true, r.message)
    assert(Math.abs(r.durationSec - 20) < 1.5, '中段 10 片 × 2 秒 = 20 秒,实测 ' + r.durationSec)
  })
  test('前 15 秒静音、之后才有声 · 通过', async () => {
    const { token } = await analyze(F.lateStart)
    const r = await probe(token)
    assert.strictEqual(r.ok, true, r.message)
  })
  test('整首都是数字静音 · 拦下', async () => {
    const { token } = await analyze(F.silent)
    const r = await probe(token)
    assert.strictEqual(r.ok, false)
    assert(/没有解出声音/.test(r.message), r.message)
  })
  test('损坏的文件 · analyze 就拦下', async () => {
    await assert.rejects(analyze(F.garbage), /Worker 报错/)
  })
  test('会话丢了(Worker 被杀后 token 失效)· 拦下并提示重选', async () => {
    const r = await probe('t-not-exist')
    assert.strictEqual(r.ok, false)
    assert(/重新选一次/.test(r.message), r.message)
  })
  test('时长很短(< 4 秒)的文件 · 不查结尾,照样通过', async () => {
    const tiny = mk('tiny.wav', sine(3), ['-c:a', 'pcm_s16le'])
    const { token } = await analyze(tiny)
    const r = await probe(token)
    assert.strictEqual(r.ok, true, r.message)
  })

  let pass = 0
  let fail = 0
  for (const t of tests) {
    try {
      await t.fn()
      pass++
      console.log('  ✓ ' + t.name)
    } catch (e) {
      fail++
      console.log('  ✗ ' + t.name + '\n      ' + String(e && e.message || e).split('\n').join('\n      '))
    }
  }
  console.log('\n' + pass + ' 过 / ' + fail + ' 败   (临时目录 ' + TMP + ')')
  process.exit(fail ? 1 : 0)
}

main().catch(e => { console.error(e); process.exit(1) })
