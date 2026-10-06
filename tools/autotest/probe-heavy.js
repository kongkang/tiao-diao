// 分级加压探针：定位 automator evaluate 在不同数据量下的超时阈值
const cmpPath = require.resolve('licia/cmpVersion')
const origCmp = require(cmpPath)
require.cache[cmpPath].exports = (a, b) => (typeof a !== 'string' ? 0 : origCmp(a, b))

const automator = require('miniprogram-automator')

async function main() {
  const mp = await automator.connect({ wsEndpoint: 'ws://localhost:9420', timeout: 60000 })
  console.log('=== 已连接 ===')

  async function step(label, fn, ...args) {
    const t0 = Date.now()
    try {
      const r = await mp.evaluate(fn, ...args)
      console.log(`${label}: OK ${((Date.now() - t0) / 1000).toFixed(1)}s ->`, JSON.stringify(r).slice(0, 120))
      return true
    } catch (e) {
      console.log(`${label}: FAIL ${((Date.now() - t0) / 1000).toFixed(1)}s ->`, e.message)
      return false
    }
  }

  await step('1.空 evaluate', () => 1 + 1)
  await step('2.require session', () => { const s = require('services/session.js'); return { hasSong: !!s.getSong() } })
  await step('3.小数组(1万)', (n) => { const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = Math.sin(i); return a.length }, 10000)
  await step('4.中数组(100万)', (n) => { const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = Math.sin(i); return a.length }, 1000000)
  const ok5 = await step('5.大数组(794万)', (n) => { const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = 0.5 * Math.sin(2 * Math.PI * 440 * i / 44100); return a.length }, 44100 * 180)
  if (ok5) {
    await step('6.setSong(3分钟)', () => {
      const session = require('services/session.js')
      const sr = 44100, n = sr * 180
      const pcmL = new Float32Array(n)
      for (let i = 0; i < n; i++) pcmL[i] = 0.5 * Math.sin(2 * Math.PI * 440 * i / sr)
      session.setSong({ path: '/tmp/fake.wav', name: 'probe.wav', durationSec: 180, sampleRate: sr, channels: 2, length: n, pcmL, pcmR: new Float32Array(pcmL) })
      session.setSemitones(2)
      return { ok: true }
    })
  }

  await mp.disconnect()
  console.log('=== DONE ===')
}
main().catch(e => { console.error('FATAL:', e.message); process.exit(1) })
