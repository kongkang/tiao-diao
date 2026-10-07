const cmpPath = require.resolve('licia/cmpVersion')
const origCmp = require(cmpPath)
require.cache[cmpPath].exports = (a, b) => (typeof a !== 'string' ? 0 : origCmp(a, b))
const automator = require('miniprogram-automator')
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const mp = await automator.connect({ wsEndpoint: 'ws://localhost:9420', timeout: 30000 })
  mp.on('console', m => console.log('[console]', m.type, String(m.text).slice(0, 200)))
  const song = await mp.evaluate(() => {
    const s = require('services/session.js').getSong()
    return s ? { name: s.name, token: s.token, dur: s.durationSec } : null
  })
  console.log('session.getSong():', JSON.stringify(song))
  const ent = await mp.evaluate(() => require('services/billing.js').getEntitlement())
  console.log('entitlement:', JSON.stringify(ent))
  await mp.reLaunch('/pages/unlock/index')
  await sleep(2000)
  const cur = await mp.currentPage()
  console.log('currentPage:', cur.path)
  if (cur.path === 'pages/unlock/index') {
    const d = await cur.data()
    console.log('unlock data.song:', JSON.stringify(d.song), 'billing:', JSON.stringify(d.billing))
    console.log('opts:', (await cur.$$('.opt')).length)
  }
  await mp.disconnect()
}
main().catch(e => { console.error('FATAL:', e.message); process.exit(1) })
