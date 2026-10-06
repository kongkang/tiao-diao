// 「下一步停播」回归（2026-10-06 用户实测：播放中点下一步，声音一直放到解锁页）
// 场景 1：播放中点下一步 → 必须立即停声、落在解锁页
// 场景 2：「正在调」中点下一步 → 终止 Worker 请求，全曲处理不受残留请求阻塞
const cmpPath = require.resolve('licia/cmpVersion')
const origCmp = require(cmpPath)
require.cache[cmpPath].exports = (a, b) => (typeof a !== 'string' ? 0 : origCmp(a, b))

const automator = require('miniprogram-automator')
const injectSong = require('./inject-song.js')
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function waitState(page, want, timeoutMs) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const d = await page.data()
    if (d.playState === want) return d
    await sleep(400)
  }
  return await page.data()
}

async function main() {
  const mp = await automator.connect({ wsEndpoint: 'ws://localhost:9420', timeout: 30000 })
  console.log('=== 已连接 ===')
  let pass = 0, fail = 0
  const check = (name, ok, extra) => {
    console.log((ok ? '✅' : '❌') + ' ' + name + (extra !== undefined ? '｜' + extra : ''))
    ok ? pass++ : fail++
  }

  await injectSong(mp, 60)
  await mp.reLaunch('/pages/pitch/index')
  await sleep(2000)
  let page = await mp.currentPage()
  if (page.path !== 'pages/pitch/index') { console.log('❌ 没停在 pitch'); await mp.disconnect(); return }

  // 场景 1：播起来以后点下一步
  await page.callMethod('onPlayToggle')
  let d = await waitState(page, 'playing', 20000)
  check('前置：已进入播放', d.playState === 'playing', d.playState)
  await page.callMethod('onNext')
  await sleep(1200)
  page = await mp.currentPage()
  check('已落在解锁页', page.path === 'pages/unlock/index', page.path)
  const audioState = await mp.evaluate(() => {
    const st = require('services/audio.js').getPreviewState()
    return st === null ? 'stopped' : JSON.stringify(st)
  })
  check('跳转后播放已停止', audioState === 'stopped', audioState)

  // 场景 2：返回变调页，「正在调」中立刻点下一步，然后直接开始转调
  await mp.navigateBack()
  await sleep(1200)
  page = await mp.currentPage()
  check('已返回变调页', page.path === 'pages/pitch/index', page.path)
  d = await page.data()
  check('返回后播放器是 idle（可重新点）', d.playState === 'idle', d.playState)

  await page.callMethod('onPlayToggle')
  await sleep(200) // 正在调（processing）中就点下一步
  await page.callMethod('onNext')
  await sleep(800)
  page = await mp.currentPage()
  check('正在调时点下一步也落在解锁页', page.path === 'pages/unlock/index', page.path)

  // abort 后 Worker 常驻数据已销毁。真机上 process 页 ensureSong 会按 song.path 自动重解码；
  // 模拟器里"readFile 回来的 buffer transfer 给实验 Worker 会挂死"（已知坑 4），
  // 所以测试用再注入等价替代重解码——验证的是"abort 后引擎健康、全曲畅通"。
  await injectSong(mp, 60)

  // 直接开始全曲转调：若残留请求没清干净，engine.process 会报"正在处理中"弹"这次没成功"
  try { await page.callMethod('onStartFree') } catch (e) { await page.callMethod('onConfirm') }
  const t0 = Date.now()
  let reached = false
  while (Date.now() - t0 < 60000) {
    await sleep(2000)
    page = await mp.currentPage()
    if (page.path === 'pages/result/index') { reached = true; break }
    if (page.path === 'pages/unlock/index') {
      // 还在 unlock 且弹了错误框就算失败（modal 内容不易读，用页面停滞判定）
    }
  }
  check('全曲处理畅通（到结果页）', reached, 'path=' + page.path)

  // 收尾
  await mp.evaluate(() => { try { require('services/audio.js').stopPreview(); require('services/session.js').clear() } catch (e) {} })
  await mp.reLaunch('/pages/index/index')
  await mp.disconnect()
  console.log('=== DONE：' + pass + ' 过 / ' + fail + ' 挂 ===')
  if (fail > 0) process.exit(1)
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1) })
