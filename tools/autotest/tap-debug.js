// 定位「点下一步弹回首页」：高频轮询页面栈，看 unlock 是否被 push 后又被 reLaunch
const cmpPath = require.resolve('licia/cmpVersion')
const origCmp = require(cmpPath)
require.cache[cmpPath].exports = (a, b) => (typeof a !== 'string' ? 0 : origCmp(a, b))

const automator = require('miniprogram-automator')
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const mp = await automator.connect({ wsEndpoint: 'ws://localhost:9420', timeout: 30000 })
  console.log('=== 已连接 ===')

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
  await mp.reLaunch('/pages/pitch/index')
  await sleep(1800)
  let page = await mp.currentPage()
  console.log('起点:', page.path)

  const btn = await page.$('.btn-primary')
  console.log('按钮文本:', await btn.text(), '| wxml 类:', (await btn.attribute('class')))

  // 验证 onNext 本身：直接在页面实例上调用，绕过点击
  console.log('\n--- A. 直接调 page.callMethod("onNext") ---')
  try {
    await page.callMethod('onNext')
    await sleep(1500)
    const stack = await mp.pageStack()
    console.log('调用后页面栈:', JSON.stringify(stack.map(p => p.path)))
  } catch (e) {
    console.log('callMethod 异常:', e.message)
  }

  // 如果已弹回首页，重新注入再走 B 计划（真 tap）
  let cur = (await mp.currentPage()).path
  if (cur !== 'pages/unlock/index') {
    console.log('\n--- B. 重新注入，用真 tap，200ms 高频轮询 ---')
    await mp.evaluate(() => {
      const session = require('services/session.js')
      const sr = 44100, n = sr * 60
      const pcmL = new Float32Array(n)
      for (let i = 0; i < n; i++) pcmL[i] = 0.3 * Math.sin(2 * Math.PI * 440 * i / sr)
      session.setSong({
        path: '/tmp/fake.wav', name: '测试歌.wav',
        durationSec: 60, sampleRate: sr, channels: 2, length: n,
        pcmL, pcmR: new Float32Array(pcmL),
      })
      session.setSemitones(2)
    })
    await mp.reLaunch('/pages/pitch/index')
    await sleep(1500)
    page = await mp.currentPage()
    const b2 = await page.$('.btn-primary')
    await b2.tap()
    for (let i = 0; i < 15; i++) {
      await sleep(200)
      const stack = await mp.pageStack()
      console.log(`t+${(i + 1) * 200}ms 栈:`, JSON.stringify(stack.map(p => p.path)))
    }
  }

  await mp.disconnect()
  console.log('=== DONE ===')
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1) })
