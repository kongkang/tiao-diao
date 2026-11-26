// 带歌全流程验证：注入 3 分钟测试歌 → 变调页渲染 → 解码确认 → 下一步 → 解锁页渲染
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

  // 1) 注入 3 分钟测试歌（真实的 WAV → Worker 解码会话）
  //    选调页现在要先确认这首歌解得出声音才放出「下一步」，
  //    早期那套「PCM 数组直塞 session、路径不存在」的假歌过不了这一关
  const injectSong = require('./inject-song.js')
  const waitVerified = require('./lib/wait-verified.js')
  await injectSong(mp, 180, '测试歌（3分钟）.wav')

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
    await waitVerified(page)   // 解码确认通过后才有「下一步」
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
