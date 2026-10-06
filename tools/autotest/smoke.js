// M0 模拟器冒烟测试：6 页巡查（报错/截图）+ 引擎端到端（注入合成 PCM 跑 Worker）
// 用法: node smoke.js
// 前提: 已执行 `cli auto --project <项目根> --auto-port 9420`

// --- monkey-patch licia/cmpVersion：容忍 SDKVersion 缺失 ---
const cmpPath = require.resolve('licia/cmpVersion')
const origCmp = require(cmpPath)
require.cache[cmpPath].exports = (a, b) => (typeof a !== 'string' ? 0 : origCmp(a, b))

const fs = require('fs')
const automator = require('miniprogram-automator')

const SHOTS = __dirname + '/shots'
fs.mkdirSync(SHOTS, { recursive: true })

const ROUTES = [
  '/pages/index/index',
  '/pages/pitch/index',
  '/pages/unlock/index',
  '/pages/process/index',
  '/pages/result/index',
  '/pages/buy/index',
]

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const mp = await automator.connect({ wsEndpoint: 'ws://localhost:9420', timeout: 30000 })
  console.log('=== 已连接模拟器 ===')

  // 收集控制台 error 与未捕获异常
  const errors = []
  mp.on('console', m => {
    if (m.type === 'error') {
      let text = ''
      try { text = JSON.stringify(m).slice(0, 600) } catch (e) { text = String(m) }
      errors.push('[console.error] ' + text)
    }
  })
  if (mp.on) mp.on('exception', e => errors.push('[exception] ' + String(e && e.message || e).slice(0, 300)))

  // ---------- 第一部分：页面巡查 ----------
  // 先清 session：保证无歌守卫（pitch/unlock/process/result 无歌弹回首页）可复现，
  // 否则带着上一轮的假歌跑，process 页会直接开始真转调并把 reLaunch 拖过 10s 服务器超时
  await mp.evaluate(() => { require('services/session.js').clear() })
  console.log('\n--- 页面巡查（已清 session，无歌状态） ---')
  for (const route of ROUTES) {
    try {
      await mp.reLaunch(route)
      await sleep(1800)
      const page = await mp.currentPage()
      const name = route.split('/')[2]
      await mp.screenshot({ path: `${SHOTS}/${name}.png` })
      console.log(`${route} -> 落在 ${page.path}（截图 shots/${name}.png）`)
    } catch (e) {
      errors.push(`[reLaunch ${route}] ${e.message}`)
      console.log(`${route} -> 跳转失败: ${e.message}`)
    }
  }

  // ---------- 第二部分：引擎端到端 ----------
  console.log('\n--- 引擎端到端（模拟器内 Worker 实测） ---')
  // 先回首页（页面存在与否不影响 appservice 里的模块调用）
  await mp.reLaunch('/pages/index/index')
  await sleep(1000)

  // 2.1 验证 evaluate 里能 require 服务模块（尝试不同路径形式）
  const probe = await mp.evaluate(() => {
    const tries = ['services/engine.js', '/services/engine.js', './services/engine.js']
    for (const p of tries) {
      try {
        const engine = require(p)
        if (engine && typeof engine.run === 'function') return { ok: true, path: p }
      } catch (e) { /* 继续试下一个 */ }
    }
    // 兜底：从全局 webpack 模块表里找
    try {
      const keys = Object.keys(globalThis.__wxWebpackModules__ || {})
      return { ok: false, msg: 'all paths failed', webpackKeys: keys.slice(0, 20) }
    } catch (e) {
      return { ok: false, msg: 'all paths failed' }
    }
  })
  console.log('require engine:', JSON.stringify(probe))

  if (probe.ok) {
    // 2.2 注入 1 秒 440Hz 正弦波 → +2 半音 → WAV，验证输出
    const result = await mp.evaluate((enginePath) => new Promise(resolve => {
      const engine = require(enginePath)
      const sr = 44100
      const n = sr * 1
      const pcmL = new Float32Array(n)
      for (let i = 0; i < n; i++) pcmL[i] = 0.5 * Math.sin(2 * Math.PI * 440 * i / sr)
      const pcmR = new Float32Array(pcmL)
      engine.run({
        semitones: 2, sampleRate: sr, channels: 2, length: n,
        encode: 'wav', pcmL, pcmR,
      }).then(res => resolve({
        ok: true, ext: res.ext, bytes: res.data.byteLength,
        durationSec: res.durationSec, elapsedMs: res.elapsedMs,
      })).catch(e => resolve({ ok: false, msg: String(e.message || e) }))
    }), probe.path)
    console.log('变调结果:', JSON.stringify(result))
    if (result.ok) {
      const expectSec = 1.0
      const durOk = Math.abs(result.durationSec - expectSec) < 0.15
      const wavOk = result.ext === 'wav' && result.bytes > 44 + 44100 * 4 * 0.8
      console.log(`校验: 时长 ${result.durationSec.toFixed(3)}s（期望≈${expectSec}）${durOk ? 'PASS' : 'FAIL'}；WAV 字节 ${result.bytes} ${wavOk ? 'PASS' : 'FAIL'}`)
    }
  }

  // ---------- 汇总 ----------
  console.log('\n=== 汇总 ===')
  if (errors.length) {
    console.log(`发现 ${errors.length} 条错误:`)
    errors.forEach(e => console.log('  ' + e))
  } else {
    console.log('无 console.error / 未捕获异常 ✅')
  }

  await mp.disconnect()
  console.log('=== DONE ===')
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1) })
