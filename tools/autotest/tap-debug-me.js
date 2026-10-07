const cmpPath = require.resolve('licia/cmpVersion')
const origCmp = require(cmpPath)
require.cache[cmpPath].exports = (a, b) => (typeof a !== 'string' ? 0 : origCmp(a, b))
const automator = require('miniprogram-automator')
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const mp = await automator.connect({ wsEndpoint: 'ws://localhost:9420', timeout: 30000 })
  mp.on('console', m => console.log('[console]', m.type, String(m.text).slice(0, 200)))
  await mp.reLaunch('/pages/index/index')
  await sleep(2000)
  let page = await mp.currentPage()
  const el = await page.$('.me-entry')
  console.log('element found:', !!el)
  if (el) {
    const size = await el.size()
    console.log('size:', JSON.stringify(size))
    const offset = await el.offset()
    console.log('offset:', JSON.stringify(offset))
    await el.tap()
    await sleep(2000)
    const stack = await mp.pageStack()
    console.log('stack after tap:', JSON.stringify(stack.map(p => p.path)))
  }
  await mp.disconnect()
}
main().catch(e => { console.error('FATAL:', e.message); process.exit(1) })
