// 推荐视频素材截图：当前版 UI（3 分钟试听 / 三档解锁 / 处理中 / 完成页）
const cmpPath = require.resolve('licia/cmpVersion')
const origCmp = require(cmpPath)
require.cache[cmpPath].exports = (a, b) => (typeof a !== 'string' ? 0 : origCmp(a, b))
const automator = require('miniprogram-automator')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const injectSong = require('./inject-song.js')

async function main() {
  const mp = await automator.connect({ wsEndpoint: 'ws://localhost:9420', timeout: 30000 })
  console.log('=== connected ===')
  // 0) 清理 → 首页
  await mp.evaluate(() => {
    try { require('services/session.js').clear() } catch (e) {}
    try { require('services/identity.js').clearProfile() } catch (e) {}
  })
  await mp.reLaunch('/pages/index/index')
  await sleep(1500)
  await mp.screenshot({ path: __dirname + '/shots/index-with-history.png' })
  console.log('✓ index')
  // 1) 变调页（带歌 +2，未播放）
  await injectSong(mp, 180)
  await mp.reLaunch('/pages/pitch/index')
  await sleep(1800)
  await mp.screenshot({ path: __dirname + '/shots/pitch-with-song.png' })
  console.log('✓ pitch-with-song')
  // 2) 试听播放中（3 分钟免费试听）
  await mp.evaluate(() => {
    const pages = getCurrentPages()
    pages[pages.length - 1].onPlayToggle()
  })
  await sleep(2600)
  await mp.screenshot({ path: __dirname + '/shots/pitch-preview.png' })
  console.log('✓ pitch-preview')
  // 3) 解锁页（三档）
  await mp.reLaunch('/pages/unlock/index')
  await sleep(1800)
  await mp.screenshot({ path: __dirname + '/shots/unlock-tiers.png' })
  console.log('✓ unlock-tiers')
  // 4) 处理中（点开始转调 → 截 2 秒后）
  await mp.evaluate(() => {
    const pages = getCurrentPages()
    pages[pages.length - 1].onConfirm()
  })
  await sleep(2200)
  const path = await mp.evaluate(() => {
    const pages = getCurrentPages()
    return pages[pages.length - 1].route
  })
  if (String(path).includes('process')) {
    await mp.screenshot({ path: __dirname + '/shots/process-running.png' })
    console.log('✓ process-running')
  } else {
    console.log('! not on process page:', path)
  }
  // 5) 等完成 → 结果页
  for (let i = 0; i < 60; i++) {
    await sleep(3000)
    const r = await mp.evaluate(() => {
      const pages = getCurrentPages()
      return pages[pages.length - 1].route
    })
    if (String(r).includes('result')) break
  }
  await sleep(1200)
  await mp.screenshot({ path: __dirname + '/shots/result.png' })
  console.log('✓ result')
  // 6) 清理回首页
  await mp.evaluate(() => { require('services/session.js').clear() })
  await mp.reLaunch('/pages/index/index')
  console.log('=== DONE ===')
  await mp.disconnect()
}
main().catch(e => { console.error('FAIL', e.message); process.exit(1) })
