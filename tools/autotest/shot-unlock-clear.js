// 补拍 unlock 新样式截图 + 清理模拟器里的测试数据（恢复首页待命状态）
const cmpPath = require.resolve('licia/cmpVersion')
const origCmp = require(cmpPath)
require.cache[cmpPath].exports = (a, b) => (typeof a !== 'string' ? 0 : origCmp(a, b))

const automator = require('miniprogram-automator')
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const mp = await automator.connect({ wsEndpoint: 'ws://localhost:9420', timeout: 30000 })

  // 注入一首歌仅为拍 unlock 页
  await mp.evaluate(() => {
    const session = require('services/session.js')
    const sr = 44100, n = sr * 180
    const pcmL = new Float32Array(n)
    for (let i = 0; i < n; i++) pcmL[i] = 0.5 * Math.sin(2 * Math.PI * 440 * i / sr)
    session.setSong({
      path: '/tmp/fake.wav', name: '测试歌（3分钟）.wav',
      durationSec: 180, sampleRate: sr, channels: 2, length: n,
      pcmL, pcmR: new Float32Array(pcmL),
    })
    session.setSemitones(2)
  })
  await mp.reLaunch('/pages/unlock/index')
  await sleep(2000)
  await mp.screenshot({ path: __dirname + '/shots/unlock-with-song.png' })
  console.log('unlock 截图完成')

  // 清理：清掉测试歌，回首页
  await mp.evaluate(() => { require('services/session.js').clear() })
  await mp.reLaunch('/pages/index/index')
  await sleep(1200)
  await mp.screenshot({ path: __dirname + '/shots/index.png' })
  console.log('已清理测试数据，模拟器恢复首页待命')

  await mp.disconnect()
  console.log('=== DONE ===')
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1) })
