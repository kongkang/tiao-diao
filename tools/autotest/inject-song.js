// v3 注入助手：合成真实 WAV → engine.analyze 进 Worker → session 存带 token 的歌
// 背景（2026-10-06）：v3 内存架构后 PCM 常驻 Worker，session 只存元数据+token。
// 旧的 v2 注入（pcmL/pcmR 直塞 session、path 指向不存在的 /tmp/fake.wav）会让
// ensureSong 走"按 path 重新解码"兜底然后报"读取文件失败"，试听/全曲链路全挂。
//
// 【模拟器坑 2026-10-06 实测】analyze 的 buffer 必须直接在 JS 里构造；
// 先 writeFile 再 readFile 拿回来的 ArrayBuffer transfer 给实验 Worker 会挂死
// （Promise 永不 settle，无报错无超时）。真机无此问题。所以注入不走文件 IO，
// song.path 仅作占位（token 有效期内 ensureSong 不会去读它）。
//
// 用法：const injectSong = require('./inject-song.js'); await injectSong(mp, 60)
// 注意 IDE 自动化服务器 10s/消息硬上限：analyze 在后台跑，状态写 globalThis.__inj，
// 本函数分多次小 evaluate 轮询，单次 evaluate 秒回。

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function injectSong(mp, seconds) {
  const start = await mp.evaluate((sec) => {
    const engine = require('services/engine.js')
    const session = require('services/session.js')
    // 测试全程静音：只走流程不出声（避免打扰），真机不受此开关影响
    try { require('services/audio.js').setPreviewMuted(true) } catch (e) {}
    const sr = 44100, n = sr * sec
    // 铺砖法：440Hz × 1s = 整 440 周期相位连续（逐点 sin 会撞 10s 上限）
    const one = new Int16Array(sr)
    for (let i = 0; i < sr; i++) one[i] = Math.round(0.3 * 32767 * Math.sin(2 * Math.PI * 440 * i / sr))
    const block = new Int16Array(sr * 2)
    for (let i = 0; i < sr; i++) { block[i * 2] = one[i]; block[i * 2 + 1] = one[i] }
    const pcm = new Int16Array(n * 2)
    for (let k = 0; k < sec; k++) pcm.set(block, k * sr * 2)
    // WAV 头（PCM16 立体声）
    const buf = new ArrayBuffer(44 + pcm.byteLength)
    const v = new DataView(buf)
    const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)) }
    ws(0, 'RIFF'); v.setUint32(4, 36 + pcm.byteLength, true); ws(8, 'WAVE')
    ws(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true)
    v.setUint16(22, 2, true); v.setUint32(24, sr, true)
    v.setUint32(28, sr * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true)
    ws(36, 'data'); v.setUint32(40, pcm.byteLength, true)
    new Uint8Array(buf, 44).set(new Uint8Array(pcm.buffer))

    globalThis.__inj = { status: 'decoding', mb: (buf.byteLength / 1048576).toFixed(1) }
    engine.analyze(buf)
      .then(meta => {
        session.setSong({
          path: '/tmp/injected-' + sec + 's.wav', name: '测试歌（' + sec + '秒）.wav',
          size: buf.byteLength, format: 'wav',
          token: meta.token, frames: meta.frames,
          sampleRate: meta.sampleRate, channels: meta.channels,
          durationSec: meta.frames / meta.sampleRate,
        })
        session.setSemitones(2)
        globalThis.__inj = { status: 'ready', token: meta.token, frames: meta.frames }
      })
      .catch(e => { globalThis.__inj = { status: 'error', msg: String(e.message || e) } })
    return { started: true }
  }, seconds)
  console.log('注入启动:', JSON.stringify(start))

  // 轮询等 analyze 完成（每次 evaluate 都很轻，不撞 10s 上限）
  const t0 = Date.now()
  while (Date.now() - t0 < 120000) {
    await sleep(2000)
    const st = await mp.evaluate(() => globalThis.__inj || { status: 'missing' })
    if (st.status === 'ready') {
      console.log('注入完成:', JSON.stringify(st))
      return st
    }
    if (st.status === 'error') throw new Error('注入失败: ' + st.msg)
    process.stdout.write('\r  注入中… ' + st.status + '   ')
  }
  throw new Error('注入超时')
}

module.exports = injectSong
