// 带歌全流程验证：注入 3 分钟虚拟歌曲 → 变调页渲染 → 下一步 → 解锁页渲染
// 复现真机场景（setData 大数组白屏的回归测试）
// 前提: cli auto 已启动且模拟器在运行

const cmpPath = require.resolve('licia/cmpVersion')
const origCmp = require(cmpPath)
require.cache[cmpPath].exports = (a, b) => (typeof a !== 'string' ? 0 : origCmp(a, b))

const automator = require('miniprogram-automator')
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const mp = await automator.connect({ wsEndpoint: 'ws://localhost:9420', timeout: 30000 })
  console.log('=== 已连接 ===')

  const errors = []
  mp.on('console', m => {
    if (m.type === 'error') { try { errors.push(JSON.stringify(m).slice(0, 400)) } catch (e) { errors.push(String(m)) } }
  })

  // 1) 注入 3 分钟虚拟歌曲（PCM 大小与真实歌曲相当：44100*180 ≈ 794 万个采样点/声道）
  const inject = await mp.evaluate(() => {
    try {
      const session = require('services/session.js')
      const sr = 44100, n = sr * 180 // 3 分钟
      // 快速铺砖法：440Hz × 1s = 整 440 周期，1 秒块首尾相位连续，拼 180 次即完美正弦
      // （逐点 Math.sin 794 万次在模拟器里要 26s+，会撞 IDE 自动化服务器 10s 消息超时）
      const sec = new Float32Array(sr)
      for (let i = 0; i < sr; i++) sec[i] = 0.5 * Math.sin(2 * Math.PI * 440 * i / sr)
      const pcmL = new Float32Array(n)
      for (let k = 0; k < 180; k++) pcmL.set(sec, k * sr)
      const pcmR = new Float32Array(pcmL)
      session.setSong({
        path: '/tmp/fake.wav', name: '测试歌（3分钟）.wav',
        durationSec: 180, sampleRate: sr, channels: 2, length: n,
        pcmL, pcmR,
      })
      session.setSemitones(2)
      return { ok: true }
    } catch (e) { return { ok: false, msg: String(e.message || e) } }
  })
  console.log('注入虚拟歌曲:', JSON.stringify(inject))
  if (!inject.ok) { await mp.disconnect(); return }

  // 2) 进变调页，验证渲染（关键回归点：页面必须真的停留在 pitch 且 WXML 有内容）
  await mp.reLaunch('/pages/pitch/index')
  await sleep(2000)
  let page = await mp.currentPage()
  console.log('当前页面:', page.path, page.path === 'pages/pitch/index' ? '✅ 停住了' : '❌ 被弹走')

  if (page.path === 'pages/pitch/index') {
    const name = await page.$('.file-name')
    const nameText = name ? await name.text() : '<没找到 .file-name>'
    const stat = await page.$('.pitch-num')
    const statText = stat ? await stat.text() : '<没找到 .pitch-num>'
    console.log('文件名渲染:', nameText)
    console.log('调级显示:', statText)
    await mp.screenshot({ path: __dirname + '/shots/pitch-with-song.png' })
    console.log('截图: shots/pitch-with-song.png')

    // 3) 点「下一步」进解锁页（automator 的 tap 在重编译后不可靠，直接调页面方法）
    const nextBtn = await page.$('.btn-primary')
    if (nextBtn) {
      await page.callMethod('onNext')
      // 高频轮询页面栈 3 秒，看 unlock 是否 push 后又被弹
      for (let i = 0; i < 15; i++) {
        await sleep(200)
        const stack = await mp.pageStack()
        if (i % 5 === 4 || stack.length > 1) {
          console.log(`  t+${(i + 1) * 200}ms 栈:`, JSON.stringify(stack.map(p => p.path)))
        }
      }
      // 若弹回首页，查 session 状态定位原因
      const topPage = (await mp.currentPage()).path
      if (topPage !== 'pages/unlock/index') {
        const sess = await mp.evaluate(() => {
          const session = require('services/session.js')
          const s = session.getSong()
          return { hasSong: !!s, semitones: session.getSemitones() }
        })
        console.log('  弹回后 session 状态:', JSON.stringify(sess))
      }
      page = await mp.currentPage()
      console.log('点下一步后:', page.path, page.path === 'pages/unlock/index' ? '✅' : '❌')
      if (page.path === 'pages/unlock/index') {
        const v = await page.$('.v')
        console.log('解锁页音乐名:', v ? await v.text() : '<没找到>')
        await mp.screenshot({ path: __dirname + '/shots/unlock-with-song.png' })
        console.log('截图: shots/unlock-with-song.png')
      }
    } else {
      console.log('❌ 没找到下一步按钮')
    }
  }

  console.log('\n=== 汇总 ===')
  if (errors.length) { console.log(`${errors.length} 条 console.error:`); errors.forEach(e => console.log('  ' + e)) }
  else console.log('无 console.error ✅')

  await mp.disconnect()
  console.log('=== DONE ===')
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1) })
