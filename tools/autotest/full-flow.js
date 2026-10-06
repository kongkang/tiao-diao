// 完整链路回归：注入歌 → pitch 渲染 → 点下一步 → unlock 渲染
// + 用 getOwnPropertyNames 深挖神秘 console.error
const cmpPath = require.resolve('licia/cmpVersion')
const origCmp = require(cmpPath)
require.cache[cmpPath].exports = (a, b) => (typeof a !== 'string' ? 0 : origCmp(a, b))

const automator = require('miniprogram-automator')
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const mp = await automator.connect({ wsEndpoint: 'ws://localhost:9420', timeout: 30000 })
  console.log('=== 已连接 ===')

  let dumped = 0
  mp.on('console', m => {
    if (m.type !== 'error') return
    console.log(`\n[console.error 原始结构] keys(m)=${Object.getOwnPropertyNames(m)}`)
    ;(m.args || []).forEach((a, i) => {
      const names = a && typeof a === 'object' ? Object.getOwnPropertyNames(a) : []
      console.log(`  arg${i} keys=[${names}]`)
      names.forEach(k => {
        let v
        try { v = typeof a[k] === 'object' ? JSON.stringify(a[k]).slice(0, 250) : String(a[k]).slice(0, 250) } catch (e) { v = '<err>' }
        console.log(`    ${k}: ${v}`)
      })
    })
    if (m.stackTrace) m.stackTrace.callFrames.slice(0, 4).forEach(f =>
      console.log(`    at ${f.functionName || '(anon)'} ${f.url.split('/').pop()}:${f.lineNumber + 1}`))
  })

  // 注入歌 → pitch
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
  console.log('\npitch 页:', page.path)

  // 点下一步 → 应到 unlock
  const btn = await page.$('.btn-primary')
  console.log('下一步按钮:', btn ? '找到' : '未找到')
  await btn.tap()
  await sleep(2500)
  page = await mp.currentPage()
  console.log('点击后落在:', page.path, page.path === 'pages/unlock/index' ? '✅' : '❌')

  if (page.path === 'pages/unlock/index') {
    await mp.screenshot({ path: __dirname + '/shots/unlock-with-song.png' })
    console.log('截图: shots/unlock-with-song.png')
  }

  await sleep(1500)
  await mp.disconnect()
  console.log('=== DONE ===')
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1) })
