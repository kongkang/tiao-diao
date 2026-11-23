// 输出码率与耗时预估
//
// 平台硬约束：writeFile/appendFile 单文件 100MB，本地用户文件共 200MB。
// 时长不设上限，但如果 160kbps 装不下就逐级降码率；降到最低仍装不下时
// 明确告诉用户“超出微信单文件上限”，而不是静默失败或无限降质。

const config = require('../config.js')

const MAX_OUTPUT_BYTES = (config.MAX_OUTPUT_MB || 95) * 1024 * 1024
const STEREO_LADDER = [160, 128, 112, 96, 80, 64]
const MONO_LADDER = [128, 112, 96, 80, 64, 48, 32, 24]
const OVERHEAD = 1.02   // MP3 帧头/尾部余量

function maxOutputBytes() {
  // 运行时读取：开发者工具模拟器本地文件配额较小，测试可临时调低 config.MAX_OUTPUT_MB
  return (config.MAX_OUTPUT_MB || 95) * 1024 * 1024
}

function clampKbpsForRate(kbps, sampleRate) {
  let max = 320
  if (sampleRate <= 12000) max = 64
  else if (sampleRate < 32000) max = 160
  return Math.max(8, Math.min(max, kbps | 0 || 160))
}

/**
 * 选一个能装进 95MB 的最高码率。
 * @param {number} durationSec
 * @param {number} channels
 * @param {number} sampleRate
 * @returns {{kbps:number, reduced:boolean, impossible:boolean, estimatedBytes:number}}
 */
function pickKbps(durationSec, channels, sampleRate) {
  const ladder = channels > 1 ? STEREO_LADDER : MONO_LADDER
  const dur = durationSec > 0 ? durationSec : 0
  if (!dur) {
    return { kbps: config.MP3_KBPS, reduced: false, impossible: false, estimatedBytes: 0 }
  }
  let last = { kbps: ladder[ladder.length - 1], reduced: true, impossible: true, estimatedBytes: 0 }
  const cap = maxOutputBytes()
  for (let i = 0; i < ladder.length; i++) {
    const kbps = clampKbpsForRate(ladder[i], sampleRate)
    const bytes = dur * kbps * 1000 / 8 * OVERHEAD
    const item = {
      kbps,
      reduced: kbps < config.MP3_KBPS,
      impossible: bytes > cap,
      estimatedBytes: Math.round(bytes),
    }
    if (bytes <= cap) return item
    last = item
  }
  return last
}

/**
 * 处理耗时预估（秒）。经验值来自真机：变调约 0.1~0.15 倍实时，原调只重编码更快。
 * 长音频受 CPU 影响很大，这个数只用于给用户预期，不参与任何逻辑。
 */
function estimateProcessSec(durationSec, semitones) {
  const dur = Math.max(0, durationSec || 0)
  const factor = (semitones | 0) === 0 ? 0.03 : 0.12
  return Math.max(8, Math.round(dur * factor))
}

function fmtEstimate(sec) {
  const s = Math.max(1, Math.round(sec))
  if (s < 60) return s + ' 秒'
  const m = Math.round(s / 60)
  return m + ' 分钟'
}

module.exports = {
  MAX_OUTPUT_BYTES,
  STEREO_LADDER,
  MONO_LADDER,
  clampKbpsForRate,
  pickKbps,
  estimateProcessSec,
  fmtEstimate,
}
