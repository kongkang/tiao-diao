// 深挖 console.error 真实内容 + 单独复现 unlock 页问题
const cmpPath = require.resolve('licia/cmpVersion')
const origCmp = require(cmpPath)
require.cache[cmpPath].exports = (a, b) => (typeof a !== 'string' ? 0 : origCmp(a, b))

const automator = require('miniprogram-automator')
const sleep = ms => new Promise(r => setTimeout(r, ms))

function deepArg(a) {
  if (!a || typeof a !== 'object') return String(a)
  const parts = []
  for (const k of ['type', 'subtype', 'className', 'description', 'value', 'text']) {
    if (a[k] !== undefined) parts.push(`${k}=${typeof a[k] === 'object' ? JSON.stringify(a[k]).slice(0, 200) : String(a[k]).slice(0, 300)}`)
  }
  if (a.preview && a.preview.properties) {
    parts.push('props=' + a.preview.properties.map(p => `${p.name}:${String(p.value).slice(0, 100)}`).join(', '))
  }
  return parts.join(' | ') || JSON.stringify(a).slice(0, 300)
}

async function main() {
  const mp = await automator.connect({ wsEndpoint: 'ws://localhost:9420', timeout: 30000 })
  console.log('=== 已连接 ===')

  mp.on('console', m => {
    if (m.type !== 'error' && m.type !== 'warning') return
    const args = (m.args || []).map(deepArg).join(' || ')
    console.log(`\n[${m.type}] ${args}`)
    if (m.stackTrace) {
      m.stackTrace.callFrames.slice(0, 5).forEach(f =>
        console.log(`    at ${f.functionName || '(anon)'} (${f.url}:${f.lineNumber + 1})`))
    }
  })

  // 注入歌曲并直达 unlock 页
  await mp.evaluate(() => {
    const session = require('services/session.js')
    const sr = 44100, n = sr * 180
    const pcmL = new Float32Array(n)
    for (let i = 0; i < n; i++) pcmL[i] = 0.5 * Math.sin(2 * Math.PI * 440 * i / sr)
    session.setSong({
      path: '/tmp/fake.wav', name: '测试歌（3分钟）.wav',
      durationSec: 180, sampleRate: sr, channels: 2, length: n,
      pcmL, pcmR: new Float32Array(pcmL),
    })
    session.setSemitones(2)
  })

  console.log('\n--- reLaunch 直达 unlock ---')
  await mp.reLaunch('/pages/unlock/index')
  await sleep(2500)
  let page = await mp.currentPage()
  console.log('落在:', page.path)

  await sleep(2000)
  await mp.disconnect()
  console.log('=== DONE ===')
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1) })
