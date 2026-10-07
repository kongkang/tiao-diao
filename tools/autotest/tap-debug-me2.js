const cmpPath = require.resolve('licia/cmpVersion')
const origCmp = require(cmpPath)
require.cache[cmpPath].exports = (a, b) => (typeof a !== 'string' ? 0 : origCmp(a, b))
const automator = require('miniprogram-automator')
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const mp = await automator.connect({ wsEndpoint: 'ws://localhost:9420', timeout: 30000 })
  mp.on('console', m => console.log('[console]', m.type, String(m.text).slice(0, 200)))
  // 复刻失败前置：我的页 → 登录 → 改称呼 → 回首页
  await mp.reLaunch('/pages/me/index')
  await sleep(1500)
  let page = await mp.currentPage()
  const avatarPath = await mp.evaluate(() => {
    const p = wx.env.USER_DATA_PATH + '/test-avatar.png'
    const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
    wx.getFileSystemManager().writeFileSync(p, b64, 'base64')
    return p
  })
  await page.callMethod('onChooseAvatar', { detail: { avatarUrl: avatarPath } })
  await sleep(800)
  await page.callMethod('onNickInput', { detail: { value: '老票友' } })
  await page.callMethod('onSaveName')
  await sleep(500)
  await mp.reLaunch('/pages/index/index')
  await sleep(1500)
  page = await mp.currentPage()
  const label = await (await page.$('.me-label')).text()
  console.log('label:', label)
  await (await page.$('.me-entry')).tap()
  await sleep(1000)
  const cur = await mp.currentPage()
  console.log('currentPage after tap:', cur.path)
  const stack = await mp.pageStack()
  console.log('stack:', JSON.stringify(stack.map(p => p.path)))
  await mp.disconnect()
}
main().catch(e => { console.error('FATAL:', e.message); process.exit(1) })
