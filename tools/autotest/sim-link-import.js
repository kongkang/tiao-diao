#!/usr/bin/env node
/**
 * 模拟器端到端：贴链接 → 解析 → 提取 → 解码确认 → 选调页「下一步」门禁 → 转调 → 结果文件
 *
 * 通过微信开发者工具的自动化通道驱动（wechatide CLI），调的是线上真实云函数。
 * 覆盖两件事：
 *   1) 链接导入在真机之前先把整条链路跑通（抖音 / 视频号 / B站长视频选段）
 *   2) 「解析成功才允许下一步」这道门：该放行的放行，该拦下的拦下
 *
 * 用法：node tools/autotest/sim-link-import.js <项目路径> [用例名过滤]
 * 前提：开发者工具已打开该项目窗口并登录；parseMedia / fetchMedia 已部署。
 *
 * 不动真实余额：需要走解锁页的用例，会先把「扣费」换成空操作（只在模拟器内存里，重编译即恢复）。
 * 网络：提取耗时随网络波动较大（几秒到一分钟），用例里只断言结果、不断言耗时。
 */
const { execFileSync } = require('child_process')

const W = '/Applications/wechatwebdevtools.app/Contents/MacOS/wechatide'
const P = process.argv[2]
const FILTER = process.argv[3] || ''
if (!P) {
  console.log('用法: node tools/autotest/sim-link-import.js <项目路径> [用例名过滤]')
  process.exit(2)
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ---------- 自动化通道 ----------
function cli(tool, args) {
  const out = execFileSync(W, ['-c', 'ZCode', tool, '--project', P].concat(args), { encoding: 'utf8', maxBuffer: 1 << 26, timeout: 90000 })
  const j = JSON.parse(out.slice(out.indexOf('{')))
  if (!j.ok) throw new Error(tool + ' 失败: ' + JSON.stringify(j).slice(0, 300))
  return j.result
}
/** 在小程序里执行一段函数（可异步；单次有 10 秒上限），返回它的返回值 */
function ev(fnSource) {
  return cli('automation_evaluate', ['--fn-source', fnSource]).result.result
}
function stack() {
  return cli('automation_runtime_info', ['--action', 'pageStack']).pageStack.map(p => p.route)
}
// 当前页面实例统一从运行时取（automation_page_action 的 callMethod 在页面切换后可能拿到旧实例）
function withPage(body, args) {
  return ev('function(){ const p = getCurrentPages().slice(-1)[0]; const args = ' + JSON.stringify(args || []) + '; ' + body + ' }')
}
function pageData(path) {
  return withPage(path ? 'const v = p.data.' + path + '; return v === undefined ? null : JSON.parse(JSON.stringify(v))' : 'return JSON.parse(JSON.stringify(p.data))')
}
function has(selector) {
  // 元素不存在时这个工具直接报错（不是返回空），所以失败 = 没有
  try {
    return !!cli('automation_page_action', ['--action', 'querySelector', '--selector', selector]).element
  } catch (e) {
    return false
  }
}
/** 同步调用页面方法（要返回值） */
function callMethod(name, args) {
  return withPage('return p.' + name + '.apply(p, args)', args)
}
/** 异步页面方法：发起后不等待（提取、处理可能要十几秒，超过通道上限） */
function fire(name, args) {
  return withPage('p.' + name + '.apply(p, args); return "started"', args)
}
function navigate(action, url) {
  cli('automation_navigate', ['--action', action, '--url', url])
}
async function waitStack(route, timeoutMs) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const s = stack()
    if (s[s.length - 1] === route) return Date.now() - t0
    await sleep(500)
  }
  throw new Error('等不到页面 ' + route + ',当前栈: ' + stack().join(' > '))
}
async function waitData(path, pred, timeoutMs) {
  const t0 = Date.now()
  let last
  while (Date.now() - t0 < timeoutMs) {
    last = pageData(path)
    if (pred(last)) return last
    await sleep(600)
  }
  throw new Error('等 ' + (path || '页面数据') + ' 满足条件超时,最后是 ' + JSON.stringify(last).slice(0, 300))
}
function songSummary() {
  return ev(`function(){ const s = require('services/session.js').getSong(); if (!s) return null
    return { verified: s.verified, imported: s.imported, durationSec: Math.round(s.durationSec * 10) / 10,
      sizeKB: Math.round((s.size || 0) / 1024), format: s.format, sampleRate: s.sampleRate, sliceText: s.sliceText || '' } }`)
}
/** 把 showModal 换成记录器：弹窗内容能断言，也不会挡住后面的操作 */
function armModalCapture() {
  const r = ev(`function(){ globalThis.__modals = []
    if (!wx.__origShowModal) wx.__origShowModal = wx.showModal
    try { wx.showModal = function(o){ globalThis.__modals.push({ title: o.title, content: o.content, showCancel: o.showCancel }) } } catch (e) { return 'cant patch: ' + e.message }
    return 'ok' }`)
  if (r !== 'ok') throw new Error('拦不到 showModal: ' + r)
}
const modals = () => ev('function(){ return globalThis.__modals || [] }')
const resetModals = () => ev('function(){ globalThis.__modals = [] }')

// ---------- 流程片段 ----------
/** 进链接页，粘文案，解析 */
async function parseLink(text) {
  navigate('reLaunch', '/pages/link/index')
  await waitStack('/pages/link/index', 15000)
  await sleep(800)
  resetModals()
  callMethod('onInput', [{ detail: { value: text } }])
  fire('onParse')
  return waitData('parsed', v => !!v, 30000)
}
/** 点「提取」，等进选调页；中途弹了窗就把弹窗带回来 */
async function extractAndWait(timeoutMs) {
  resetModals()
  fire('onImport')
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const s = stack()
    if (s[s.length - 1] === '/pages/pitch/index') return { ms: Date.now() - t0 }
    const m = modals()
    if (m.length) return { ms: Date.now() - t0, modal: m[0] }
    await sleep(700)
  }
  return { ms: Date.now() - t0, timeout: true }
}
/** 选调页门禁：确认通过才有「下一步」；没通过就没有 */
async function assertPitchGate(label, expectOk) {
  const d = await waitData(null, v => v.verifyState !== 'checking', 30000)
  const hasNext = has('.btn-primary')
  if (expectOk) {
    if (d.verifyState !== 'ok') throw new Error(label + ' 解析确认应为 ok,实际 ' + d.verifyState + ':' + d.verifyText)
    if (!hasNext) throw new Error(label + ' 确认通过后应出现「下一步」')
  } else {
    if (d.verifyState !== 'failed') throw new Error(label + ' 应判为打不开,实际 ' + d.verifyState)
    if (hasNext) throw new Error(label + ' 解析没成功时不该出现「下一步」')
    if (!has('.verify-title')) throw new Error(label + ' 应显示「这首歌打不开」说明卡')
  }
  return { verifyState: d.verifyState, verifyText: d.verifyText, hasNext, durationText: d.durationText }
}
/** 往会话里放一首本地合成的 WAV（等价于「从微信选了一首歌」，走真实的 analyze） */
async function injectLocalSong() {
  ev(`function(){ const session = require('services/session.js')
    globalThis.__gate = { status: 'loading' }
    const sr = 44100, n = sr * 30
    const pcm = new Int16Array(n * 2)
    const one = new Int16Array(sr * 2)
    for (let i = 0; i < sr; i++) { const v = Math.round(0.3 * 32767 * Math.sin(2 * Math.PI * 440 * i / sr)); one[i * 2] = v; one[i * 2 + 1] = v }
    for (let k = 0; k < 30; k++) pcm.set(one, k * sr * 2)   // 1 秒一块铺 30 次（440Hz 整周期，首尾相接）
    const buf = new ArrayBuffer(44 + pcm.byteLength); const v = new DataView(buf)
    const ws = (o, str) => { for (let i = 0; i < str.length; i++) v.setUint8(o + i, str.charCodeAt(i)) }
    ws(0, 'RIFF'); v.setUint32(4, 36 + pcm.byteLength, true); ws(8, 'WAVE'); ws(12, 'fmt ')
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true); v.setUint32(24, sr, true)
    v.setUint32(28, sr * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true); ws(36, 'data'); v.setUint32(40, pcm.byteLength, true)
    new Uint8Array(buf, 44).set(new Uint8Array(pcm.buffer))
    try { require('services/audio.js').setPreviewMuted(true) } catch (e) {}
    require('services/engine.js').analyze(buf).then(meta => {
      session.setSong({ path: '/tmp/local-test.wav', name: '本地测试歌', size: buf.byteLength, format: 'wav', token: meta.token, frames: meta.frames,
        sampleRate: meta.sampleRate, channels: meta.channels, durationSec: meta.frames / meta.sampleRate })
      globalThis.__gate = { status: 'ready' }
    }, e => { globalThis.__gate = { status: 'error', msg: String(e.message || e) } })
    return 'started' }`)
  const t0 = Date.now()
  for (;;) {
    const g = ev('function(){ return globalThis.__gate }')
    if (g.status === 'ready') return
    if (g.status === 'error') throw new Error('合成测试歌没准备好: ' + g.msg)
    if (Date.now() - t0 > 60000) throw new Error('合成测试歌超时')
    await sleep(800)
  }
}
/** 像处理页那样走一遍：转调 → 结果文件分块落盘（直接调引擎和文件服务，不经过付费流程），等它跑完 */
async function processInSimulator(semitones, timeoutMs) {
  ev(`function(){ const engine = require('services/engine.js'); const audio = require('services/audio.js'); const fileSvc = require('services/file.js')
    const s = require('services/session.js').getSong()
    globalThis.__proc = { status: 'running', t0: Date.now() }
    let state = null
    audio.ensureSong(s)
      .then(() => fileSvc.beginResult(s.name, ${semitones}, 'mp3'))
      .then(st => { state = st; return engine.process({ token: s.token, semitones: ${semitones}, kbps: 160,
        onProgress: p => { globalThis.__proc.percent = p },
        onChunk: d => fileSvc.writeChunk(state, d) }) })
      .then(r => fileSvc.finishResult(state).then(out => {
        globalThis.__proc = { status: 'done', ms: Date.now() - globalThis.__proc.t0, result: r, file: { bytes: out.bytes } }
        return fileSvc.discardResult(state)
      }))
      .catch(e => { globalThis.__proc = Object.assign(globalThis.__proc, { status: 'error', msg: String(e.message || e) }) })
    return 'started' }`)
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    // 引擎忙着传分块时，自动化通道偶尔拿不到响应（会直接报错）：这种瞬时失败不算数，接着等
    let r
    try {
      r = ev('function(){ var p = globalThis.__proc; return { status: p.status, ms: p.ms, msg: p.msg, result: p.result, file: p.file } }')
    } catch (e) {
      await sleep(2000)
      continue
    }
    if (r.status === 'done') return r
    if (r.status === 'error') throw new Error('转调处理失败: ' + r.msg)
    await sleep(1500)
  }
  throw new Error('转调处理超时')
}
/** 结果文件与引擎报告、与时长 × 码率都对得上 */
function assertResultFile(pr, s, label) {
  const expectMB = Math.round((s.durationSec * 160 / 8 / 1024) * 10) / 10   // 160kbps = 20KB/s
  if (pr.result.ext !== 'mp3') throw new Error(label + ' 应输出 mp3: ' + pr.result.ext)
  if (Math.abs(pr.result.durationSec - s.durationSec) > 0.5) throw new Error(label + ' 转调产物时长不对: ' + pr.result.durationSec)
  if (Math.abs(pr.file.bytes - pr.result.bytes) > 4096) throw new Error(label + ' 落盘字节数与引擎报告不符: ' + pr.file.bytes + ' vs ' + pr.result.bytes)
  if (Math.abs(pr.file.bytes / 1048576 - expectMB) > 0.6) throw new Error(label + ' 结果文件大小不对: ' + (pr.file.bytes / 1048576).toFixed(1) + 'MB,应约 ' + expectMB + 'MB')
}

// ---------- 用例 ----------
const CASES = {}
const def = (name, fn) => { CASES[name] = fn }

def('抖音·整段只取音轨', async () => {
  const p = await parseLink('6.12 复制打开抖音,看看这个视频 https://v.douyin.com/9154AvnKE6w/ 很好听')
  console.log('    解析 | ' + p.platformName + ' | ' + p.durationText)
  const x = await extractAndWait(90000)
  if (x.modal || x.timeout) throw new Error('提取没进选调页: ' + JSON.stringify(x))
  await assertPitchGate('抖音', true)
  const s = songSummary()
  console.log('    提取 | 成品 ' + s.sizeKB + 'KB ' + s.format + ' ' + s.sampleRate + 'Hz | 时长 ' + s.durationSec + 's')
  if (s.sizeKB > 600) throw new Error('只取音轨后成品应远小于原视频（2.37MB）,实际 ' + s.sizeKB + 'KB')
  if (Math.abs(s.durationSec - 15) > 1) throw new Error('时长不对: ' + s.durationSec)
  if (s.verified !== true) throw new Error('应标记为已确认')
  // 转调 → 结果 mp3 落盘:确认「只取音轨」的产物手机端能正常转调
  const pr = await processInSimulator(2, 120000)
  console.log('    转调落盘 | 结果文件 ' + (pr.file.bytes / 1048576).toFixed(2) + 'MB | ' + pr.result.durationSec.toFixed(1) + 's')
  assertResultFile(pr, s, '抖音')
})

def('视频号·整段只取音轨', async () => {
  await parseLink('https://weixin.qq.com/sph/A6e7uGh8J8')
  const x = await extractAndWait(120000)
  if (x.modal || x.timeout) throw new Error('提取没进选调页: ' + JSON.stringify(x))
  await assertPitchGate('视频号', true)
  const s = songSummary()
  console.log('    提取 | 成品 ' + s.sizeKB + 'KB | 时长 ' + s.durationSec + 's')
  if (s.sizeKB > 400) throw new Error('只取音轨后成品应远小于原视频（1.05MB）,实际 ' + s.sizeKB + 'KB')
})

def('B站长视频·选一段再提取', async () => {
  // 28 分钟的视频:超过「一段最长 10 分钟」,要让用户选从第几分钟开始
  const p = await parseLink('https://www.bilibili.com/video/BV1R1yfzQEih')
  const slice = await waitData('slice', v => !!v, 10000)
  console.log('    视频 ' + p.durationText + ' | 选段初值 ' + JSON.stringify(slice))
  if (!(slice.startMin === 0 && slice.maxStartMin >= 18)) throw new Error('28 分钟的视频应让选段,且起点能拨到 18 分钟以后')
  for (let i = 0; i < 10; i++) callMethod('onSliceUp')
  const moved = pageData('slice')
  if (moved.startMin !== 10) throw new Error('连点 10 次加号应到「从第 11 分钟开始」,实际 ' + JSON.stringify(moved))
  const x = await extractAndWait(180000)
  if (x.modal || x.timeout) throw new Error('提取没进选调页: ' + JSON.stringify(x))
  const g = await assertPitchGate('B站选段', true)
  const s = songSummary()
  console.log('    从第 11 分钟起提取 | 成品 ' + (s.sizeKB / 1024).toFixed(1) + 'MB | 时长 ' + s.durationSec + 's | ' + s.sliceText)
  if (Math.abs(s.durationSec - 600) > 12) throw new Error('应取到约 10 分钟,实际 ' + s.durationSec + 's')
  if (!/第 (9|10) 分/.test(s.sliceText)) throw new Error('应标明是视频第 10 分钟附近起的一段（对齐到分片边界）: ' + s.sliceText)
  if (!/10 分/.test(g.durationText)) throw new Error('选调页应显示约 10 分钟（中段切片的时长靠解码确认修正）: ' + g.durationText)
  // 10 分钟的一段:转调 → 结果 mp3 完整落盘
  const pr = await processInSimulator(2, 400000)
  console.log('    转调落盘 | 结果文件 ' + (pr.file.bytes / 1048576).toFixed(2) + 'MB | ' + pr.result.durationSec.toFixed(1) + 's')
  if (Math.abs(pr.result.durationSec - 606.9) > 2) throw new Error('转调产物时长不对: ' + pr.result.durationSec)
  assertResultFile(pr, s, 'B站选段')
  // 确认通过 →「下一步」→ 解锁页,计费按这 10 分钟算（只看页面,不点确认,不动真实余额）
  fire('onNext')
  await waitStack('/pages/unlock/index', 10000)
  const b = pageData('billing')
  console.log('    解锁页计费 | ' + JSON.stringify(b))
  if (!(b.minutes >= 9 && b.minutes <= 11)) throw new Error('计费分钟应约为 10: ' + b.minutes)
})

def('本地选歌·走真实页面全流程(不扣费)', async () => {
  // 原有主流程的回归:选调 → 解锁 → 处理 → 结果页（确认链接导入的改动没碰坏本地选歌这条路）
  navigate('reLaunch', '/pages/index/index')
  await waitStack('/pages/index/index', 10000)
  await injectLocalSong()
  ev(`function(){ require('services/billing.js').consume = async function(){ return { ok: true, mocked: true } }; return 'ok' }`)
  navigate('navigateTo', '/pages/pitch/index')
  await waitStack('/pages/pitch/index', 10000)
  await assertPitchGate('本地歌', true)
  fire('onNext')
  await waitStack('/pages/unlock/index', 10000)
  console.log('    解锁页 | 档位 ' + pageData('selected') + ' | 计费 ' + JSON.stringify(pageData('billing')))
  fire('onConfirm')
  await waitStack('/pages/process/index', 15000)
  const ms = await waitStack('/pages/result/index', 120000)
  const rd = pageData(null)
  const file = ev(`function(){ var r = require('services/session.js').getLastResult(); var st = wx.getFileSystemManager().statSync(r.path); return { size: st.size, name: r.fileName } }`)
  console.log('    处理完成 | 结果文件 ' + file.name + ' ' + (file.size / 1048576).toFixed(2) + 'MB')
  void ms
  if (Math.abs(file.size - rd.result.bytes) > 4096) throw new Error('结果文件大小与页面显示不符: ' + file.size + ' vs ' + rd.result.bytes)
  if (rd.imported) throw new Error('本地选的歌不该出现「发原曲」')
})

def('门禁·确认不了的歌不给出下一步', async () => {
  // 直接往会话里塞一首「确认不了」的歌:路径指向不存在的地方
  navigate('reLaunch', '/pages/index/index')
  await waitStack('/pages/index/index', 10000)
  ev(`function(){ const session = require('services/session.js')
    session.setSong({ path: '/nonexistent/broken.mp3', name: '坏文件测试', size: 12345, format: 'mp3', token: 'nope', frames: 0, sampleRate: 44100, channels: 2, durationSec: 200 })
    wx.navigateTo({ url: '/pages/pitch/index' }) }`)
  await waitStack('/pages/pitch/index', 10000)
  const g = await assertPitchGate('坏文件', false)
  callMethod('onNext')       // 硬点「下一步」也不该跳走
  callMethod('onPlayToggle') // 播放也不该响应
  await sleep(1500)
  const s = stack()
  if (s[s.length - 1] !== '/pages/pitch/index') throw new Error('没确认通过却进了下一页: ' + s.join(' > '))
  console.log('    打不开原因 | ' + g.verifyText)
})

def('门禁·试听发现解不了就收回下一步,重新检查通过再放出', async () => {
  navigate('reLaunch', '/pages/index/index')
  await waitStack('/pages/index/index', 10000)
  await injectLocalSong()
  navigate('navigateTo', '/pages/pitch/index')
  await waitStack('/pages/pitch/index', 10000)
  await assertPitchGate('本地歌', true)
  // 模拟试听时解码器报错（真要造一个「只在试听时才崩」的文件太脆,这里直接调用页面的收回逻辑）
  callMethod('revokeVerify', ['这个文件打不开，可能已经损坏'])
  await waitData('verifyState', v => v === 'failed', 5000)
  if (has('.btn-primary')) throw new Error('收回后不该还有「下一步」')
  callMethod('onNext')
  await sleep(1000)
  if (stack()[stack().length - 1] !== '/pages/pitch/index') throw new Error('收回后硬点下一步不该跳走')
  callMethod('onReverify')
  await assertPitchGate('重新检查', true)
})

;(async () => {
  armModalCapture()
  const names = Object.keys(CASES).filter(n => !FILTER || n.indexOf(FILTER) >= 0)
  let pass = 0
  let fail = 0
  for (const name of names) {
    console.log('▸ ' + name)
    try {
      await CASES[name]()
      pass++
      console.log('  ✓ ' + name)
    } catch (e) {
      fail++
      console.log('  ✗ ' + name + '\n      ' + String(e && e.message || e).split('\n').join('\n      '))
    }
  }
  console.log('\n' + pass + ' 过 / ' + fail + ' 败')
  process.exit(fail ? 1 : 0)
})()
