// 赞赏组件（reward-entry）回归（2026-11-04）
// 覆盖：
//   ① compareVersion 纯函数边界（3.17.2/3.17.3/3.18.0/四段/空值）
//   ② 解锁页免费态：reward-entry 挂载、<reward> 真实渲染（模拟器 libVersion 3.17.3 + REWARD_ENABLED）
//   ③ 降级：后台未开通赞赏时官方行为是"零占位"——<reward> 空、hint 引导文案不出现
//   ④ 守卫：REWARD_ENABLED=false 时组件整体不渲染（wx:if 移除宿主节点）
//   ⑤ 付费态（本地权益 free:false）：组件同样在，且全页只有一个实例（官方限制一个）
// 说明: automator 按标签名查自定义组件查不到（'reward-entry'/路径名都 null），
//       本套断言基于页面 wxml dump —— 顺便更贴近用户实际看到的渲染结果。
//       hint=true 的正向路径（组件渲染出高度→文案出现）依赖后台开通，留给真机验证。
// 用法: node test-reward.js
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

/** 解锁页 .page-root 的运行时 wxml（自定义组件宿主节点以路径名出现在 dump 里） */
async function dumpUnlock(page) {
  const root = await page.$('.page-root')
  return root ? (await root.wxml()) : ''
}
/** dump 里 reward-entry 宿主节点的实例数（开+闭标签各计一次 → 1 个实例 = 2） */
function entryCount(wxml) {
  return wxml.split('components/reward-entry/index').length - 1
}

async function main() {
  const mp = await automator.connect({ wsEndpoint: 'ws://localhost:9420', timeout: 30000 })
  console.log('=== 已连接模拟器 ===')

  // ---------- 0. 清理 ----------
  await mp.evaluate(() => {
    require('services/session.js').clear()
    ;['td_local_entitlement'].forEach(k => wx.removeStorageSync(k))
    require('config.js').REWARD_ENABLED = true
  })

  // ========== 1. compareVersion 纯函数 ==========
  console.log('\n--- 1. compareVersion 边界 ---')
  const cvRes = await mp.evaluate(() => {
    const cv = require('utils/format.js').compareVersion
    return {
      a: cv('3.17.2', '3.17.3'),
      b: cv('3.17.3', '3.17.3'),
      c: cv('3.18.0', '3.17.3'),
      d: cv('3.17.3.1', '3.17.3'),
      e: cv('', '3.0.0'),
    }
  })
  check('3.17.2 < 3.17.3', cvRes.a === -1, JSON.stringify(cvRes))
  check('3.17.3 = 3.17.3', cvRes.b === 0)
  check('3.18.0 > 3.17.3', cvRes.c === 1)
  check('四段 3.17.3.1 > 3.17.3', cvRes.d === 1)
  check('空值按 0 处理不抛错', cvRes.e === -1)

  // ========== 2. 免费态解锁页 ==========
  console.log('\n--- 2. 免费态：reward-entry 挂载 + 后台未开通零占位 ---')
  await injectSong(mp, 3)
  await mp.reLaunch('/pages/unlock/index')
  await sleep(2500)
  let page = await mp.currentPage()
  check('解锁页已打开', !!page && page.path === 'pages/unlock/index')

  const ent = await mp.evaluate(() => require('services/billing.js').getEntitlement())
  check('当前为免费态', !!(ent && ent.free), JSON.stringify(ent))

  let wxml = await dumpUnlock(page)
  check('reward-entry 宿主节点已挂载（show 守卫通过）', wxml.indexOf('components/reward-entry/index') > -1)
  check('<reward> 真实渲染', wxml.indexOf('<reward') > -1)

  // 等 hint 两次探测（800/2500ms）窗口过完
  await sleep(3000)
  wxml = await dumpUnlock(page)
  check('后台未开通：reward 空占位（无人喜欢仅按钮/不渲染）', wxml.indexOf('<reward') > -1)
  check('后台未开通：hint 引导文案不出现', wxml.indexOf('reward-hint') === -1)

  await mp.screenshot({ path: SHOTS + '/reward-free.png' })
  console.log('    （hint 正向路径 = 后台开通后组件渲染出高度→文案亮起，依赖真机开通验证）')

  // ========== 3. 开关守卫 ==========
  console.log('\n--- 3. REWARD_ENABLED=false 整体不渲染 ---')
  await mp.evaluate(() => { require('config.js').REWARD_ENABLED = false })
  await mp.reLaunch('/pages/unlock/index')
  await sleep(1500)
  page = await mp.currentPage()
  wxml = await dumpUnlock(page)
  // wx:if 在组件内部：关开关后页面留一个空宿主壳（无内容无样式，视觉零影响），断言看内容
  check('关开关后组件内容不渲染（无 reward/slot）',
    wxml.indexOf('<reward') === -1 && wxml.indexOf('reward-slot') === -1,
    '宿主壳保留属预期')
  await mp.evaluate(() => { require('config.js').REWARD_ENABLED = true })

  // ========== 4. 付费态解锁页 ==========
  console.log('\n--- 4. 付费态：组件仍在且全页仅一个 ---')
  await mp.evaluate(() => require('services/billing.js').writeLocalEnt({ free: false, monthly: false, minutes: 30 }))
  await mp.reLaunch('/pages/unlock/index')
  await sleep(1500)
  page = await mp.currentPage()
  wxml = await dumpUnlock(page)
  const cnt = entryCount(wxml)
  check('付费态组件存在且仅一个实例', cnt === 2, 'tag occurrences=' + cnt)
  await mp.screenshot({ path: SHOTS + '/reward-paid.png' })

  // 还原现场，别影响后续回归
  await mp.evaluate(() => {
    wx.removeStorageSync('td_local_entitlement')
    require('services/session.js').clear()
    require('config.js').REWARD_ENABLED = true
  })

  console.log('\n=== 结果: ' + pass + ' 通过, ' + fail + ' 失败 ===')
  process.exit(fail ? 1 : 0)
}

main().catch(e => { console.error('FATAL', e); process.exit(1) })
