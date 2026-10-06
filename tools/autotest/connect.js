// 自动化通道诊断：连接 IDE 自动化会话，打印模拟器真实状态
// 用法: node connect.js
// 说明: automator.connect 内部的 checkVersion 会在模拟器未就绪时崩
//       （SDKVersion undefined → cmpVersion 读 split），这里打补丁绕过后手动探查

// --- monkey-patch licia/cmpVersion：容忍 undefined ---
const cmpPath = require.resolve('licia/cmpVersion')
const origCmp = require(cmpPath)
require.cache[cmpPath].exports = (a, b) => (typeof a !== 'string' ? 0 : origCmp(a, b))
// 兼容 default 导出形式
if (require.cache[cmpPath].exports.default) {
  const d = require.cache[cmpPath].exports.default
  require.cache[cmpPath].exports.default = (a, b) => (typeof a !== 'string' ? 0 : d(a, b))
}

const automator = require('miniprogram-automator')

async function main() {
  const mp = await automator.connect({ wsEndpoint: 'ws://localhost:9420', timeout: 30000 })
  console.log('=== CONNECTED ===')

  // 1) 模拟器信息
  try {
    const info = await mp.send('Tool.getInfo')
    console.log('Tool.getInfo:', JSON.stringify(info).slice(0, 500))
  } catch (e) {
    console.log('Tool.getInfo ERROR:', e.message)
  }

  // 2) 当前页面
  try {
    const page = await mp.currentPage()
    console.log('current page path:', page && page.path)
  } catch (e) {
    console.log('currentPage ERROR:', e.message)
  }

  // 3) 页面栈
  try {
    const stack = await mp.pageStack()
    console.log('pageStack:', JSON.stringify(stack.map(p => p.path)))
  } catch (e) {
    console.log('pageStack ERROR:', e.message)
  }

  // 4) 控制台消息（近 50 条）
  try {
    const logs = mp.console ? await Promise.race([
      (async () => {
        const arr = []
        // 部分版本 automator 不支持回溯日志，仅尝试监听 3 秒
        mp.on('console', m => arr.push(`[${m.type}] ${m.text}`))
        await new Promise(r => setTimeout(r, 3000))
        return arr
      })(),
      new Promise(r => setTimeout(() => r(['<timeout>']), 3500)),
    ]) : ['<no console api>']
    console.log('console(3s):', logs.length ? logs.slice(0, 50) : '(无新消息)')
  } catch (e) {
    console.log('console ERROR:', e.message)
  }

  // 5) 截图留证
  try {
    await mp.screenshot({ path: '/Users/kongkang/Developer/tiao-diao/tools/autotest/simulator.png' })
    console.log('screenshot saved: tools/autotest/simulator.png')
  } catch (e) {
    console.log('screenshot ERROR:', e.message)
  }

  await mp.disconnect()
  console.log('=== DONE ===')
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1) })
