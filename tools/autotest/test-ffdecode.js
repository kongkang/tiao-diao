#!/usr/bin/env node
/**
 * FFmpeg WASM 解码器直测（Node）：open / pull / seek / tell / 24-bit
 *
 * 覆盖 /tmp/td-worker-test 下的 in.wav、long.mp3、long.m4a、long.wma、
 * long16.flac、long.flac（24-bit）。没有的文件自动跳过。
 *
 * 运行：node tools/autotest/test-ffdecode.js
 */
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const ROOT = path.resolve(__dirname, '../..')
const TMP = '/tmp/td-worker-test'
const WASM = path.join(ROOT, 'miniprogram/wasm/ffdecode.wasm.br')

let exp = null
function F(n) { return exp[n] || exp['_' + n] }

async function load() {
  const raw = zlib.brotliDecompressSync(fs.readFileSync(WASM))
  const imports = {
    env: { emscripten_notify_memory_growth: function () {} },
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
        dv.setUint32(pc, 0, true); dv.setUint32(pbs, 0, true)
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

function open(file) {
  const bytes = fs.readFileSync(file)
  const ptr = F('malloc')(bytes.length)
  if (!ptr) throw new Error('malloc failed')
  new Uint8Array(exp.memory.buffer).set(bytes, ptr)
  if (F('ff_open')(ptr, bytes.length) < 0) {
    throw new Error(path.basename(file) + ' open failed err=' + F('ff_err')())
  }
  return { ptr, size: bytes.length }
}

function pull(nFloats) {
  const p = F('malloc')(nFloats * 4)
  const got = F('ff_pull')(p, nFloats)
  let rms = 0
  if (got > 0) {
    const v = new Float32Array(exp.memory.buffer, p, got)
    for (let i = 0; i < got; i++) rms += v[i] * v[i]
    rms = Math.sqrt(rms / got)
  }
  F('free')(p)
  return { got, rms }
}

function assert(cond, msg) { if (!cond) throw new Error(msg) }

async function testFile(file, seekTolerance) {
  const name = path.basename(file)
  if (!fs.existsSync(file)) { console.log('skip (missing):', name); return }
  const h = open(file)
  const rate = F('ff_rate')()
  const ch = F('ff_channels')()
  const dur = F('ff_duration_sec')()
  console.log('\n[' + name + '] rate=' + rate + ' ch=' + ch + ' dur=' + dur.toFixed(1))

  let r = pull(4096)
  assert(r.got > 0, name + ' first pull=0')
  const t0 = F('ff_tell')()
  assert(t0 >= 0 && t0 < 1, name + ' tell after first pull=' + t0)

  for (const target of [Math.min(5, dur / 3), Math.min(30, dur / 2), Math.max(0, dur - 5)]) {
    F('ff_close')()
    // 重新 open（保留输入）
    if (F('ff_open')(h.ptr, h.size) < 0) throw new Error(name + ' reopen failed')
    if (F('ff_seek')(target) < 0) throw new Error(name + ' seek ' + target + ' err=' + F('ff_err')())
    const rr = pull(4096)
    assert(rr.got > 0, name + ' pull after seek=0 target=' + target)
    const t = F('ff_tell')()
    const expected = target + rr.got / ch / rate
    const diff = Math.abs(t - expected)
    console.log('  seek ' + target.toFixed(1) + 's → tell ' + t.toFixed(2) + 's (diff ' + diff.toFixed(2) + 's, rms ' + rr.rms.toFixed(3) + ')')
    assert(diff <= seekTolerance, name + ' seek accuracy diff=' + diff)
  }

  F('ff_close')()
  F('free')(h.ptr)
}

async function main() {
  await load()
  const tol = 1.0
  await testFile(path.join(TMP, 'in.wav'), 0.3)
  await testFile(path.join(TMP, 'long.mp3'), 0.3)
  await testFile(path.join(TMP, 'long.m4a'), 0.5)
  await testFile(path.join(TMP, 'long.wma'), tol)
  await testFile(path.join(TMP, 'long16.flac'), 0.3)
  await testFile(path.join(TMP, 'long.flac'), 0.3)   // 24-bit，验证 S32P
  console.log('\n全部通过')
}

main().catch(e => { console.error(e); process.exit(1) })
