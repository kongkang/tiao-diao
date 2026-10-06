// 一键截图：index / pitch / unlock / result 四页新样式 + 跑通全流程 + 清理测试数据
const cmpPath = require.resolve('licia/cmpVersion')
const origCmp = require(cmpPath)
require.cache[cmpPath].exports = (a, b) => (typeof a !== 'string' ? 0 : origCmp(a, b))

const automator = require('miniprogram-automator')
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const mp = await automator.connect({ wsEndpoint: 'ws://localhost:9420', timeout: 30000 })
  console.log('=== 已连接 ===')

  const inject = () => mp.evaluate(() => {
    const session = require('services/session.js')
    const sr = 44100, n = sr * 180
    // 铺砖法：440Hz × 1s = 整 440 周期相位连续，避免逐点 sin 撞 IDE 10s 消息超时
    const sec = new Float32Array(sr)
    for (let i = 0; i < sr; i++) sec[i] = 0.5 * Math.sin(2 * Math.PI * 440 * i / sr)
    const pcmL = new Float32Array(n)
    for (let k = 0; k < 180; k++) pcmL.set(sec, k * sr)
    session.setSong({
      path: '/tmp/fake.wav', name: '测试歌（3分钟）.wav',
      durationSec: 180, sampleRate: sr, channels: 2, length: n,
      pcmL, pcmR: new Float32Array(pcmL),
    })
    session.setSemitones(2)
  })

  // 1) 首页（无歌状态）
  await mp.evaluate(() => { require('services/session.js').clear() })
  await mp.reLaunch('/pages/index/index')
  await sleep(1500)
  await mp.screenshot({ path: __dirname + '/shots/index.png' })
  console.log('✓ index')

  // 2) 变调页
  await inject()
  await mp.reLaunch('/pages/pitch/index')
  await sleep(1800)
  await mp.screenshot({ path: __dirname + '/shots/pitch-with-song.png' })
  console.log('✓ pitch')

  // 3) 解锁页 → 开始转调 → 等结果页
  await mp.reLaunch('/pages/unlock/index')
  await sleep(1800)
  await mp.screenshot({ path: __dirname + '/shots/unlock-with-song.png' })
  console.log('✓ unlock')
  let page = await mp.currentPage()
  try { await page.callMethod('onStartFree') } catch (e) { await page.callMethod('onConfirm') }
  console.log('处理中…')

  const t0 = Date.now()
  let reached = false
  while (Date.now() - t0 < 180000) {
    await sleep(5000)
    page = await mp.currentPage()
    if (page.path === 'pages/result/index') { reached = true; break }
    if (page.path !== 'pages/process/index' && page.path !== 'pages/unlock/index') break
  }
  if (reached) {
    console.log(`✓ result（${((Date.now() - t0) / 1000).toFixed(1)}s）`)
    await mp.screenshot({ path: __dirname + '/shots/result.png' })
  } else {
    console.log('✗ 未到结果页，当前:', page.path)
  }

  // 4) 清理测试数据回首页
  await mp.evaluate(() => { require('services/session.js').clear() })
  await mp.reLaunch('/pages/index/index')
  console.log('已清理测试数据')
  await mp.disconnect()
  console.log('=== DONE ===')
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1) })
