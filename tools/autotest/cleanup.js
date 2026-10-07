// 收尾清理：清空 session 脏数据 + 回首页（符合交接文档"别留脏数据/假歌"约定）
const cmpPath = require.resolve('licia/cmpVersion')
const origCmp = require(cmpPath)
require.cache[cmpPath].exports = (a, b) => (typeof a !== 'string' ? 0 : origCmp(a, b))

const automator = require('miniprogram-automator')
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const mp = await automator.connect({ wsEndpoint: 'ws://localhost:9420', timeout: 30000 })
  console.log('=== 已连接 ===')
  const r = await mp.evaluate(() => {
    const session = require('services/session.js')
    session.clear()
    ;['td_history', 'td_local_entitlement', 'td_admin_local', 'td_ad_sim', 'td_profile']
      .forEach(k => wx.removeStorageSync(k))
    wx.getStorageInfoSync().keys.forEach(k => {
      if (k.indexOf('ad_fail_grant_') === 0) wx.removeStorageSync(k)
    })
    if (wx.__modalBackup) { wx.showModal = wx.__modalBackup; wx.__modalBackup = null }
    return { hasSong: !!session.getSong() }
  })
  console.log('session.clear():', JSON.stringify(r))
  await mp.reLaunch('/pages/index/index')
  await sleep(1500)
  const page = await mp.currentPage()
  console.log('已回首页:', page.path)
  await mp.disconnect()
  console.log('=== DONE ===')
}
main().catch(e => { console.error('FATAL:', e.message); process.exit(1) })
