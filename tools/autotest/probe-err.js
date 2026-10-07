const cmpPath = require.resolve('licia/cmpVersion')
const origCmp = require(cmpPath)
require.cache[cmpPath].exports = (a, b) => (typeof a !== 'string' ? 0 : origCmp(a, b))
const automator = require('miniprogram-automator')
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const mp = await automator.connect({ wsEndpoint: 'ws://localhost:9420', timeout: 30000 })
  const errs = []
  mp.on('console', m => {
    if (m.type === 'error') errs.push(JSON.stringify(m).slice(0, 600))
  })
  await mp.reLaunch('/pages/unlock/index')
  await sleep(2500)
  console.log('errors during unlock load:')
  errs.forEach(e => console.log('  ', e))
  await mp.disconnect()
}
main().catch(e => { console.error('FATAL:', e.message); process.exit(1) })
