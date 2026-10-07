// 新页面各状态截图：我的页（未登录/免费/包月/分钟）、首页、演示广告倒计时中、管理页
const cmpPath = require.resolve('licia/cmpVersion')
const origCmp = require(cmpPath)
require.cache[cmpPath].exports = (a, b) => (typeof a !== 'string' ? 0 : origCmp(a, b))
const automator = require('miniprogram-automator')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const SHOTS = __dirname + '/shots'

async function main() {
  const mp = await automator.connect({ wsEndpoint: 'ws://localhost:9420', timeout: 30000 })

  // 清理
  await mp.evaluate(() => {
    require('services/session.js').clear()
    require('services/identity.js').clearProfile()
    require('services/identity.js').lockAdminLocal()
    require('services/ad.js').setSimEnabled(false)
    require('services/history.js').clear()
    require('services/billing.js').resetLocalEnt()
  })

  // 1. 我的页：未登录（免费态 + 空历史）
  await mp.reLaunch('/pages/me/index')
  await sleep(1500)
  await mp.screenshot({ path: SHOTS + '/me-1-loggedout.png' })

  // 2. 我的页：已登录 + 包月 + 有历史
  const avatarPath = await mp.evaluate(() => {
    const p = wx.env.USER_DATA_PATH + '/test-avatar.png'
    const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
    wx.getFileSystemManager().writeFileSync(p, b64, 'base64')
    return p
  })
  let page = await mp.currentPage()
  await page.callMethod('onChooseAvatar', { detail: { avatarUrl: avatarPath } })
  await sleep(600)
  await page.callMethod('onNickInput', { detail: { value: '老票友' } })
  await page.callMethod('onSaveName')
  await sleep(400)
  await mp.evaluate(() => {
    require('services/history.js').add({ name: '苏三起解（伴奏）.mp3', semitones: 2, durationSec: 213, fileName: 'a.mp3' })
    require('services/history.js').add({ name: '贵妃醉酒 伴奏.wav', semitones: -1, durationSec: 168, fileName: 'b.wav' })
    require('services/billing.js').writeLocalEnt({ free: false, monthly: true, minutes: 0, monthlyUntil: Date.now() + 23 * 86400000 })
  })
  await mp.reLaunch('/pages/me/index')
  await sleep(1500)
  await mp.screenshot({ path: SHOTS + '/me-2-monthly.png' })

  // 3. 我的页：分钟余额态
  await mp.evaluate(() => require('services/billing.js').writeLocalEnt({ free: false, monthly: false, minutes: 23 }))
  await mp.reLaunch('/pages/me/index')
  await sleep(1500)
  await mp.screenshot({ path: SHOTS + '/me-3-minutes.png' })

  // 4. 首页（已登录头像 + 历史卡）
  await mp.reLaunch('/pages/index/index')
  await sleep(1500)
  await mp.screenshot({ path: SHOTS + '/index-loggedin.png' })

  // 5. 演示广告倒计时中（开演示 → 直接开广告页，截到 3 秒左右）
  await mp.reLaunch('/pages/adsim/index?sec=30')
  await sleep(2600)
  await mp.screenshot({ path: SHOTS + '/adsim-counting.png' })

  // 6. 管理页（管理员 + 演示开关卡）
  await mp.evaluate(() => {
    require('services/identity.js').unlockAdminLocal()
    require('services/ad.js').setSimEnabled(true)
  })
  await mp.reLaunch('/pages/admin/index')
  await sleep(1500)
  await mp.screenshot({ path: SHOTS + '/admin-adsim.png' })

  // 收尾清理
  await mp.evaluate(() => {
    require('services/session.js').clear()
    require('services/identity.js').clearProfile()
    require('services/identity.js').lockAdminLocal()
    require('services/ad.js').setSimEnabled(false)
    require('services/history.js').clear()
    require('services/billing.js').resetLocalEnt()
  })
  await mp.reLaunch('/pages/index/index')
  await sleep(1000)
  await mp.disconnect()
  console.log('DONE: shots saved')
}
main().catch(e => { console.error('FATAL:', e.message); process.exit(1) })
