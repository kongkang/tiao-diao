#!/usr/bin/env node
/**
 * 长音频全链路（模拟器）：10 分钟 MP3（超过旧 8 分钟上限）
 *
 * 本地 HTTP 服务器提供 /tmp/td-worker-test/long.mp3 → 模拟器 downloadFile →
 * engine.analyzeFile 分块上传 → 变调页跳到 8:00 试听 → process 页流式处理 →
 * result 页 → 校验结果文件大小。
 *
 * 运行：NODE_PATH=... node tools/autotest/test-long-stream.js
 */
const fs = require('fs')
const http = require('http')
const path = require('path')
const cmpPath = require.resolve('licia/cmpVersion')
const origCmp = require(cmpPath)
require.cache[cmpPath].exports = (a, b) => (typeof a !== 'string' ? 0 : origCmp(a, b))

const automator = require('miniprogram-automator')
const sleep = ms => new Promise(r => setTimeout(r, ms))

const FILE = '/tmp/td-worker-test/long.mp3'
const PORT = 18765

function startServer() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      const p = path.join('/tmp/td-worker-test', decodeURIComponent(req.url.split('?')[0]))
      fs.stat(p, (err, st) => {
        if (err || !st.isFile()) { res.statusCode = 404; return res.end('not found') }
        res.setHeader('Content-Type', 'audio/mpeg')
        res.setHeader('Content-Length', st.size)
        fs.createReadStream(p).pipe(res)
      })
    })
    srv.once('error', reject)
    srv.listen(PORT, '127.0.0.1', () => resolve(srv))
  })
}

async function main() {
  if (!fs.existsSync(FILE)) throw new Error('缺少测试文件 ' + FILE)
  const size = fs.statSync(FILE).size
  const srv = await startServer()
  console.log('本地文件服务 http://127.0.0.1:' + PORT + '/long.mp3 (' + (size / 1048576).toFixed(1) + 'MB)')

  const mp = await automator.connect({ wsEndpoint: 'ws://localhost:9420', timeout: 30000 })
  console.log('=== 已连接 ===')

  // 1) 下载 + analyzeFile（走 readFile(position,length) 分块）
  const info = await mp.evaluate((url, size) => new Promise((resolve, reject) => {
    wx.downloadFile({
      url,
      success(res) {
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode))
        const engine = require('services/engine.js')
        const session = require('services/session.js')
        const audio = require('services/audio.js')
        try { audio.setPreviewMuted(true) } catch (e) {}
        engine.analyzeFile(res.tempFilePath, size).then(meta => {
          session.setSong({
            path: res.tempFilePath,
            name: '长音频测试.mp3',
            size,
            format: 'mp3',
            token: meta.token,
            frames: meta.frames,
            sampleRate: meta.sampleRate,
            channels: meta.channels,
            durationSec: meta.durationSec,
          })
          resolve({ ok: true, meta, path: res.tempFilePath })
        }).catch(e => reject(new Error((e && e.message) || String(e))))
      },
      fail(e) { reject(new Error((e && e.errMsg) || 'downloadFile fail')) },
    })
  }), 'http://127.0.0.1:' + PORT + '/long.mp3', size)
  console.log('analyze 完成:', JSON.stringify(info.meta))
  if (Math.abs(info.meta.durationSec - 600) > 3) throw new Error('时长不对: ' + info.meta.durationSec)

  // 2) 变调页跳到 8:00 试听（旧 wasm 会从 0 顺序解码丢弃；新 wasm 直接 seek）
  await mp.navigateTo('/pages/pitch/index')
  await sleep(1500)
  let page = await mp.currentPage()
  if (page.path !== 'pages/pitch/index') throw new Error('没到变调页: ' + page.path)
  await page.setData({ previewStart: 480 })
  await page.callMethod('onPlayToggle')

  const t0 = Date.now()
  let playing = false
  while (Date.now() - t0 < 180000) {
    await sleep(2000)
    page = await mp.currentPage()
    if (page.path !== 'pages/pitch/index') break
    const d = await page.data()
    process.stdout.write('\r  试听准备 ' + (d.playState || '') + '  ' + (d.statusText || '') + '   ')
    if (d.playState === 'playing') { playing = true; break }
  }
  console.log('')
  if (!playing) throw new Error('8:00 试听未开始（可能解码失败）')
  console.log('8:00 试听已开始，耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's（wasm ff_seek 直接定位）')

  await mp.evaluate(() => { require('services/audio.js').stopPreview() })
  await sleep(500)

  // 3) 直接进处理页（绕过解锁；长文件在真实流程里走额度/包月）
  await mp.evaluate(() => {
    const session = require('services/session.js')
    const config = require('config.js')
    // 开发者工具模拟器本地文件配额约 10MB（真机 200MB）；测试临时把输出压到 6MB
    config.MAX_OUTPUT_MB = 6
    try { wx.getFileSystemManager().unlink({ filePath: wx.env.USER_DATA_PATH + '/w1.bin', complete() {} }) } catch (e) {}
    session.setUnlockMode('free')
    session.setSemitones(2)
  })
  await mp.navigateTo('/pages/process/index')
  await sleep(1500)
  page = await mp.currentPage()
  if (page.path !== 'pages/process/index') throw new Error('没到处理页: ' + page.path)

  const t1 = Date.now()
  let reached = false
  while (Date.now() - t1 < 600000) {
    await sleep(3000)
    page = await mp.currentPage()
    if (page.path === 'pages/process/index') {
      const d = await page.data()
      process.stdout.write('\r  处理中 ' + (d.indeterminate ? '…' : (d.percent || 0) + '%') + '   ')
    } else if (page.path === 'pages/result/index') {
      reached = true
      break
    } else {
      throw new Error('意外页面: ' + page.path)
    }
  }
  console.log('')
  if (!reached) throw new Error('超时未到结果页')
  console.log('✅ 10 分钟文件处理完成，耗时 ' + ((Date.now() - t1) / 1000).toFixed(1) + 's')

  const check = await mp.evaluate(() => new Promise(resolve => {
    const session = require('services/session.js')
    const r = session.getLastResult()
    if (!r || !r.path) return resolve({ ok: false, msg: 'lastResult 为空' })
    wx.getFileSystemManager().stat({
      path: r.path,
      success: s => resolve({ ok: true, fileName: r.fileName, size: (s.stats && s.stats.size) || s.size }),
      fail: e => resolve({ ok: false, msg: '文件不存在: ' + (e.errMsg || '') }),
    })
  }))
  console.log('结果文件:', JSON.stringify(check))
  if (!check.ok) throw new Error(check.msg)
  console.log('大小 ' + (check.size / 1048576).toFixed(1) + 'MB（测试上限 6MB 下自动选 80kbps，理论约 6.0MB）')
  if (check.size < 3 * 1048576) throw new Error('结果文件偏小: ' + check.size)

  await mp.evaluate(() => { require('config.js').MAX_OUTPUT_MB = 95 })
  await mp.disconnect()
  srv.close()
  console.log('=== DONE ===')
}

main().catch(async e => {
  console.error('FATAL:', e && e.message)
  process.exit(1)
})
