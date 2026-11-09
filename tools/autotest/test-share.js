// 全站分享回归（2026-11-06）：验证每个页面都挂上了 onShareAppMessage / onShareTimeline
// ——右上角「转发给朋友」「分享到朋友圈」「复制链接」全靠这两个处理器开启
// 用法: node test-share.js
// 前提: 已执行 `cli auto --project <项目根> --auto-port 9420`

const cmpPath = require.resolve('licia/cmpVersion')
const origCmp = require(cmpPath)
require.cache[cmpPath].exports = (a, b) => (typeof a !== 'string' ? 0 : origCmp(a, b))

const automator = require('miniprogram-automator')

let pass = 0, fail = 0
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name + (extra ? ' — ' + extra : '')) }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

// 全站页面清单（与 app.json 一致）；流程中间页分享卡片统一指首页
const PAGES = [
  'pages/index/index',
  'pages/me/index',
  'pages/pitch/index',
  'pages/unlock/index',
  'pages/process/index',
  'pages/result/index',
  'pages/buy/index',
  'pages/adsim/index',
  'pages/admin/index',
]

async function main() {
  const mp = await automator.connect({ wsEndpoint: 'ws://localhost:9420', timeout: 30000 })
  console.log('=== 全站分享回归 ===')

  for (const route of PAGES) {
    try {
      const page = await mp.reLaunch('/' + route)
      await new Promise(r => setTimeout(r, 600)) // 等页面 onShow 稳定

      const fwd = await page.callMethod('onShareAppMessage')
      check(route + ' onShareAppMessage', !!fwd && !!fwd.title && !!fwd.path && !!fwd.imageUrl,
        fwd ? `title=${fwd.title} img=${fwd.imageUrl}` : '返回空')

      const tl = await page.callMethod('onShareTimeline')
      check(route + ' onShareTimeline', !!tl && !!tl.title && !!tl.imageUrl,
        tl ? `title=${tl.title} img=${tl.imageUrl}` : '返回空')
    } catch (e) {
      check(route + ' 打开+分享处理器', false, e.message.slice(0, 120))
    }
  }

  console.log(`\n结果: ${pass} pass / ${fail} fail`)
  await mp.disconnect()
  process.exit(fail ? 1 : 0)
}

main().catch(e => { console.error('FATAL', e); process.exit(2) })
