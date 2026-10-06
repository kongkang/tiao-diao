// 终极全链路：注入歌 → unlock 点开始转调 → process 跑 3 分钟全曲 → result 页 → 验证结果文件存在
const cmpPath = require.resolve('licia/cmpVersion')
const origCmp = require(cmpPath)
require.cache[cmpPath].exports = (a, b) => (typeof a !== 'string' ? 0 : origCmp(a, b))

const automator = require('miniprogram-automator')
const injectSong = require('./inject-song.js')
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const mp = await automator.connect({ wsEndpoint: 'ws://localhost:9420', timeout: 30000 })
  console.log('=== 已连接 ===')

  mp.on('console', m => {
    if (m.type === 'error') {
      // 已知噪音：args[0] 无任何可枚举属性的 IDE 内部错误，跳过
      const args = m.args || []
      const isNoise = args.length === 1 && args[0] && typeof args[0] === 'object' &&
        Object.getOwnPropertyNames(args[0]).length === 0 && !m.stackTrace
      if (!isNoise) console.log('[真实 console.error]', JSON.stringify(m).slice(0, 400))
    }
  })

  // 1) 注入 3 分钟虚拟歌曲（v3：真实 WAV + Worker token）
  await injectSong(mp, 180)
  console.log('已注入 3 分钟测试歌')

  // 2) 直达 unlock，点开始转调
  await mp.reLaunch('/pages/unlock/index')
  await sleep(2000)
  let page = await mp.currentPage()
  if (page.path !== 'pages/unlock/index') { console.log('❌ 没停在 unlock:', page.path); await mp.disconnect(); return }
  const btn = await page.$('.btn-primary')
  if (!btn) { console.log('❌ 没找到开始转调按钮'); await mp.disconnect(); return }
  // automator 的 tap 在重编译后不可靠，直接调页面方法（内测模式的处理函数是 onStartFree）
  try { await page.callMethod('onStartFree') } catch (e) { await page.callMethod('onConfirm') }
  console.log('已触发「开始转调」，等待处理…')

  // 3) 轮询等待 result 页（最长 180 秒）
  const t0 = Date.now()
  let reached = false
  while (Date.now() - t0 < 180000) {
    await sleep(3000)
    page = await mp.currentPage()
    const path = page.path
    if (path === 'pages/process/index') {
      try {
        const d = await page.data()
        process.stdout.write(`\r  处理中 ${d.percent || 0}%   `)
      } catch (e) { /* 页面切换中 */ }
    } else if (path === 'pages/result/index') {
      reached = true
      break
    } else if (path !== 'pages/unlock/index') {
      console.log('\n❌ 意外页面:', path); break
    }
  }
  console.log('')
  if (!reached) { console.log('❌ 超时未到 result 页，当前:', page.path); await mp.disconnect(); return }
  console.log(`✅ 到达结果页，全程耗时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`)
  await mp.screenshot({ path: __dirname + '/shots/result.png' })
  console.log('截图: shots/result.png')

  // 4) 验证结果文件真实存在且大小合理
  const check = await mp.evaluate(() => new Promise(resolve => {
    const session = require('services/session.js')
    const r = session.getLastResult()
    if (!r || !r.path) return resolve({ ok: false, msg: 'lastResult 为空' })
    wx.getFileSystemManager().access({
      path: r.path,
      success: () => wx.getFileSystemManager().stat({
        path: r.path,
        success: s => resolve({ ok: true, fileName: r.fileName, size: s.size || (s.stats && s.stats.size) }),
        fail: () => resolve({ ok: true, fileName: r.fileName, size: -1 }),
      }),
      fail: e => resolve({ ok: false, msg: '文件不存在: ' + (e.errMsg || ''), path: r.path }),
    })
  }))
  console.log('结果文件:', JSON.stringify(check))
  if (check.ok && check.size > 0) {
    // 期望随输出格式走：WAV(16bit 立体声)≈31.7MB；MP3≈kbps×180/8 KB
    const isWav = (check.fileName || '').endsWith('.wav')
    const expectMB = isWav ? 44100 * 180 * 2 * 2 / 1048576 : 128 * 180 / 8 / 1024
    console.log(`文件大小 ${(check.size / 1048576).toFixed(1)}MB（${isWav ? 'WAV' : 'MP3'} 理论约 ${expectMB.toFixed(1)}MB）`,
      isWav
        ? (Math.abs(check.size / 1048576 - expectMB) < expectMB * 0.2 ? '✅' : '⚠️ 偏差偏大')
        : (check.size / 1048576 > expectMB * 0.5 && check.size / 1048576 < expectMB * 3 ? '✅（MP3 码率浮动范围内）' : '⚠️ 偏差偏大'))
  }

  await mp.disconnect()
  console.log('=== DONE ===')
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1) })
