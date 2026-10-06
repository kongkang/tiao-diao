// 诊断：模拟器里买分钟流程到底会不会触发 requestVirtualPayment
const cmpPath = require.resolve('licia/cmpVersion')
const origCmp = require(cmpPath)
require.cache[cmpPath].exports = (a, b) => (typeof a !== 'string' ? 0 : origCmp(a, b))

const automator = require('miniprogram-automator')
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const mp = await automator.connect({ wsEndpoint: 'ws://localhost:9420', timeout: 30000 })
  console.log('=== 已连接 ===')

  // 1) 运行时配置实况
  const cfg = await mp.evaluate(() => {
    const c = require('config.js')
    return { PAY_ENABLED: c.PAY_ENABLED, AD_ENABLED: c.AD_ENABLED }
  })
  console.log('运行时开关:', JSON.stringify(cfg))

  // 2) 监控 requestVirtualPayment 是否被调（包一层探针）
  await mp.evaluate(() => {
    if (!wx.__vpPatched) {
      const orig = wx.requestVirtualPayment
      wx.requestVirtualPayment = function (opt) {
        wx.__vpCalled = (wx.__vpCalled || 0) + 1
        console.log('[probe] requestVirtualPayment CALLED')
        if (orig) return orig.call(wx, opt)
      }
      wx.__vpPatched = true
    }
  })

  // 3) 去买分钟页，触发 onBuy
  await mp.reLaunch('/pages/buy/index')
  await sleep(2000)
  let page = await mp.currentPage()
  console.log('当前页:', page.path)
  await page.callMethod('onBuy')
  await sleep(3000)

  const probe = await mp.evaluate(() => ({ vpCalled: wx.__vpCalled || 0 }))
  console.log('requestVirtualPayment 被调次数:', probe.vpCalled, probe.vpCalled === 0 ? '✅ 拦截有效' : '❌ 拦截被穿透！')

  await mp.screenshot({ path: __dirname + '/shots/buy-after-tap.png' })

  // 收尾回首页
  await mp.reLaunch('/pages/index/index')
  await mp.disconnect()
  console.log('=== DONE ===')
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1) })
