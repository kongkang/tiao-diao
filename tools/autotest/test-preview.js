// 合并播放器验证（2026-10-06 二改）：
// ① 快捷条/独立滑杆卡已删，只有一张播放器卡 ② 进度条=整首歌（max=60，总时长 1:00）
// ③ 拖进度条选位置，未点过播放不自动唱 ④ 点播放从指针处听 15 秒
// ⑤ 播放中改调立即停旧声、倒计时后自动重唱 ⑥ 暂停/续播 ⑦ 播完指针前进到听完处
// ⑧ 拖到歌尾附近自动钳位 + 播到结尾指针回开头
// 轻量：60 秒歌（数组小，不易压垮通道）
const cmpPath = require.resolve('licia/cmpVersion')
const origCmp = require(cmpPath)
require.cache[cmpPath].exports = (a, b) => (typeof a !== 'string' ? 0 : origCmp(a, b))

const automator = require('miniprogram-automator')
const injectSong = require('./inject-song.js')
const sleep = ms => new Promise(r => setTimeout(r, ms))

/** 轮询等页面进入目标状态 */
async function waitState(page, want, timeoutMs) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const d = await page.data()
    if (d.playState === want) return d
    await sleep(500)
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

  // 注入 60 秒歌（v3：真实 WAV + Worker token）
  await injectSong(mp, 60)
  await mp.reLaunch('/pages/pitch/index')
  await sleep(2000)
  let page = await mp.currentPage()
  if (page.path !== 'pages/pitch/index') { console.log('❌ 没停在 pitch'); await mp.disconnect(); return }

  // 1) 合并后的结构：无快捷条，播放器里一条整歌进度条
  const quick = await page.$('.quick-btn')
  const playBtn = await page.$('.play-btn')
  const slider = await page.$('.player-slider')
  let d = await page.data()
  check('快捷条已删除', quick === null)
  check('播放器按钮存在', playBtn !== null)
  check('播放器内进度条存在', slider !== null)
  check('进度条=整首歌（max 60 / 总时长 1:00）',
    d.durationFloor === 60 && d.playTotalText === '1:00',
    'max=' + d.durationFloor + ' total=' + d.playTotalText)

  // 2) 拖进度条到 30s（未点过播放，不应自动唱）
  await page.callMethod('onSeek', { detail: { value: 30 } })
  await sleep(1500)
  d = await page.data()
  check('拖条后不自动唱（idle）', d.playState === 'idle',
    'pos=' + d.previewStart + ' time=' + d.playTimeText + ' state=' + d.playState)
  check('指针在 0:30', d.previewStart === 30 && d.playTimeText === '0:30',
    d.previewStart + ' / ' + d.playTimeText)

  // 3) 点播放 → processing → playing，从 30s 处唱
  await page.callMethod('onPlayToggle')
  d = await page.data()
  check('点播放后进入 processing', d.playState === 'processing', d.playState)
  d = await waitState(page, 'playing', 20000)
  check('变调完成进入 playing', d.playState === 'playing', 'status=' + d.statusText)
  await sleep(2000)
  d = await page.data()
  check('进度从 0:30 往后走', d.playState === 'playing' && d.previewStart > 30 && d.previewStart < 36,
    'pos=' + d.previewStart.toFixed(1) + ' time=' + d.playTimeText)
  await mp.screenshot({ path: __dirname + '/shots/pitch-preview.png' })

  // 4) 播放中改调 → 立即停旧声回 processing，倒计时后自动重唱新调
  await page.callMethod('onUp')
  d = await page.data()
  check('改调立即停旧声（processing）', d.playState === 'processing' && d.semitones === 3,
    'semitones=' + d.semitones + ' state=' + d.playState)
  d = await waitState(page, 'playing', 20000)
  check('自动重唱新调（+3）', d.playState === 'playing' && d.semitones === 3,
    'state=' + d.playState + ' status=' + d.statusText)

  // 5) 暂停 / 续播
  await sleep(1000)
  await page.callMethod('onPlayToggle')
  d = await page.data()
  check('播放中点按钮→暂停', d.playState === 'paused', d.playState)
  const pausedAt = d.playTimeText
  await sleep(1200)
  d = await page.data()
  check('暂停时进度不走', d.playTimeText === pausedAt, pausedAt + ' → ' + d.playTimeText)
  await page.callMethod('onPlayToggle')
  d = await page.data()
  check('暂停后点按钮→续播', d.playState === 'playing', d.playState)

  // 6) 自然播完 → 回 idle，指针前进到听完的位置（>40，约在 45 上下）
  d = await waitState(page, 'idle', 30000)
  check('自然播完回 idle，指针停在听完处', d.playState === 'idle' && d.previewStart > 40,
    'pos=' + d.previewStart + ' time=' + d.playTimeText)

  // 7) 拖到歌尾 50s → 钳位到 45s 起唱；播到结尾指针回 0:00
  await page.callMethod('onSeek', { detail: { value: 50 } })
  d = await waitState(page, 'playing', 20000)
  check('拖到歌尾自动重唱（钳位 45s 起）', d.playState === 'playing',
    'state=' + d.playState + ' pos=' + d.previewStart)
  d = await waitState(page, 'idle', 30000)
  check('播到结尾指针回开头', d.playState === 'idle' && d.previewStart === 0,
    'pos=' + d.previewStart + ' time=' + d.playTimeText)

  // 收尾：清数据回首页
  await mp.evaluate(() => { require('services/session.js').clear() })
  await mp.reLaunch('/pages/index/index')
  await mp.disconnect()
  console.log('=== DONE：' + pass + ' 过 / ' + fail + ' 挂 ===')
  if (fail > 0) process.exit(1)
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1) })
