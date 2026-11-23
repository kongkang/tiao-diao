#!/usr/bin/env node
/**
 * 流式 DSP 等价性测试（不需要开发者工具）
 *
 * 验证 createStreamingResampler / createStreamingStretcher / createPitchStream
 * 与整首参考实现 resample / makeWsola().stretch 逐样本一致。
 *
 * 运行：node tools/autotest/unit-pitch-dsp.js
 */
const assert = require('assert')
const dsp = require('../../miniprogram/workers/libs/pitch-dsp.js')

function signal(n, seed) {
  const out = new Float32Array(n)
  let s = seed || 1
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    const noise = (s / 0x7fffffff) * 2 - 1
    out[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / 44100) + 0.2 * noise
  }
  return out
}

function concat(arrs, len) {
  const out = new Float32Array(len)
  let p = 0
  for (let i = 0; i < arrs.length; i++) {
    out.set(arrs[i], p)
    p += arrs[i].length
  }
  assert.strictEqual(p, len, 'concat length mismatch')
  return out
}

function maxDiff(a, b) {
  const n = Math.min(a.length, b.length)
  let m = 0
  for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(a[i] - b[i]))
  return { max: m, lenA: a.length, lenB: b.length }
}

function feed(stream, input, blocks, R) {
  const outs = []
  let p = 0
  let bi = 0
  while (p < input.length) {
    const n = Math.min(blocks[bi % blocks.length], input.length - p)
    bi++
    const L = input.subarray(p, p + n)
    const RR = R ? R.subarray(p, p + n) : null
    const o = stream.push(L, RR)
    if (o.L.length) outs.push(o.L.slice())
    p += n
  }
  const f = stream.flush()
  if (f.L.length) outs.push(f.L.slice())
  return outs
}

function feedStereo(stream, L, R, blocks) {
  const outsL = []
  const outsR = []
  let p = 0
  let bi = 0
  while (p < L.length) {
    const n = Math.min(blocks[bi % blocks.length], L.length - p)
    bi++
    const o = stream.push(L.subarray(p, p + n), R.subarray(p, p + n))
    if (o.L.length) { outsL.push(o.L.slice()); outsR.push(o.R.slice()) }
    p += n
  }
  const f = stream.flush()
  if (f.L.length) { outsL.push(f.L.slice()); outsR.push(f.R.slice()) }
  return { outsL, outsR }
}

function sumLen(arrs) { return arrs.reduce((n, a) => n + a.length, 0) }

const BLOCKS = [256, 1024, 4096, 16384, 44100, 7, 999]

let checks = 0

// ---- 1. 重采样：流式 vs 整首 ----
for (const semitones of [-12, -7, -3, -1, 1, 2, 5, 12]) {
  const ratio = Math.pow(2, semitones / 12)
  const input = signal(44100 * 3 + 317, semitones + 10)
  const whole = dsp.resample(input, ratio)
  const stream = dsp.createStreamingResampler(ratio)
  const outs = feed(stream, input, BLOCKS)
  const got = concat(outs, sumLen(outs))
  const d = maxDiff(whole, got)
  assert.strictEqual(d.lenA, d.lenB, 'resample len ' + semitones + ': ' + d.lenA + ' vs ' + d.lenB)
  assert.ok(d.max < 1e-7, 'resample diff ' + semitones + ': ' + d.max)
  checks++
  console.log('resample ok', semitones, 'semitones, len', whole.length, 'maxDiff', d.max.toExponential(2))
}

// ---- 2. WSOLA：流式 vs 整首（输入先用整首重采样） ----
for (const semitones of [-12, -7, -3, -1, 1, 2, 5, 12]) {
  const ratio = Math.pow(2, semitones / 12)
  const raw = signal(44100 * 3 + 317, semitones + 20)
  const input = dsp.resample(raw, ratio)
  const whole = dsp.makeWsola(44100).stretch(input, ratio)
  const stream = dsp.createStreamingStretcher(44100, ratio)
  const outs = feed(stream, input, BLOCKS)
  const got = concat(outs, sumLen(outs))
  const d = maxDiff(whole, got)
  assert.strictEqual(d.lenA, d.lenB, 'wsola len ' + semitones + ': ' + d.lenA + ' vs ' + d.lenB)
  assert.ok(d.max < 1e-6, 'wsola diff ' + semitones + ': ' + d.max)
  checks++
  console.log('wsola ok', semitones, 'semitones, len', whole.length, 'maxDiff', d.max.toExponential(2))
}

// ---- 3. 组合：流式 vs 整首 ----
for (const semitones of [-12, -5, -1, 1, 3, 7, 12]) {
  const ratio = Math.pow(2, semitones / 12)
  const L = signal(44100 * 4 + 123, semitones + 30)
  const R = signal(44100 * 4 + 123, semitones + 40)
  const wholeL = dsp.makeWsola(44100).stretch(dsp.resample(L, ratio), ratio)
  const wholeR = dsp.makeWsola(44100).stretch(dsp.resample(R, ratio), ratio)
  const stream = dsp.createPitchStream(44100, semitones, 2)
  const got = feedStereo(stream, L, R, BLOCKS)
  const gl = concat(got.outsL, sumLen(got.outsL))
  const gr = concat(got.outsR, sumLen(got.outsR))
  const dl = maxDiff(wholeL, gl)
  const dr = maxDiff(wholeR, gr)
  assert.strictEqual(dl.lenA, dl.lenB, 'pitch stereo L len ' + semitones)
  assert.strictEqual(dr.lenA, dr.lenB, 'pitch stereo R len ' + semitones)
  assert.ok(dl.max < 1e-6 && dr.max < 1e-6, 'pitch stereo diff ' + semitones + ': ' + dl.max + '/' + dr.max)
  checks++
  console.log('pitch stereo ok', semitones, 'semitones, len', wholeL.length, 'maxDiff', dl.max.toExponential(2), dr.max.toExponential(2))
}

// ---- 4. 0 半音直通 ----
{
  const L = signal(10000, 1)
  const R = signal(10000, 2)
  const stream = dsp.createPitchStream(44100, 0, 2)
  const got = feedStereo(stream, L, R, [333])
  const gl = concat(got.outsL, sumLen(got.outsL))
  const gr = concat(got.outsR, sumLen(got.outsR))
  assert.deepStrictEqual(Array.from(gl), Array.from(L))
  assert.deepStrictEqual(Array.from(gr), Array.from(R))
  checks++
  console.log('passthrough ok')
}

// ---- 5. 极短输入（不足一个 WSOLA 窗口） ----
for (const n of [1, 100, 1763, 1764, 1765]) {
  const input = signal(n, 7)
  for (const semitones of [-3, 2]) {
    const ratio = Math.pow(2, semitones / 12)
    const whole = dsp.makeWsola(44100).stretch(dsp.resample(input, ratio), ratio)
    const stream = dsp.createPitchStream(44100, semitones, 1)
    const outs = feed(stream, input, [97])
    const got = concat(outs, sumLen(outs))
    const d = maxDiff(whole, got)
    assert.strictEqual(d.lenA, d.lenB, 'short len n=' + n + ' s=' + semitones)
    assert.ok(d.max < 1e-6, 'short diff n=' + n + ' s=' + semitones + ': ' + d.max)
    checks++
  }
}
console.log('short input ok')

console.log('\n全部通过：' + checks + ' 项')
