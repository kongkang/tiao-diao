// 支付+广告+登录 全流程回归（2026-10-06）
// 覆盖：
//   ① 登录：我的页头像登录（USER_DATA_PATH 模拟 chooseAvatar）→ 改称呼 → 首页左上角入口 → 退出登录
//   ② 支付全流程（内测模拟）：普通用户 → 解锁页选付费 → 余额不足弹窗 → 买分钟 → 模拟支付到账 30 分
//      → 返回解锁页余额已刷新 → 付费转调 → 结果页 → 扣 1 分钟 = 29
//   ③ 广告全流程（演示广告）：开演示 → 解锁页看视频 → 演示广告页 → 中途关（可重看）→
//      再看 → 等倒计时 → 领奖励 → 转调成功且不扣分钟（ad 模式跳过 consume）
//   ④ 管理页广告演示开关生效
// 用法: node test-flows.js
// 前提: 已执行 `cli auto --project <项目根> --auto-port 9420`

const cmpPath = require.resolve('licia/cmpVersion')
const origCmp = require(cmpPath)
require.cache[cmpPath].exports = (a, b) => (typeof a !== 'string' ? 0 : origCmp(a, b))

const fs = require('fs')
const automator = require('miniprogram-automator')
const injectSong = require('./inject-song.js')

const SHOTS = __dirname + '/shots'
fs.mkdirSync(SHOTS, { recursive: true })
const sleep = ms => new Promise(r => setTimeout(r, ms))

let pass = 0, fail = 0
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name + (extra ? ' — ' + extra : '')) }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

/** 把 wx.showModal 换成自动确认/自动取消（测原生弹窗分支） */
async function mockModal(mp, behavior) {
  await mp.evaluate(b => {
    wx.__modalBackup = wx.__modalBackup || wx.showModal
    wx.showModal = opts => {
      const res = b === 'confirm'
        ? { confirm: true, cancel: false, errMsg: 'showModal:ok' }
        : { confirm: false, cancel: true, errMsg: 'showModal:ok' }
      if (opts && opts.success) opts.success(res)
      if (opts && opts.complete) opts.complete(res)
    }
  }, behavior)
}
async function restoreModal(mp) {
  await mp.evaluate(() => {
    if (wx.__modalBackup) { wx.showModal = wx.__modalBackup; wx.__modalBackup = null }
  })
}

async function waitPage(mp, path, timeoutMs) {
  const t0 = Date.now()
  while (Date.now() - t0 < (timeoutMs || 40000)) {
    await sleep(1200)
    const p = await mp.currentPage()
    if (p && p.path === path) return p
  }
  return null
}

async function main() {
  const mp = await automator.connect({ wsEndpoint: 'ws://localhost:9420', timeout: 30000 })
  console.log('=== 已连接模拟器 ===')

  // ---------- 0. 清理 ----------
  // 注意：identity 有模块级缓存，清资料/管理员必须走 API（直接删 storage 缓存不失效）
  await mp.evaluate(() => {
    require('services/session.js').clear()
    require('services/identity.js').clearProfile()
    require('services/identity.js').lockAdminLocal()
    require('services/ad.js').setSimEnabled(false)
    ;['td_history', 'td_local_entitlement'].forEach(k => wx.removeStorageSync(k))
    wx.getStorageInfoSync().keys.forEach(k => {
      if (k.indexOf('ad_fail_grant_') === 0) wx.removeStorageSync(k)
    })
    if (wx.__modalBackup) { wx.showModal = wx.__modalBackup; wx.__modalBackup = null }
  })

  // ========== 1. 登录流程 ==========
  console.log('\n--- 1. 登录：我的页头像登录 + 改称呼 + 首页入口 + 退出 ---')
  await mp.reLaunch('/pages/me/index')
  await sleep(1500)
  let page = await mp.currentPage()
  check('我的页打开', page.path === 'pages/me/index', page.path)
  let meData = await page.data()
  check('未登录态：me=null', meData.me === null)
  check('未登录态：显示登录提示', (await page.$('.login-tip')) !== null)
  check('未登录态：权益=内测免费', meData.ent.free === true)

  // 模拟 chooseAvatar：写入一张真实 PNG 到 USER_DATA_PATH（persistAvatar 对本机路径直接采用）
  const avatarPath = await mp.evaluate(() => {
    const p = wx.env.USER_DATA_PATH + '/test-avatar.png'
    const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
    wx.getFileSystemManager().writeFileSync(p, b64, 'base64')
    return p
  })
  await page.callMethod('onChooseAvatar', { detail: { avatarUrl: avatarPath } })
  await sleep(800)
  meData = await page.data()
  check('头像登录成功：me 已写入', !!meData.me && !!meData.me.avatarUrl, JSON.stringify(meData.me))
  check('默认称呼=歌友', meData.me && meData.me.nickname === '歌友')
  check('登录后展开改称呼输入', meData.editingName === true)
  check('登录后显示称呼', (await page.$('.me-name')) !== null)

  // 改称呼
  await page.callMethod('onNickInput', { detail: { value: '老票友' } })
  await page.callMethod('onSaveName')
  await sleep(500)
  meData = await page.data()
  check('称呼改为 老票友', meData.me && meData.me.nickname === '老票友')
  let prof = await mp.evaluate(() => require('services/identity.js').getProfile())
  check('identity.getProfile 持久化', prof && prof.nickname === '老票友' && !!prof.avatarUrl)

  // 首页左上角入口（已登录态）
  await mp.reLaunch('/pages/index/index')
  await sleep(1500)
  page = await mp.currentPage()
  const idxData = await page.data()
  check('首页登录入口存在', (await page.$('.me-entry')) !== null)
  check('首页显示头像（已登录）', !!(idxData.me && idxData.me.avatarUrl))
  let label = await (await page.$('.me-label')).text()
  check('已登录文案=我的', String(label).trim() === '我的', label)

  await (await page.$('.me-entry')).tap()
  await sleep(1000)
  page = await mp.currentPage()
  check('点头像进入我的页', page.path === 'pages/me/index', page.path)

  // 退出登录（mock 确认）
  await mockModal(mp, 'confirm')
  await page.callMethod('onLogout')
  await sleep(600)
  await restoreModal(mp)
  meData = await page.data()
  check('退出登录：me=null', meData.me === null)
  prof = await mp.evaluate(() => require('services/identity.js').getProfile())
  check('退出后 getProfile=null（权益历史不受影响）', prof === null)

  await mp.reLaunch('/pages/index/index')
  await sleep(1200)
  page = await mp.currentPage()
  label = await (await page.$('.me-label')).text()
  check('未登录文案=登录', String(label).trim() === '登录', label)

  // ========== 2. 支付全流程（内测模拟） ==========
  console.log('\n--- 2. 支付全流程：普通用户 → 余额不足 → 模拟买 30 分 → 转调扣 1 分 ---')
  await injectSong(mp, 3)
  await mp.evaluate(() => require('services/billing.js').writeLocalEnt({ free: false, monthly: false, minutes: 0 }))
  await mp.reLaunch('/pages/unlock/index')
  await sleep(1500)
  page = await mp.currentPage()
  let uData = await page.data()
  check('解锁页：付费模式（非免费）', uData.entitlement && uData.entitlement.free === false)
  check('解锁页：双选项可见（看视频/付费）', (await page.$$('.opt')).length === 2)
  check('默认选看视频', uData.selected === 'ad')

  await page.callMethod('onPick', { currentTarget: { dataset: { v: 'pay' } } })
  await mockModal(mp, 'confirm') // ① 余额不足弹窗 → 确认去买分钟
  await page.callMethod('onConfirm')
  await sleep(1200)
  await restoreModal(mp)
  page = await mp.currentPage()
  check('余额不足 → 进买分钟页', page.path === 'pages/buy/index', page.path)
  let bData = await page.data()
  check('买分钟页：付费态可购买', bData.canBuy === true)

  await page.callMethod('onPick', { currentTarget: { dataset: { id: 'pkg_30' } } })
  await mockModal(mp, 'confirm') // ② 模拟支付确认框 → 假装付了
  await page.callMethod('onBuy')
  await sleep(1200)
  await restoreModal(mp)
  let ent = await mp.evaluate(() => require('services/billing.js').getEntitlement())
  check('模拟支付到账 30 分钟', ent.free === false && ent.minutes === 30, JSON.stringify(ent))
  bData = await page.data()
  check('买分钟页余额刷新 30', bData.entitlement && bData.entitlement.minutes === 30)

  // 回解锁页：onShow 必须刷新余额
  await mp.navigateBack()
  await sleep(1200)
  page = await mp.currentPage()
  uData = await page.data()
  check('返回解锁页余额已刷新 30', uData.entitlement && uData.entitlement.minutes === 30)

  // 付费转调 → 结果页 → 扣 1 分钟
  await page.callMethod('onPick', { currentTarget: { dataset: { v: 'pay' } } })
  await page.callMethod('onConfirm')
  page = await waitPage(mp, 'pages/result/index')
  check('付费转调到结果页', page !== null, page && page.path)
  ent = await mp.evaluate(() => require('services/billing.js').getEntitlement())
  check('转调成功扣 1 分钟 → 剩 29', ent.minutes === 29, 'minutes=' + ent.minutes)
  const mode1 = await mp.evaluate(() => require('services/session.js').getUnlockMode())
  check('解锁方式记录为 pay', mode1 === 'pay')

  // 我的页权益卡显示余额
  await mp.reLaunch('/pages/me/index')
  await sleep(1200)
  page = await mp.currentPage()
  meData = await page.data()
  check('我的页权益卡：29 分钟', meData.ent.minutes === 29 && !meData.ent.free)
  check('我的页历史 1 条', meData.historyList.length === 1)
  await mp.screenshot({ path: SHOTS + '/me-logged-ent.png' })

  // ========== 3. 广告全流程（演示广告） ==========
  console.log('\n--- 3. 广告全流程：演示广告 看完领奖励 / 中途关可重看 ---')
  await mp.evaluate(() => {
    require('services/ad.js').setSimEnabled(true)
    require('services/billing.js').writeLocalEnt({ free: false, monthly: false, minutes: 5 })
    require('services/session.js').clear()
  })
  await injectSong(mp, 3)
  await mp.reLaunch('/pages/unlock/index')
  await sleep(1500)
  page = await mp.currentPage()

  // 3a. 中途关 → 不放行，弹"再看一次"
  await mockModal(mp, 'cancel')
  await page.callMethod('onConfirm') // 默认 selected='ad'
  await sleep(1200)
  let adPage = await mp.currentPage()
  check('演示广告页打开', adPage.path === 'pages/adsim/index', adPage.path)
  let adData = await adPage.data()
  check('演示广告倒计时正确（5 秒）', adData.sec === 5 && adData.left === 5 && adData.ended === false)
  await adPage.callMethod('onSkip')
  await sleep(1200)
  await restoreModal(mp)
  page = await mp.currentPage()
  check('中途关：留在解锁页（不放行）', page.path === 'pages/unlock/index', page.path)
  ent = await mp.evaluate(() => require('services/billing.js').getEntitlement())
  check('中途关：未转调未扣分钟', ent.minutes === 5)

  // 3b. 看完 → 领奖励 → 转调成功，ad 模式不扣分钟
  await page.callMethod('onConfirm')
  await sleep(1200)
  adPage = await mp.currentPage()
  check('第二个演示广告打开', adPage.path === 'pages/adsim/index', adPage.path)
  adData = await adPage.data()
  check('广告序号 1/1', adData.idx === 1 && adData.total === 1)
  // 等倒计时结束
  const t0 = Date.now()
  while (Date.now() - t0 < 12000) {
    await sleep(800)
    adData = await (await mp.currentPage()).data()
    if (adPage.path === 'pages/adsim/index' && adData.ended) break
  }
  check('倒计时走完 ended=true', adData.ended === true && adData.left === 0)
  await mp.screenshot({ path: SHOTS + '/adsim-reward.png' })
  await adPage.callMethod('onReward')
  page = await waitPage(mp, 'pages/result/index')
  check('领奖励后转调到结果页', page !== null, page && page.path)
  ent = await mp.evaluate(() => require('services/billing.js').getEntitlement())
  check('看广告转调不扣分钟（仍 5）', ent.minutes === 5, 'minutes=' + ent.minutes)
  const mode2 = await mp.evaluate(() => require('services/session.js').getUnlockMode())
  check('解锁方式记录为 ad', mode2 === 'ad')

  // ========== 4. 管理页广告演示开关 ==========
  console.log('\n--- 4. 管理页：广告演示开关 ---')
  await mp.evaluate(() => require('services/identity.js').unlockAdminLocal())
  await mp.reLaunch('/pages/admin/index')
  await sleep(1200)
  page = await mp.currentPage()
  let aData = await page.data()
  check('管理页显示演示已开启', aData.adSim === true)
  await page.callMethod('onToggleAdSim')
  await sleep(400)
  aData = await page.data()
  check('点按钮关闭演示', aData.adSim === false)
  const simOff = await mp.evaluate(() => require('services/ad.js').isSimEnabled())
  check('ad.isSimEnabled=false', simOff === false)
  await page.callMethod('onToggleAdSim') // 还原为关（清理态）
  await sleep(300)
  await mp.evaluate(() => require('services/ad.js').setSimEnabled(false))

  // ========== 5. 截图 + 清理 ==========
  console.log('\n--- 5. 截图与清理 ---')
  // 首页（已登录头像 + 历史）
  await mp.reLaunch('/pages/index/index')
  await sleep(1500)
  await mp.screenshot({ path: SHOTS + '/index-me-entry.png' })
  page = await mp.currentPage()
  check('首页历史卡仍在（支付+广告两轮 = 2 条）', (await page.$$('.his-item')).length === 2)

  await mp.evaluate(() => {
    require('services/session.js').clear()
    require('services/history.js').clear()
    require('services/identity.js').clearProfile()
    require('services/identity.js').lockAdminLocal()
    require('services/billing.js').resetLocalEnt()
    require('services/ad.js').setSimEnabled(false)
    wx.removeStorageSync('td_profile')
    if (wx.__modalBackup) { wx.showModal = wx.__modalBackup; wx.__modalBackup = null }
  })
  await mp.reLaunch('/pages/index/index')
  await sleep(1200)

  console.log('\n=== 汇总：' + pass + ' PASS / ' + fail + ' FAIL ===')
  await mp.disconnect()
  console.log('=== DONE ===')
  process.exit(fail > 0 ? 1 : 0)
}

main().catch(async e => {
  console.error('FATAL:', e.message)
  process.exit(1)
})
