// 一次性探针：量「我的」页头像按钮/裁圆框/相机角标的实际包围盒，定位角标偏移原因
const cmpPath = require.resolve('licia/cmpVersion')
const origCmp = require(cmpPath)
require.cache[cmpPath].exports = (a, b) => (typeof a !== 'string' ? 0 : origCmp(a, b))
if (require.cache[cmpPath].exports.default) {
  const d = require.cache[cmpPath].exports.default
  require.cache[cmpPath].exports.default = (a, b) => (typeof a !== 'string' ? 0 : d(a, b))
}
const automator = require('miniprogram-automator')

async function main() {
  const mp = await automator.connect({ wsEndpoint: 'ws://localhost:9420', timeout: 30000 })
  await mp.reLaunch('/pages/me/index')
  await new Promise(r => setTimeout(r, 1200))
  const page = await mp.currentPage()
  for (const sel of ['.avatar-btn', '.avatar-wrap', '.avatar-img', '.avatar-cam']) {
    const el = await page.$(sel)
    if (!el) { console.log(sel, '-> NOT FOUND'); continue }
    const size = await el.size()
    const offset = await el.offset()
    console.log(sel, '-> size', JSON.stringify(size), 'offset', JSON.stringify(offset))
  }
  await mp.disconnect()
  console.log('=== DONE ===')
}
main().catch(e => { console.error('FATAL:', e.message); process.exit(1) })
