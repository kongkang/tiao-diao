// 诊断：v2 注入（无 token）下 ensureSong 到底报什么
const cmpPath = require.resolve('licia/cmpVersion')
const origCmp = require(cmpPath)
require.cache[cmpPath].exports = (a, b) => (typeof a !== 'string' ? 0 : origCmp(a, b))

const automator = require('miniprogram-automator')

async function main() {
  const mp = await automator.connect({ wsEndpoint: 'ws://localhost:9420', timeout: 30000 })
  const r = await mp.evaluate(() => {
    const session = require('services/session.js')
    const audioSvc = require('services/audio.js')
    session.setSong({
      path: '/tmp/fake.wav', name: 'x.wav',
      durationSec: 60, sampleRate: 44100, channels: 2, length: 44100 * 60,
      pcmL: new Float32Array(8), pcmR: new Float32Array(8),
    })
    return audioSvc.ensureSong(session.getSong())
      .then(() => ({ ok: true }))
      .catch(e => ({ ok: false, msg: String(e.message || e) }))
  })
  console.log('ensureSong 结果:', JSON.stringify(r))
  await mp.evaluate(() => require('services/session.js').clear())
  await mp.disconnect()
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1) })
