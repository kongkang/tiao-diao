const cmpPath = require.resolve('licia/cmpVersion')
const origCmp = require(cmpPath)
require.cache[cmpPath].exports = (a, b) => (typeof a !== 'string' ? 0 : origCmp(a, b))
const automator = require('miniprogram-automator')
const injectSong = require('./inject-song.js')
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const mp = await automator.connect({ wsEndpoint: 'ws://localhost:9420', timeout: 30000 })
  const errs = []
  mp.on('console', m => { if (m.type === 'error') errs.push(JSON.stringify(m).slice(0, 400)) })
  await mp.evaluate(() => {
    require('services/session.js').clear()
    require('services/billing.js').writeLocalEnt({ free: false, monthly: false, minutes: 0 })
  })
  await injectSong(mp, 3)
  await mp.reLaunch('/pages/unlock/index')
  await sleep(1500)
  const page = await mp.currentPage()
  console.log('page:', page.path)
  await page.callMethod('onPick', { currentTarget: { dataset: { v: 'pay' } } })
  // 安装 mock 并验证它真的生效
  const mockState = await mp.evaluate(b => {
    wx.__modalBackup = wx.__modalBackup || wx.showModal
    wx.showModal = opts => {
      const res = b === 'confirm'
        ? { confirm: true, cancel: false, errMsg: 'showModal:ok' }
        : { confirm: false, cancel: true, errMsg: 'showModal:ok' }
      if (opts && opts.success) opts.success(res)
      if (opts && opts.complete) opts.complete(res)
    }
    return { installed: typeof wx.showModal === 'function', backupKept: !!wx.__modalBackup }
  }, 'confirm')
  console.log('mock installed:', JSON.stringify(mockState))
  await page.callMethod('onConfirm')
  await sleep(1500)
  const stack = await mp.pageStack()
  console.log('stack:', JSON.stringify(stack.map(p => p.path)))
  console.log('errors:', errs.length ? errs : '(none)')
  await mp.evaluate(() => { if (wx.__modalBackup) { wx.showModal = wx.__modalBackup; wx.__modalBackup = null } })
  await mp.disconnect()
}
main().catch(e => { console.error('FATAL:', e.message); process.exit(1) })
