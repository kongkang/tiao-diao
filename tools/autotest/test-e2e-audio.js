// 端到端声学判定：模拟器放试听 → 数字回环收录 → FFT 判定音高
// 注入 440Hz 标准音，验证三个调级落点：
//   +2 级 ≈ 493.9Hz ｜ -3 级 ≈ 370.0Hz ｜ 0 级 = 440Hz（原样）
// 链路覆盖：Worker 解码 → WSOLA 变调 → WebAudio 播放 → 系统输出 → 麦克风/回环
//
// 【采集路径说明 2026-10-06】HiDock 免提的麦克风带回声消除，会把自己喇叭的声音抹掉
// （实测 SNR 只有 8x 的噪音残留），所以走 iFLYTEK 虚拟声卡数字回环：
// 输出切到 iFLYTEK → 它的输入端就是纯净数字信号（SNR 2700x+）。
// 想走真喇叭+真麦，把 LOOPBACK 改 false 并指定 MIC 即可，但要关掉免提的 AEC。
//
// 依赖：./set-output（切换默认输出设备，源码 set-output.m 可重编）
//       ffmpeg（录音）、venv numpy（freq-check.py）
// 用法：node test-e2e-audio.js
const cmpPath = require.resolve('licia/cmpVersion')
const origCmp = require(cmpPath)
require.cache[cmpPath].exports = (a, b) => (typeof a !== 'string' ? 0 : origCmp(a, b))

const automator = require('miniprogram-automator')
const injectSong = require('./inject-song.js')
const { spawn, spawnSync, execSync } = require('child_process')
const sleep = ms => new Promise(r => setTimeout(r, ms))

const FFMPEG = '/opt/homebrew/bin/ffmpeg'
const SET_OUTPUT = __dirname + '/set-output'
const LOOPBACK = true                 // true=数字回环（无声）；false=真喇叭+真麦
const OUT_DEVICE = 'iFLYTEK'          // 回环时的输出设备（名称子串）
const MIC = ':1'                      // 回环输入；真麦时改成 ':4'（HiDock）等
const MIC_RATE = '44100'
const PY = '/Users/kongkang/.workbuddy/binaries/python/envs/default/bin/python'
const FREQ_CHECK = __dirname + '/freq-check.py'
const REC = '/tmp/e2e-rec.wav'
const REC_SEC = 10

/** 录 REC_SEC 秒 → Python FFT 判定主频是否命中 expected */
async function recordAndCheck(expectedHz, label) {
  const ff = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'avfoundation', '-i', MIC, '-t', String(REC_SEC), '-ar', MIC_RATE, '-ac', '1', REC])
  let ffErr = ''
  ff.stderr.on('data', d => { ffErr += d })
  await sleep(800) // 等 ffmpeg 真正开始录
  return {
    done: new Promise((resolve) => {
      ff.on('close', (code) => {
        if (code !== 0) {
          console.log('❌ ' + label + '：录音失败（ffmpeg exit ' + code + '）' + ffErr.slice(0, 200))
          return resolve(false)
        }
        const r = spawnSync(PY, [FREQ_CHECK, REC, String(expectedHz)], { encoding: 'utf8' })
        const out = (r.stdout || '').trim() || (r.stderr || '').trim().slice(0, 200)
        const ok = out.endsWith('PASS')
        console.log((ok ? '✅ ' : '❌ ') + label + '：' + out)
        resolve(ok)
      })
    }),
  }
}

async function main() {
  // 切输出设备到回环，结束恢复原设备
  const origOut = LOOPBACK ? execSync('"' + SET_OUTPUT + '" -c').toString().trim() : ''
  if (LOOPBACK) {
    execSync('"' + SET_OUTPUT + '" "' + OUT_DEVICE + '"')
    console.log('输出已切到 ' + OUT_DEVICE + '（数字回环，全程无声），结束恢复 ' + origOut)
  }

  const mp = await automator.connect({ wsEndpoint: 'ws://localhost:9420', timeout: 30000 })
  console.log('=== 已连接 ===')
  let pass = 0, fail = 0
  try {
    await injectSong(mp, 60)               // 注入默认静音
    await mp.evaluate(() => require('services/audio.js').setPreviewMuted(false)) // 本轮要真出声
    await mp.reLaunch('/pages/pitch/index')
    await sleep(2000)
    let page = await mp.currentPage()
    if (page.path !== 'pages/pitch/index') { console.log('❌ 没停在 pitch'); return }

    // 轮 1：+2 级（注入默认），期望 493.9Hz
    let rec = await recordAndCheck(493.9, '+2 级')
    await page.callMethod('onPlayToggle')
    ;(await rec.done) ? pass++ : fail++

    // 等这段 15s 播完回 idle，再改调
    await sleep(9000)

    // 轮 2：连按 5 次 − 到 -3 级，期望 370.0Hz
    rec = await recordAndCheck(370.0, '-3 级')
    for (let i = 0; i < 5; i++) await page.callMethod('onDown')
    ;(await rec.done) ? pass++ : fail++
    await sleep(9000)

    // 轮 3：连按 3 次 ＋ 回 0 级（原样），期望 440Hz
    rec = await recordAndCheck(440.0, '0 级（原样）')
    for (let i = 0; i < 3; i++) await page.callMethod('onUp')
    ;(await rec.done) ? pass++ : fail++

    // 收尾
    await mp.evaluate(() => { require('services/audio.js').stopPreview(); require('services/session.js').clear() })
    await mp.reLaunch('/pages/index/index')
  } finally {
    if (LOOPBACK && origOut) execSync('"' + SET_OUTPUT + '" "' + origOut + '"')
    try { await mp.disconnect() } catch (e) { /* 已断开 */ }
  }
  console.log('=== DONE：' + pass + ' 过 / ' + fail + ' 挂 ===')
  if (fail > 0) process.exit(1)
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1) })
