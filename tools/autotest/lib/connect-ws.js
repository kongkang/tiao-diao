// 连上微信开发者工具的自动化长连接(一条 WebSocket 跑完所有步骤)
//
// 为什么必须走这条通道(2026-11-26 用户明确要求):
//   `wechatide <tool>` 这种「一步一条命令」的方式,每执行一步都会把开发者工具弹到前台一次,
//   一个端到端用例几十步,窗口就闪几十次。而且它没有「不前置」的开关。
//   长连接只在建立时接触 IDE 一次,之后所有步骤都在后台走,不会抢焦点。
//
// 连接前需要开一次通道(只做一次,会让开发者工具到前台一次):
//   /Applications/wechatwebdevtools.app/Contents/MacOS/cli auto --project <项目路径> --auto-port 9420
// 坑:cli auto 被杀后重挂可能不重新绑定端口(打印成功但 9420 不监听)
//   → cli quit → open -a wechatwebdevtools → 等登录 → 再 cli auto
const WS_ENDPOINT = 'ws://localhost:9420'
const CLI = '/Applications/wechatwebdevtools.app/Contents/MacOS/cli'

// automator.connect 内部的 checkVersion 会在模拟器未就绪时崩(SDKVersion undefined → cmpVersion 读 split),打补丁绕过
const cmpPath = require.resolve('licia/cmpVersion')
const origCmp = require(cmpPath)
require.cache[cmpPath].exports = (a, b) => (typeof a !== 'string' ? 0 : origCmp(a, b))
if (require.cache[cmpPath].exports.default) {
  const d = require.cache[cmpPath].exports.default
  require.cache[cmpPath].exports.default = (a, b) => (typeof a !== 'string' ? 0 : d(a, b))
}

const notStarted = () => new Error([
  '自动化通道没开(端口 9420 没有监听)。',
  '开一次即可 —— 只会让开发者工具到前台一次,之后整个测试都在后台跑:',
  '  ' + CLI + ' auto --project <项目路径> --auto-port 9420',
].join('\n'))

/**
 * @param {object} opts  { start: true } 通道没开时由这里启动(会把开发者工具拉到前台一次,默认不做)
 * @returns {Promise<object>} automator 实例:evaluate / pageStack / currentPage / reLaunch / navigateTo …
 */
async function connectAutomation(opts) {
  const automator = require('miniprogram-automator')
  let mp
  try {
    mp = await automator.connect({ wsEndpoint: WS_ENDPOINT, timeout: 30000 })
  } catch (e) {
    const msg = String((e && e.message) || e)
    if (!/ECONNREFUSED|connect|socket|timeout/i.test(msg)) throw e
    if (!(opts && opts.start)) throw notStarted()
    // 由调用方明确要求才启动
    const { execFileSync } = require('child_process')
    execFileSync(CLI, ['auto', '--project', opts.project, '--auto-port', '9420'], { timeout: 120000, stdio: 'ignore' })
    for (let i = 0; i < 40 && !mp; i++) {
      await new Promise(r => setTimeout(r, 1500))
      mp = await automator.connect({ wsEndpoint: WS_ENDPOINT, timeout: 30000 }).catch(() => null)
    }
    if (!mp) throw notStarted()
  }
  return mp
}

module.exports = { connectAutomation, WS_ENDPOINT, CLI }
