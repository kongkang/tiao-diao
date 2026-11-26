#!/usr/bin/env node
/**
 * 云端提取的 IO 编排回归(不需要开发者工具):mediahttp + slicer + fmp4slice
 *
 * 起一个本地 HTTP 服务模拟 CDN(支持 Range;可限速 / 可模拟「不支持断点」/ 可模拟跳转),
 * 用真实的出网读代码把计划里的字节一段段拉下来拼成成品,再用自带解码器开一遍。
 *
 * 可选环境变量:
 *   TD_REAL_SAMPLES=<目录>  有 dy.mp4 / sph.mp4(抖音、视频号)和 bili.m4a(B站音频流)时一并测。
 *                            B站那种「ftyp/free/moov/sidx/moof…」+ 假 sidx 的布局只有真实样本才有。
 *
 * 运行:node tools/autotest/test-media-slicer.js
 */
const assert = require('assert')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const { execFileSync, spawnSync } = require('child_process')

const ROOT = path.resolve(__dirname, '../..')
const FN = path.join(ROOT, 'cloudfunctions/fetchMedia')
const mediahttp = require(path.join(FN, 'mediahttp.js'))
const slicer = require(path.join(FN, 'slicer.js'))
const fmp4 = require(path.join(FN, 'fmp4slice.js'))
const box = require(path.join(FN, 'mp4box.js'))
const ff = require('./lib/ffdecode-node')

const tests = []
function test(name, fn) { tests.push({ name, fn }) }
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ---------- 本地 CDN ----------
/** 起一个模拟 CDN:支持 Range;o.bytesPerSec 全局限速;o.noRange 不理 Range;o.redirect 先 302 一次 */
function startServer(dir, opts) {
  const o = opts || {}
  const stats = { requests: 0, bytes: 0 }
  const bucket = { bytes: 0, t0: Date.now() }   // 全局限速用的令桶(所有响应共用)
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(req.url.replace(/^\/f\//, '').split('?')[0])
    if (o.redirect && !/[?&]r=1/.test(req.url)) {
      res.writeHead(302, { Location: '/f/' + encodeURIComponent(name) + '?r=1' })
      return res.end()
    }
    const file = path.join(dir, name)
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end() }
    const total = fs.statSync(file).size
    const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '')
    stats.requests++
    if (!m || o.noRange) {                   // 不理 Range:从头整发
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': total })
      return send(res, file, 0, total - 1)
    }
    const a = parseInt(m[1], 10)
    const b = Math.min(m[2] ? parseInt(m[2], 10) : total - 1, total - 1)
    if (a >= total) { res.writeHead(416); return res.end() }
    res.writeHead(206, { 'Content-Type': 'application/octet-stream', 'Content-Range': 'bytes ' + a + '-' + b + '/' + total, 'Content-Length': b - a + 1 })
    return send(res, file, a, b)
  })
  function send(res, file, start, end) {
    const src = fs.createReadStream(file, { start, end })
    if (!o.bytesPerSec) {
      src.on('data', c => { stats.bytes += c.length })
      return src.pipe(res)
    }
    const slow = new (require('stream').Transform)({
      transform(chunk, enc, cb) {
        bucket.bytes += chunk.length
        stats.bytes += chunk.length
        const allowed = ((Date.now() - bucket.t0) / 1000) * o.bytesPerSec
        setTimeout(() => cb(null, chunk), Math.max(0, (bucket.bytes - allowed) / o.bytesPerSec * 1000))
      },
    })
    src.pipe(slow).pipe(res)
  }
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const base = 'http://127.0.0.1:' + server.address().port + '/f/'
      resolve({ url: name => base + encodeURIComponent(name), stats, close: () => new Promise(r => server.close(r)) })
    })
  })
}

// ---------- 工具 ----------
function makeIo(url, budgetMs) {
  const dl = () => Date.now() + budgetMs
  return {
    read: async (s, e) => {
      const r = await mediahttp.readRange(url, {}, s, e, dl())
      if (!r.complete) throw new mediahttp.HttpError('short read', 'deadline')
      return r.buf
    },
    readSpan: (s, e) => mediahttp.readSpan(url, {}, s, e, dl()),
  }
}

async function fileSizeOf(url) {
  const r = await mediahttp.readRange(url, {}, 0, 1, Date.now() + 5000)
  return r.size
}

/** 像云函数那样一段段拉,直到拉完 */
async function fetchAll(plan, io, chunkBytes, budgetMs) {
  const parts = []
  let offset = 0
  let calls = 0
  let empty = 0
  while (offset < plan.totalBytes && calls < 2000) {
    const r = await slicer.readPlanChunk(plan, io, offset, chunkBytes, Date.now() + budgetMs)
    calls++
    if (!r.buf.length) {
      if (++empty > 50) throw new Error('一直没有进展,卡在 ' + offset)
      await sleep(10)
      continue
    }
    empty = 0
    parts.push(r.buf)
    offset = r.nextOffset
  }
  return { buf: Buffer.concat(parts), calls }
}

async function buildPlan(url, slice, durationSec) {
  const fileSize = await fileSizeOf(url)
  const io = makeIo(url, 20000)
  const plan = await slicer.buildSource({ read: io.read, fileSize, slice, durationSec })
  return { plan, io, fileSize }
}

function ffprobeAudio(file) {
  const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', file], { maxBuffer: 1 << 24 }).toString())
  return info.streams
}

/** 自带解码器:能开、能从头解到尾、能在中间和结尾定位 */
function wasmCheck(buf, expectSec, label, toleranceSec) {
  const h = ff.open(buf)
  const pcm = ff.decodeAll()
  const decodedSec = pcm.length / 2 / h.rate
  assert(Math.abs(decodedSec - expectSec) < (toleranceSec || 0.3), label + ' 解出的时长 ' + decodedSec.toFixed(2) + 's ≠ 期望 ' + expectSec.toFixed(2) + 's')
  let peak = 0
  for (let i = 0; i < pcm.length; i += 97) { const a = Math.abs(pcm[i]); if (a > peak) peak = a }
  assert(peak > 1e-3, label + ' 解出来是静音')
  for (const t of [0.5, decodedSec / 2, Math.max(0, decodedSec - 1)]) {
    ff.reopen(h)
    assert.strictEqual(ff.seek(t), 0, label + ' seek ' + t + ' 失败')
    const r = ff.pullSec(0.25)
    assert(r.frames > 0 && r.peak > 1e-4, label + ' seek ' + t + ' 后没解出声音')
    const at = ff.tell()
    assert(at >= t - 0.05 && at <= t + 1.2, label + ' seek ' + t + ' 落在 ' + at)
  }
  ff.close(h)
  return { rate: h.rate, dur: h.dur, decodedSec }
}

function topBoxes(buf) {
  const out = []
  let p = 0
  while (p + 8 <= buf.length) {
    const h = box.boxHeader(buf, p)
    assert(h, '坏 box 头 @' + p)
    const size = h.size === 0 ? buf.length - p : h.size
    out.push(h.type)
    p += size
  }
  return out
}

// ---------- 用例 ----------
async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-slicer-'))
  if (process.env.TD_REAL_SAMPLES) {
    for (const n of ['dy.mp4', 'sph.mp4', 'bili.m4a']) {
      const p = path.join(process.env.TD_REAL_SAMPLES, n)
      if (fs.existsSync(p)) fs.copyFileSync(p, path.join(dir, n))
    }
  }
  const gen = (name, ...parts) => {
    execFileSync('ffmpeg', ['-v', 'error', '-y'].concat([].concat(...parts), [path.join(dir, name)]))
  }
  const sine = (sr, d) => ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=' + sr + ':duration=' + d]
  const video = d => ['-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=5:duration=' + d]
  // 2 秒一个分片(不带 -frag_duration 的话纯音频只有视频关键帧才切,整个文件就一个大分片)
  gen('frag.mp4', sine(48000, 60), ['-c:a', 'aac', '-ac', '2', '-movflags', '+dash+empty_moov+default_base_moof', '-frag_duration', '2000000'])
  gen('nofast.mp4', video(20), sine(44100, 20), ['-map', '0:v', '-map', '1:a', '-c:v', 'mpeg4', '-c:a', 'aac', '-ac', '2'])
  gen('plain.mp3', sine(44100, 30), ['-c:a', 'libmp3lame', '-b:a', '96k'])
  await ff.load()

  const cdn = await startServer(dir)
  const realMissing = []
  const t = (name, file, fn) => {
    if (!fs.existsSync(path.join(dir, file))) { realMissing.push(name); return }   // 没有真实样本:跳过
    test(name, async () => fn(cdn.url(file)))
  }

  // —— 渐进式 mp4:只取音轨 ——
  t('抖音真实样本 · 整段只取音轨', 'dy.mp4', async url => {
    const src = fs.readFileSync(path.join(dir, 'dy.mp4'))
    const { plan } = await buildPlan(url, { startSec: 0, maxSec: 0 }, 15)
    assert.strictEqual(plan.kind, 'mp4')
    const { buf, calls } = await fetchAll(plan, makeIo(url, 20000), 1536 * 1024, 20000)
    assert.strictEqual(buf.length, plan.totalBytes)
    assert.strictEqual(calls, 1, '这么小的成品应该一次就拿完')
    // 拼出来的字节 = 文件头 + 源文件里对应的段
    const want = Buffer.concat([plan.header].concat(plan.pieces.map(p => src.subarray(p.src, p.src + p.len))))
    assert(buf.equals(want), '拼出来的字节和计划对不上')
    assert(buf.length < src.length / 5, '只留音轨后应不到原文件的 1/5')
    wasmCheck(buf, plan.durationSec, 'dy-full')
  })
  t('抖音真实样本 · 切 3~9 秒', 'dy.mp4', async url => {
    const { plan } = await buildPlan(url, { startSec: 3, maxSec: 6 }, 15)
    assert.strictEqual(plan.mode, 'slice')
    const { buf } = await fetchAll(plan, makeIo(url, 20000), 1536 * 1024, 20000)
    wasmCheck(buf, plan.durationSec, 'dy-3~9')
  })
  t('视频号真实样本 · 整段只取音轨', 'sph.mp4', async url => {
    const { plan } = await buildPlan(url, { startSec: 0, maxSec: 0 }, 0)
    const { buf } = await fetchAll(plan, makeIo(url, 20000), 1536 * 1024, 20000)
    assert.strictEqual(plan.kind, 'mp4')
    wasmCheck(buf, plan.durationSec, 'sph-full')
  })

  // —— 分片式(B站音频流)——
  t('B站真实样本 · 整段放得下 → 直传', 'bili.m4a', async url => {
    const fileSize = await fileSizeOf(url)
    const plan = await slicer.buildSource({ read: makeIo(url, 20000).read, fileSize, slice: { startSec: 0, maxSec: 0 }, durationSec: 213 })
    assert.strictEqual(plan, null, '不需要切时应返回 null(调用方走整文件直传)')
    const plain = slicer.plainPlan(fileSize, { durationSec: 213 })
    const { buf } = await fetchAll(plain, makeIo(url, 20000), 1536 * 1024, 20000)
    assert(buf.equals(fs.readFileSync(path.join(dir, 'bili.m4a'))), '直传应是原样')
    wasmCheck(buf, 212.3, 'bili-whole')
  })
  for (const [start, max] of [[0, 100], [60, 100], [150, 100]]) {
    t('B站真实样本 · 截 ' + start + '~' + (start + max) + ' 秒', 'bili.m4a', async url => {
      const { plan } = await buildPlan(url, { startSec: start, maxSec: max }, 213)
      assert.strictEqual(plan.kind, 'fmp4')
      assert(!topBoxes(plan.header).includes('sidx'), 'sidx 应去掉')
      assert(plan.startSec <= start + 0.01 && start - plan.startSec < 6, '截取起点应对齐到分片: ' + plan.startSec)
      const { buf } = await fetchAll(plan, makeIo(url, 20000), 1536 * 1024, 20000)
      const src = fs.readFileSync(path.join(dir, 'bili.m4a'))
      const piece = plan.pieces[0]
      assert(buf.equals(Buffer.concat([plan.header, src.subarray(piece.src, piece.src + piece.len)])))
      // 截到文件尾时没有「结束分片」可对齐,计划时长按接口给的整体时长(整秒)推算,
      // 会比真实结尾多不到 1 秒 —— 真实时长由小程序端的解码自检实测
      const toEnd = start + max >= 213
      const got = wasmCheck(buf, toEnd ? plan.durationSec - 0.7 : plan.durationSec, 'bili-' + start, toEnd ? 1.5 : 0.3)
      if (start === 0) assert(Math.abs(got.dur - plan.durationSec) < 0.1, '前缀截取的容器时长应准确')
      // 从中段截:首片 tfdt 不是 0,容器会把时长报成绝对结束时间(自带解码器实测如此),
      // 由小程序端的解码自检按「实际能解到哪」修正 —— 这里只确认解出来的长度是对的
      else assert(Math.abs(got.dur - (plan.startSec + plan.durationSec)) < (toEnd ? 1.0 : 0.1), '中段截取的容器时长 = 绝对结束时间')
    })
  }
  t('ffmpeg 生成的分片流 · 截 10~40 秒', 'frag.mp4', async url => {
    const { plan } = await buildPlan(url, { startSec: 10, maxSec: 30 }, 60)
    assert.strictEqual(plan.kind, 'fmp4')
    const { buf } = await fetchAll(plan, makeIo(url, 20000), 1536 * 1024, 20000)
    wasmCheck(buf, plan.durationSec, 'frag-10~40')
  })

  // —— 其他形态 ——
  t('非快启动(moov 在文件尾)· 也能只取音轨', 'nofast.mp4', async url => {
    const { plan } = await buildPlan(url, { startSec: 0, maxSec: 0 }, 20)
    assert.strictEqual(plan.kind, 'mp4')
    const { buf } = await fetchAll(plan, makeIo(url, 20000), 1536 * 1024, 20000)
    assert.strictEqual(ffprobeAudio(writeTmp(dir, buf)).length, 1)
    wasmCheck(buf, plan.durationSec, 'nofast')
  })
  t('纯 mp3 · 整文件直传', 'plain.mp3', async url => {
    const fileSize = await fileSizeOf(url)
    const plan = await slicer.buildSource({ read: makeIo(url, 20000).read, fileSize, slice: { startSec: 0, maxSec: 0 }, durationSec: 30 })
    assert.strictEqual(plan, null)
    const plain = slicer.plainPlan(fileSize, {})
    const { buf } = await fetchAll(plain, makeIo(url, 20000), 1536 * 1024, 20000)
    assert(buf.equals(fs.readFileSync(path.join(dir, 'plain.mp3'))))
  })
  t('纯 mp3 · 给了时长上限也不切(不是 mp4,只能整传)', 'plain.mp3', async url => {
    const fileSize = await fileSizeOf(url)
    const plan = await slicer.buildSource({ read: makeIo(url, 20000).read, fileSize, slice: { startSec: 0, maxSec: 5 }, durationSec: 30 })
    assert.strictEqual(plan, null)
  })

  // —— 网络状况 ——
  t('慢速源(1MB/s)· 预算内读不完就返回前缀,多次续传后拼完整', 'bili.m4a', async () => {
    const slow = await startServer(dir, { bytesPerSec: 1.2 * 1024 * 1024 })
    try {
      const url = slow.url('bili.m4a')
      const fileSize = await fileSizeOf(url)
      const plan = slicer.plainPlan(fileSize, {})
      const io = makeIo(url, 400)                      // 每次调用只有 400ms 预算
      const parts = []
      let offset = 0
      let calls = 0
      let shrunk = false
      while (offset < plan.totalBytes && calls < 500) {
        const r = await slicer.readPlanChunk(plan, io, offset, 1536 * 1024, Date.now() + 400)
        calls++
        if (r.buf.length < 1536 * 1024 && offset + r.buf.length < plan.totalBytes) shrunk = true
        parts.push(r.buf)
        offset = r.nextOffset
      }
      assert.strictEqual(offset, plan.totalBytes, '应最终拼完整')
      assert(shrunk, '预算内读不完时应有没拿满的块')
      assert(Buffer.concat(parts).equals(fs.readFileSync(path.join(dir, 'bili.m4a'))), '续传拼出来应与原文件一致')
    } finally {
      await slow.close()
    }
  })
  t('慢速源 · 渐进式只取音轨也能分段推进', 'dy.mp4', async () => {
    const slow = await startServer(dir, { bytesPerSec: 1.5 * 1024 * 1024 })
    try {
      const url = slow.url('dy.mp4')
      const fileSize = await fileSizeOf(url)
      const io = makeIo(url, 300)
      const plan = await slicer.buildSource({ read: io.read, fileSize, slice: { startSec: 0, maxSec: 0 }, durationSec: 15 })
      const { buf, calls } = await fetchAll(plan, io, 1536 * 1024, 300)
      assert.strictEqual(buf.length, plan.totalBytes)
      assert(calls > 1, '慢速源应分多次拿')
      wasmCheck(buf, plan.durationSec, 'dy-slow')
    } finally {
      await slow.close()
    }
  })
  t('服务器不支持断点 · 明确报错而不是返回错数据', 'plain.mp3', async () => {
    const nr = await startServer(dir, { noRange: true })
    try {
      await assert.rejects(mediahttp.readRange(nr.url('plain.mp3'), {}, 100, 200, Date.now() + 5000), e => e.code === 'norange')
      const head = await mediahttp.readRange(nr.url('plain.mp3'), {}, 0, 1000, Date.now() + 5000)
      assert(head.complete && head.buf.length === 1000, '从 0 读应照常成功')
    } finally {
      await nr.close()
    }
  })
  t('跟随跳转', 'plain.mp3', async () => {
    const rd = await startServer(dir, { redirect: true })
    try {
      const r = await mediahttp.readRange(rd.url('plain.mp3'), {}, 10, 20, Date.now() + 5000)
      assert(r.complete && r.buf.equals(fs.readFileSync(path.join(dir, 'plain.mp3')).subarray(10, 20)))
    } finally {
      await rd.close()
    }
  })
  t('预算截止:一个字节都没读到时抛 deadline', 'plain.mp3', async () => {
    await assert.rejects(mediahttp.readRange(cdn.url('plain.mp3'), {}, 0, 400000, Date.now() - 1), e => e.code === 'deadline')
  })
  t('416(越界)· 抛 status416', 'plain.mp3', async () => {
    await assert.rejects(mediahttp.readRange(cdn.url('plain.mp3'), {}, 1 << 30, (1 << 30) + 10, Date.now() + 5000), e => e.code === 'status416')
  })
  t('并行分段读:每一路的字节都要对上', 'bili.m4a', async url => {
    const src = fs.readFileSync(path.join(dir, 'bili.m4a'))
    const r = await mediahttp.readSpan(url, {}, 1000, 1000 + 5 * 1024 * 1024, Date.now() + 20000)
    assert(r.complete && r.buf.equals(src.subarray(1000, 1000 + 5 * 1024 * 1024)))
    assert.strictEqual(r.size, src.length)
  })
  t('fmp4 边界查找:窗口落在分片中间也能接上', 'bili.m4a', async url => {
    const io = makeIo(url, 20000)
    const fileSize = await fileSizeOf(url)
    // 先拿到前几个分片的真实位置
    const head = await io.read(1482, 1482 + 1024 * 1024)
    const frags = fmp4.walkFragments(head, 1482)
    assert(frags.length >= 5, '应识别出多个分片')
    for (let i = 1; i < frags.length; i++) assert.strictEqual(frags[i].pos, frags[i - 1].end, '分片应首尾相接')
    // 从某个分片中间开始读窗口
    const mid = frags[2].pos + 30000
    const win = await io.read(mid, mid + 800 * 1024)
    const again = fmp4.walkFragments(win, mid)
    assert(again.length >= 3 && again[0].pos === frags[3].pos, '应从下一个完整分片接上')
    const unit = fmp4.unitSeconds(again, (fileSize - 1482) / 213, 48000, 1000)
    assert(Math.abs(unit - 1 / 48000) < 1e-9, 'tfdt 单位应判定为轨时基 1/48000,实际 ' + unit)
  })

  let pass = 0
  let fail = 0
  for (const tc of tests) {
    try {
      await tc.fn()
      pass++
      console.log('  ✓ ' + tc.name)
    } catch (e) {
      fail++
      console.log('  ✗ ' + tc.name + '\n      ' + String(e && e.message || e).split('\n').join('\n      '))
    }
  }
  await cdn.close()
  console.log('\n' + pass + ' 过 / ' + fail + ' 败 / ' + realMissing.length + ' 跳过(需要真实样本:设 TD_REAL_SAMPLES 指向含 dy.mp4 / sph.mp4 / bili.m4a 的目录)   (临时目录 ' + dir + ')')
  process.exit(fail ? 1 : 0)
}

function writeTmp(dir, buf) {
  const p = path.join(dir, 'tmp-' + Math.random().toString(36).slice(2, 8) + '.m4a')
  fs.writeFileSync(p, buf)
  return p
}

main().catch(e => { console.error(e); process.exit(1) })
