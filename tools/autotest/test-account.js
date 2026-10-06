// 账号/管理员/历史 本地版回归（2026-10-06）
// 覆盖：①identity 本地用户识别 ②首页隐藏手势解锁管理员 ③管理页渲染
//       ④权益模拟四态 + consume 扣减 ⑤转调历史（端到端：process 成功 → 首页/管理页可见）
// 用法: node test-account.js
// 前提: 已执行 `cli auto --project <项目根> --auto-port 9420`

// --- monkey-patch licia/cmpVersion：容忍 SDKVersion 缺失 ---
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

async function main() {
  const mp = await automator.connect({ wsEndpoint: 'ws://localhost:9420', timeout: 30000 })
  console.log('=== 已连接模拟器 ===')

  const errors = []
  mp.on('console', m => {
    if (m.type === 'error') {
      let text = ''
      try { text = JSON.stringify(m).slice(0, 400) } catch (e) { text = String(m) }
      errors.push('[console.error] ' + text)
    }
  })
  if (mp.on) mp.on('exception', e => errors.push('[exception] ' + String(e && e.message || e).slice(0, 300)))

  // ---------- 0. 清理脏数据 ----------
  await mp.evaluate(() => {
    require('services/session.js').clear()
    wx.removeStorageSync('td_history')
    wx.removeStorageSync('td_local_entitlement')
    wx.removeStorageSync('td_admin_local')
  })

  // ---------- 1. 身份识别 ----------
  console.log('\n--- 1. 本地身份识别 ---')
  const user = await mp.evaluate(() => require('services/identity.js').getUser())
  check('userId 已生成', user && typeof user.userId === 'string' && user.userId.indexOf('u_') === 0, user && user.userId)
  check('启动次数已累计', user && user.launchCount >= 1, 'launchCount=' + (user && user.launchCount))
  check('openid 为空（未接云，预期）', user && !user.openid)
  const adminBefore = await mp.evaluate(() => require('services/identity.js').isAdmin())
  check('默认非管理员', adminBefore === false)

  // ---------- 2. 首页默认态 + 隐藏手势 ----------
  console.log('\n--- 2. 首页隐藏手势解锁管理员 ---')
  await mp.reLaunch('/pages/index/index')
  await sleep(1500)
  let page = await mp.currentPage()
  check('首页无历史卡', (await page.$('.his-item')) === null)
  check('首页无管理入口', (await page.$('.admin-entry')) === null)

  for (let i = 0; i < 5; i++) { await page.callMethod('onHeroTap'); await sleep(120) }
  await sleep(300)
  const data = await page.data()
  check('连点 5 次后 isAdmin=true', data.isAdmin === true)
  check('管理入口出现', (await page.$('.admin-entry')) !== null)
  const adminAfter = await mp.evaluate(() => require('services/identity.js').isAdmin())
  check('identity.isAdmin()=true', adminAfter === true)

  // ---------- 3. 管理页 ----------
  console.log('\n--- 3. 管理页渲染 ---')
  const entry = await page.$('.admin-entry')
  await entry.tap()
  await sleep(1200)
  page = await mp.currentPage()
  check('进入管理页', page.path === 'pages/admin/index', page.path)
  const aData = await page.data()
  check('身份卡显示本地用户 ID', !!aData.user && aData.user.userId.indexOf('u_') === 0)
  check('管理员状态=是（本地解锁）', aData.isAdmin === true && aData.adminByWhitelist === false)
  check('权益默认=内测免费', aData.entText.indexOf('内测免费') > -1, aData.entText)
  check('历史为空', aData.historyList.length === 0)
  check('开关状态已渲染', aData.flags && aData.flags.PAY_ENABLED === false && aData.flags.AD_ENABLED === false)
  await mp.screenshot({ path: SHOTS + '/admin.png' })

  // ---------- 4. 权益模拟四态 ----------
  console.log('\n--- 4. 权益模拟 ---')
  await page.callMethod('onSimMonthly')
  await sleep(300)
  let ent = await mp.evaluate(() => require('services/billing.js').getEntitlement())
  check('模拟包月生效', ent.monthly === true && ent.free === false, 'daysLeft=' + ent.monthlyDaysLeft)
  check('包月天数≈30', ent.monthlyDaysLeft >= 29 && ent.monthlyDaysLeft <= 30)
  let c = await mp.evaluate(() => require('services/billing.js').consume(5))
  check('包月扣减放行不扣分钟', c.ok === true)

  await page.callMethod('onSimMinutes')
  await sleep(300)
  c = await mp.evaluate(() => require('services/billing.js').consume(4))
  check('余额扣减 30-4=26', c.ok === true && c.minutes === 26, JSON.stringify(c))
  ent = await mp.evaluate(() => require('services/billing.js').getEntitlement())
  check('权益读到余额 26', ent.minutes === 26 && !ent.free && !ent.monthly)

  await page.callMethod('onSimNormal')
  await sleep(300)
  c = await mp.evaluate(() => require('services/billing.js').consume(1))
  check('普通用户余额不足返回 insufficient', c.ok === false && c.reason === 'insufficient')

  await page.callMethod('onSimFree')
  await sleep(300)
  ent = await mp.evaluate(() => require('services/billing.js').getEntitlement())
  check('恢复内测免费', ent.free === true)

  // ---------- 5. 转调历史（端到端） ----------
  console.log('\n--- 5. 转调历史端到端（3 秒注入歌） ---')
  await mp.reLaunch('/pages/index/index')
  await sleep(800)
  await injectSong(mp, 3)
  await mp.reLaunch('/pages/process/index')
  // 等处理完成跳到结果页（3 秒歌很快，留 40s 余量）
  let landed = ''
  const t0 = Date.now()
  while (Date.now() - t0 < 40000) {
    await sleep(1500)
    landed = (await mp.currentPage()).path
    if (landed === 'pages/result/index') break
  }
  check('处理完成落到结果页', landed === 'pages/result/index', landed)
  const his = await mp.evaluate(() => require('services/history.js').list())
  check('历史写入 1 条', his.length === 1, JSON.stringify(his[0] || {}))
  check('历史字段正确（歌名/半音/时长/文件名）',
    his.length === 1 && his[0].name.indexOf('测试歌') > -1 && his[0].semitones === 2 &&
    his[0].durationSec === 3 && his[0].fileName.indexOf('升2半音') > -1 && his[0].ts > 0)

  await mp.reLaunch('/pages/index/index')
  await sleep(1500)
  page = await mp.currentPage()
  const items = await page.$$('.his-item')
  check('首页历史卡显示 1 条', items.length === 1)
  const idxData = await page.data()
  check('首页历史文案（升 2 个半音）',
    idxData.historyList.length === 1 && idxData.historyList[0].pitchLabel === '升 2 个半音')
  await mp.screenshot({ path: SHOTS + '/index-with-history.png' })

  // 管理页也可见
  await page.callMethod('onGoAdmin')
  await sleep(1200)
  page = await mp.currentPage()
  const aData2 = await page.data()
  check('管理页历史 1 条', page.path === 'pages/admin/index' && aData2.historyList.length === 1)

  // ---------- 6. 清理 & 退出管理员 ----------
  console.log('\n--- 6. 清理 ---')
  await mp.evaluate(() => {
    require('services/history.js').clear()
    require('services/identity.js').lockAdminLocal()
    require('services/billing.js').resetLocalEnt()
    require('services/session.js').clear()
  })
  await mp.reLaunch('/pages/index/index')
  await sleep(1500)
  page = await mp.currentPage()
  check('清历史后首页无历史卡', (await page.$('.his-item')) === null)
  check('退出管理员后入口隐藏', (await page.$('.admin-entry')) === null)

  // ---------- 汇总 ----------
  console.log('\n=== 汇总：' + pass + ' PASS / ' + fail + ' FAIL ===')
  if (errors.length) {
    console.log('控制台错误 ' + errors.length + ' 条（前 5 条）:')
    errors.slice(0, 5).forEach(e => console.log('  ' + e))
  } else {
    console.log('无 console.error / 未捕获异常 ✅')
  }

  await mp.disconnect()
  console.log('=== DONE ===')
  process.exit(fail > 0 ? 1 : 0)
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1) })
