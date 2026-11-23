/**
 * 变调 DSP（流式版）
 *
 * 背景：v3 的全曲处理是「整首 PCM → 整首重采样 → 整首 WSOLA → 整首 MP3」，
 * 峰值内存随歌曲长度线性增长（8 分钟歌 250MB+，真机被杀）。
 * 这里把同一条链路改成可流式喂块的实现：
 *   createPitchStream(sampleRate, semitones, channels)
 *     .push(L, R)  → 输入任意长度的一块，返回已定稿的输出块（可能为空）
 *     .flush()     → 收尾（把尾部不足一块的输入也吐出来）
 *
 * 流式结果与整首实现（resample + makeWsola().stretch）逐样本一致，
 * tools/autotest/unit-pitch-dsp.js 有等价性测试；改算法前先跑它。
 */

function f32ToI16(f32) {
  const out = new Int16Array(f32.length)
  for (let i = 0; i < f32.length; i++) {
    let s = f32[i]
    if (s > 1) s = 1
    else if (s < -1) s = -1
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return out
}

function i16ToF32(i16) {
  const out = new Float32Array(i16.length)
  for (let i = 0; i < i16.length; i++) out[i] = i16[i] / 0x8000
  return out
}

// ============ 整首参考实现（测试基准，勿改） ============

function resample(input, ratio) {
  if (Math.abs(ratio - 1) < 1e-9) return input
  const newLen = Math.max(1, Math.floor(input.length / ratio))
  const out = new Float32Array(newLen)
  for (let i = 0; i < newLen; i++) {
    const src = i * ratio
    const i0 = Math.floor(src)
    const frac = src - i0
    const a = input[i0]
    const b = i0 + 1 < input.length ? input[i0 + 1] : a
    out[i] = a + (b - a) * frac
  }
  return out
}

// 参数以毫秒定义，与 SoundTouch 默认一致：sequence 40ms / seekwindow 15ms / overlap 8ms
function makeWsola(sampleRate) {
  const SEQ = Math.round(sampleRate * 0.040)
  const SEEK = Math.round(sampleRate * 0.015)
  const OVL = Math.round(sampleRate * 0.008)

  const win = new Float32Array(OVL)
  for (let i = 0; i < OVL; i++) win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (OVL - 1)))

  function stretch(input, factor) {
    if (Math.abs(factor - 1) < 1e-9) return input
    const est = Math.ceil(input.length * factor) + 2 * SEQ
    const result = new Float32Array(est)
    let w = 0

    const first = input.subarray(0, Math.min(SEQ, input.length))
    result.set(first, w)
    w += first.length

    let prevEnd = first
    const tplStart = SEQ - OVL
    const halfSeek = Math.floor(SEEK / 2)
    const step = Math.max(1, Math.round((SEQ - OVL) / factor))
    let nominal = 0
    const blended = new Float32Array(SEQ)

    while (nominal + step + halfSeek + SEQ + OVL < input.length) {
      nominal += step
      const base = nominal - halfSeek
      let bestOffset = 0
      let bestCorr = -Infinity
      for (let s = 0; s < SEEK; s++) {
        let corr = 0
        const b = base + s
        for (let i = 0; i < OVL; i += 2) {
          corr += prevEnd[tplStart + i] * input[b + i]
        }
        if (corr > bestCorr) { bestCorr = corr; bestOffset = s }
      }

      const block = input.subarray(base + bestOffset, base + bestOffset + SEQ)
      for (let i = 0; i < OVL; i++) {
        const wgt = win[i]
        blended[i] = prevEnd[tplStart + i] * (1 - wgt) + block[i] * wgt
      }
      for (let i = OVL; i < SEQ; i++) blended[i] = block[i]

      if (w + SEQ > result.length) break
      result.set(blended, w)
      w += SEQ - OVL
      prevEnd = blended
    }
    return result.subarray(0, w)
  }

  return { stretch }
}

// ============ 流式重采样 ============

/**
 * 输出下标全局推进：第 j 个输出样本 = input[j * ratio] 的线性插值。
 * 块边界不重置 j，因此与整首 resample 完全一致（包括最后不足一点的尾巴）。
 */
function createStreamingResampler(ratio) {
  if (Math.abs(ratio - 1) < 1e-9) {
    return {
      push(L, R) { return { L, R } },
      flush() { return { L: new Float32Array(0), R: null } },
    }
  }

  let bufL = new Float32Array(0)
  let bufR = null
  let base = 0          // bufL[0] 对应的输入帧号
  let nextJ = 0         // 下一个输出样本下标
  let done = false

  function append(L, R) {
    if (!L || !L.length) return
    const merged = new Float32Array(bufL.length + L.length)
    merged.set(bufL)
    merged.set(L, bufL.length)
    bufL = merged
    if (R) {
      if (!bufR) bufR = new Float32Array(merged.length)
      else if (bufR.length !== merged.length) {
        const g = new Float32Array(merged.length)
        g.set(bufR)
        bufR = g
      }
      bufR.set(R, merged.length - L.length)
    }
  }

  function dropBefore(idx) {
    const d = idx - base
    if (d <= 0) return
    bufL = bufL.slice(d)
    if (bufR) bufR = bufR.slice(d)
    base += d
  }

  function produce(total, allowTail) {
    // 可正常插值的条件：i0 和 i0+1 都已到齐（i0 = floor(j*ratio)）
    let count = 0
    while ((nextJ + count) * ratio < total - 1) count++
    // 收尾：整首 resample 的 newLen = floor(total / ratio)，最后一个点允许 b=a
    if (allowTail) {
      const totalOut = Math.max(1, Math.floor(total / ratio))
      if (nextJ + count < totalOut) count = totalOut - nextJ
    }
    if (count <= 0) return { L: new Float32Array(0), R: null }

    const outL = new Float32Array(count)
    const outR = bufR ? new Float32Array(count) : null
    for (let k = 0; k < count; k++) {
      const j = nextJ + k
      const src = j * ratio
      const i0 = Math.floor(src)
      const frac = src - i0
      const a = bufL[i0 - base]
      const b = i0 + 1 < total ? bufL[i0 + 1 - base] : a
      outL[k] = a + (b - a) * frac
      if (outR) {
        const ar = bufR[i0 - base]
        const br = i0 + 1 < total ? bufR[i0 + 1 - base] : ar
        outR[k] = ar + (br - ar) * frac
      }
    }
    nextJ += count
    dropBefore(Math.floor(nextJ * ratio))
    return { L: outL, R: outR }
  }

  return {
    push(L, R) {
      append(L, R)
      return produce(base + bufL.length, false)
    },
    flush() {
      if (done) return { L: new Float32Array(0), R: null }
      done = true
      return produce(base + bufL.length, true)
    },
  }
}

// ============ 流式 WSOLA ============

/**
 * 与整首 makeWsola().stretch 对齐的流式版本。
 * 状态：nominal（重采样后输入的名义位置）、prevTail（上一块最后 OVL 个样本）、
 * 滚动输入缓冲。每次 push 只吐出“不会再被下一块覆盖”的样本；
 * 最后一块的 OVL 尾巴按整首实现的语义丢弃（整首 subarray(0, w) 也不含它）。
 */
function createStreamingStretcher(sampleRate, factor) {
  const SEQ = Math.round(sampleRate * 0.040)
  const SEEK = Math.round(sampleRate * 0.015)
  const OVL = Math.round(sampleRate * 0.008)
  const step = Math.max(1, Math.round((SEQ - OVL) / factor))
  const halfSeek = Math.floor(SEEK / 2)
  const tplStart = SEQ - OVL

  const win = new Float32Array(OVL)
  for (let i = 0; i < OVL; i++) win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (OVL - 1)))

  const passthrough = Math.abs(factor - 1) < 1e-9

  let bufL = new Float32Array(0)
  let bufR = null
  let base = 0
  let nominal = 0
  let started = false
  let prevL = null
  let prevR = null
  let done = false
  // 复用输出/混合缓冲：worker 每块编码完即丢，不会保留上一块的引用
  let outL = new Float32Array(0)
  let outR = null
  let bl = null
  let br = null

  function append(L, R) {
    if (!L || !L.length) return
    const merged = new Float32Array(bufL.length + L.length)
    merged.set(bufL)
    merged.set(L, bufL.length)
    bufL = merged
    if (R) {
      if (!bufR) {
        bufR = new Float32Array(merged.length)
      } else if (bufR.length !== merged.length) {
        const g = new Float32Array(merged.length)
        g.set(bufR)
        bufR = g
      }
      bufR.set(R, merged.length - L.length)
    }
  }

  function dropBefore(idx) {
    const d = idx - base
    if (d <= 0) return
    bufL = bufL.slice(d)
    if (bufR) bufR = bufR.slice(d)
    base += d
  }

  /** 扩输出缓冲（保留已写入的 w 个样本） */
  function ensureOut(cap, w) {
    if (outL.length >= cap && (!bufR || (outR && outR.length >= cap))) return
    const n = Math.max(cap, outL.length * 2, 4096)
    const gL = new Float32Array(n)
    if (w > 0) gL.set(outL.subarray(0, w))
    outL = gL
    if (bufR) {
      const gR = new Float32Array(n)
      if (w > 0 && outR) gR.set(outR.subarray(0, w))
      outR = gR
    }
  }

  /** 产出所有已可定稿的块。allowTail=true 时按 EOF 处理（input.length 已定）。 */
  function produce(allowTail) {
    const avail = base + bufL.length
    // 输出 ≈ 输入 × factor；多留 3 个 SEQ 给起播块和块边界
    let cap = Math.ceil((avail - base) * factor) + 3 * SEQ + 64
    if (cap < SEQ + 1) cap = SEQ + 1
    ensureOut(cap, 0)
    let w = 0

    if (!started) {
      if (avail < SEQ) {
        if (!allowTail) return { L: new Float32Array(0), R: null }
        // 总长不足一个 SEQ：整首实现返回全部输入
        const n = bufL.length
        ensureOut(n, 0)
        outL.set(bufL.subarray(0, n), 0)
        if (bufR) outR.set(bufR.subarray(0, n), 0)
        w = n
        started = true
        bufL = new Float32Array(0)
        if (bufR) bufR = new Float32Array(0)
        base = avail
        return { L: outL.subarray(0, w), R: outR ? outR.subarray(0, w) : null }
      }
      outL.set(bufL.subarray(0, SEQ), 0)
      if (bufR) outR.set(bufR.subarray(0, SEQ), 0)
      w = SEQ
      if (!prevL) {
        prevL = new Float32Array(OVL)
        if (bufR) prevR = new Float32Array(OVL)
      }
      prevL.set(bufL.subarray(SEQ - OVL, SEQ))
      if (bufR) prevR.set(bufR.subarray(SEQ - OVL, SEQ))
      started = true
      dropBefore(Math.max(0, step - halfSeek))
    }

    if (!bl) {
      bl = new Float32Array(SEQ)
      br = bufR ? new Float32Array(SEQ) : null
    }

    while (nominal + step + halfSeek + SEQ + OVL < avail) {
      nominal += step
      const b = nominal - halfSeek - base
      let bestOffsetL = 0
      let bestCorrL = -Infinity
      let bestOffsetR = 0
      let bestCorrR = -Infinity
      for (let s = 0; s < SEEK; s++) {
        const bb = b + s
        let corrL = 0
        for (let i = 0; i < OVL; i += 2) {
          corrL += prevL[i] * bufL[bb + i]
        }
        if (corrL > bestCorrL) { bestCorrL = corrL; bestOffsetL = s }
        if (bufR) {
          let corrR = 0
          for (let i = 0; i < OVL; i += 2) {
            corrR += prevR[i] * bufR[bb + i]
          }
          if (corrR > bestCorrR) { bestCorrR = corrR; bestOffsetR = s }
        }
      }

      const startL = b + bestOffsetL
      const startR = b + bestOffsetR
      for (let i = 0; i < OVL; i++) {
        const wgt = win[i]
        bl[i] = prevL[i] * (1 - wgt) + bufL[startL + i] * wgt
        if (br) br[i] = prevR[i] * (1 - wgt) + bufR[startR + i] * wgt
      }
      for (let i = OVL; i < SEQ; i++) {
        bl[i] = bufL[startL + i]
        if (br) br[i] = bufR[startR + i]
      }

      // 吐到下一块会覆盖的位置之前：前 SEQ-OVL 个样本定稿
      if (w + SEQ > outL.length) ensureOut(w + SEQ + 64, w)
      outL.set(bl.subarray(0, SEQ - OVL), w)
      if (br) outR.set(br.subarray(0, SEQ - OVL), w)
      w += SEQ - OVL
      prevL.set(bl.subarray(SEQ - OVL, SEQ))
      if (br) prevR.set(br.subarray(SEQ - OVL, SEQ))
    }

    // 下一块只可能从这一步之后开始读
    if (!allowTail) dropBefore(Math.max(base, nominal + step - halfSeek))

    if (!w) return { L: new Float32Array(0), R: null }
    return { L: outL.subarray(0, w), R: bufR ? outR.subarray(0, w) : null }
  }

  if (passthrough) {
    return {
      push(L, R) { return { L, R } },
      flush() { return { L: new Float32Array(0), R: null } },
    }
  }

  return {
    push(L, R) {
      append(L, R)
      return produce(false)
    },
    flush() {
      if (done) return { L: new Float32Array(0), R: null }
      done = true
      return produce(true)
    },
  }
}

// ============ 组合：重采样 + WSOLA ============

function createPitchStream(sampleRate, semitones, channels) {
  const ratio = Math.pow(2, (semitones | 0) / 12)
  if ((semitones | 0) === 0) {
    return {
      push(L, R) { return { L, R } },
      flush() { return { L: new Float32Array(0), R: null } },
    }
  }
  const rs = createStreamingResampler(ratio)
  const ws = createStreamingStretcher(sampleRate, ratio)
  const mono = channels < 2
  return {
    push(L, R) {
      const a = rs.push(L, mono ? null : R)
      return ws.push(a.L, mono ? null : a.R)
    },
    flush() {
      const a = rs.flush()
      const b = ws.push(a.L, mono ? null : a.R)
      // ws 的输出缓冲会复用：先保存 b，再 flush 出 c
      const bL = b.L.length ? b.L.slice() : b.L
      const bR = b.R ? (b.R.length ? b.R.slice() : b.R) : null
      const c = ws.flush()
      if (!c.L.length) return { L: bL, R: bR }
      if (!bL.length) return c
      const L = new Float32Array(bL.length + c.L.length)
      L.set(bL); L.set(c.L, bL.length)
      let R = null
      if (bR) {
        R = new Float32Array(L.length)
        R.set(bR); R.set(c.R, bR.length)
      }
      return { L, R }
    },
  }
}

// ============ MP3 流式编码 ============

/** lamejs 支持的标准采样率；非标准采样率会让编码器内部行为不可预期 */
const MP3_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000]

function clampKbps(sampleRate, kbps) {
  let max = 320
  if (sampleRate <= 12000) max = 64
  else if (sampleRate < 32000) max = 160
  return Math.max(8, Math.min(max, kbps | 0 || 160))
}

/**
 * 单实例 MP3 编码器：逐块 encodeBuffer，攒到 ~128KB 再回调，避免主线程消息风暴。
 * onChunk(Uint8Array) 由 worker 转成 ArrayBuffer 发回主线程。
 */
function createMp3Stream(sampleRate, kbps, channels) {
  const lamejs = require('./lamejs.js')
  const enc = new lamejs.Mp3Encoder(channels, sampleRate, clampKbps(sampleRate, kbps))
  const mono = channels < 2
  const FLUSH_BYTES = 128 * 1024
  let pending = []
  let pendingBytes = 0
  let outBytes = 0

  function emit(onChunk, force) {
    if (!pendingBytes) return
    if (!force && pendingBytes < FLUSH_BYTES) return
    const out = new Uint8Array(pendingBytes)
    let p = 0
    for (let i = 0; i < pending.length; i++) { out.set(pending[i], p); p += pending[i].length }
    pending = []
    pendingBytes = 0
    outBytes += out.length
    onChunk(out)
  }

  return {
    push(l16, r16, onChunk) {
      const buf = mono ? enc.encodeBuffer(l16) : enc.encodeBuffer(l16, r16)
      if (buf && buf.length) {
        pending.push(new Uint8Array(buf))
        pendingBytes += buf.length
      }
      emit(onChunk, false)
    },
    flush(onChunk) {
      const end = enc.flush()
      if (end && end.length) {
        pending.push(new Uint8Array(end))
        pendingBytes += end.length
      }
      emit(onChunk, true)
    },
    get bytes() { return outBytes },
  }
}

module.exports = {
  f32ToI16,
  i16ToF32,
  resample,
  makeWsola,
  createStreamingResampler,
  createStreamingStretcher,
  createPitchStream,
  createMp3Stream,
  clampKbps,
  MP3_RATES,
}
