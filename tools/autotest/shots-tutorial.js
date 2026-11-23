// 教程视频专用截图：v0.4.0 真实界面逐状态截取
// 产出 shots/tut-*.png：index / pitch-loaded / pitch-preview / unlock-free / unlock-balance /
//                        process×2 / result / index-hist
// 全程静音（injectSong 默认 setPreviewMuted），结束后清脏数据回首页
const cmpPath = require.resolve('licia/cmpVersion')
const origCmp = require(cmpPath)
require.cache[cmpPath].exports = (a, b) => (typeof a !== 'string' ? 0 : origCmp(a, b))

const automator = require('miniprogram-automator')
const injectSong = require('./inject-song.js')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const shot = (mp, name) => mp.screenshot({ path: __dirname + '/shots/' + name })

async function main() {
  const mp = await automator.connect({ wsEndpoint: 'ws://localhost:9420', timeout: 30000 })
  console.log('=== 已连接 ===')

  // 0) 清脏数据（session/历史/权益缓存/广告授权）
  await mp.evaluate(() => {
    const session = require('services/session.js')
    session.clear()
    ;['td_history', 'td_local_entitlement', 'td_admin_local', 'td_ad_sim', 'td_profile']
      .forEach(k => wx.removeStorageSync(k))
    wx.getStorageInfoSync().keys.forEach(k => {
      if (k.indexOf('ad_fail_grant_') === 0) wx.removeStorageSync(k)
    })
    return true
  })
  console.log('已清脏数据')

  // 1) 首页（此时无历史）
  await mp.reLaunch('/pages/index/index')
  await sleep(1800)
  await shot(mp, 'tut-index.png')
  console.log('✓ tut-index')

  // 2) 注入 3 分钟歌（真实感歌名），进变调页
  await injectSong(mp, 180, '戏曲伴奏（3分钟）.wav')
  await mp.reLaunch('/pages/pitch/index')
  await sleep(1800)
  await shot(mp, 'tut-pitch-loaded.png')
  console.log('✓ tut-pitch-loaded')

  // 3) 试听播放中（点播放等 2.5s 让进度条走到可读位置）
  let page = await mp.currentPage()
  await page.callMethod('onPlayToggle')
  await sleep(2500)
  await shot(mp, 'tut-pitch-preview.png')
  console.log('✓ tut-pitch-preview')
  await page.callMethod('onPlayToggle') // 停播

  // 4) 解锁页三档（默认限时免费；云权益拉取要等一下）
  await mp.reLaunch('/pages/unlock/index')
  await sleep(3500)
  page = await mp.currentPage()
  await shot(mp, 'tut-unlock-free.png')
  console.log('✓ tut-unlock-free')
  // 额度档选中态（备用素材）
  await page.callMethod('onPick', { currentTarget: { dataset: { v: 'balance' } } })
  await sleep(500)
  await shot(mp, 'tut-unlock-balance.png')
  console.log('✓ tut-unlock-balance')
  await page.callMethod('onPick', { currentTarget: { dataset: { v: 'free' } } })
  await sleep(300)

  // 5) 确认（免费直通）→ 处理页抓运行中两帧 → 等结果页
  await page.callMethod('onConfirm')
  const t0 = Date.now()
  let shot1 = false, shot2 = false, reached = false
  while (Date.now() - t0 < 180000) {
    await sleep(700)
    page = await mp.currentPage()
    if (page.path === 'pages/process/index') {
      let d = {}
      try { d = await page.data() } catch (e) { /* 切页中 */ }
      const el = ((Date.now() - t0) / 1000).toFixed(1)
      process.stdout.write(`\r  处理中 indeterminate=${!!d.indeterminate} percent=${d.percent || 0} t=${el}s   `)
      if (!shot1 && el > 4 && (d.indeterminate || (d.percent || 0) >= 20)) {
        await shot(mp, 'tut-process-1.png'); shot1 = true; console.log('\n✓ tut-process-1')
      }
      if (!shot2 && el > 9) { await shot(mp, 'tut-process-2.png'); shot2 = true; console.log('\n✓ tut-process-2') }
    } else if (page.path === 'pages/result/index') {
      reached = true
      break
    }
  }
  console.log('')
  if (!reached) { console.log('❌ 未到结果页'); await mp.disconnect(); process.exit(1) }
  console.log(`✅ 结果页达成 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  await sleep(1500)
  await shot(mp, 'tut-result.png')
  console.log('✓ tut-result')

  // 6) 首页（带历史卡）
  await mp.reLaunch('/pages/index/index')
  await sleep(1800)
  await shot(mp, 'tut-index-hist.png')
  console.log('✓ tut-index-hist')

  // 7) 收尾清理
  await mp.evaluate(() => {
    const session = require('services/session.js')
    session.clear()
    ;['td_history', 'td_local_entitlement', 'td_admin_local', 'td_ad_sim', 'td_profile']
      .forEach(k => wx.removeStorageSync(k))
    wx.getStorageInfoSync().keys.forEach(k => {
      if (k.indexOf('ad_fail_grant_') === 0) wx.removeStorageSync(k)
    })
    return true
  })
  await mp.reLaunch('/pages/index/index')
  await sleep(1000)
  await mp.disconnect()
  console.log('=== DONE ===')
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1) })
