#!/usr/bin/env node
/**
 * 攒批写文件(filewriter)回归(不需要开发者工具)
 *
 * 用一个假的文件系统验证:落盘字节与喂进去的一致、追加次数少、超限/写失败/作废/续传都对。
 * 其中「平方计数配额」一项把开发者工具模拟器实测到的规则模拟出来
 * (每 append 一次配额加上「追加后整个文件的大小」,上限 200MB),证明攒批写能扛住。
 *
 * 运行:node tools/autotest/test-filewriter.js
 */
const assert = require('assert')
const path = require('path')
const { createWriter, FIRST_FLUSH_BYTES, MAX_FLUSH_BYTES } = require(path.resolve(__dirname, '../../miniprogram/services/filewriter.js'))

const MB = 1024 * 1024
const LIMIT = 200 * MB

/** 假文件系统:记录每次写/追加;o.failAt 第几次写时失败;o.quadratic 按平方计数扣配额 */
function fakeFs(o) {
  const opt = o || {}
  const files = new Map()   // path → Buffer
  const log = []            // {op, path, bytes}
  let quota = 0
  let writes = 0
  const size = p => (files.get(p) || Buffer.alloc(0)).length
  const run = (kind, args) => {
    const { filePath, data } = args
    const bytes = Buffer.from(data)
    if (opt.failAt === writes + 1) {
      writes++
      log.push({ op: kind, path: filePath, bytes: bytes.length, failed: true })
      return args.fail({ errMsg: 'writeFile:fail mock' })
    }
    if (opt.quadratic) {
      quota += size(filePath) + bytes.length   // 模拟器实测的算法:按「追加后的整个文件大小」累加
      if (quota > LIMIT) return args.fail({ errMsg: kind + ':fail the maximum size of the file storage limit is exceeded' })
    }
    writes++
    files.set(filePath, kind === 'writeFile' ? bytes : Buffer.concat([files.get(filePath) || Buffer.alloc(0), bytes]))
    log.push({ op: kind, path: filePath, bytes: bytes.length })
    args.success()
  }
  return {
    writeFile: args => run('writeFile', args),
    appendFile: args => run('appendFile', args),
    unlink: args => { files.delete(args.filePath); log.push({ op: 'unlink', path: args.filePath }); args.complete() },
    files, log,
    content: p => files.get(p) || Buffer.alloc(0),
    writes: () => writes,
  }
}

/** 造一段带序号的数据(每个字节 = (序号 % 251),方便校验顺序) */
function chunk(seq, start, len) {
  const u = new Uint8Array(len)
  for (let i = 0; i < len; i++) u[i] = (start + i) % 251
  return u.buffer
}
function expected(total) {
  const u = new Uint8Array(total)
  for (let i = 0; i < total; i++) u[i] = i % 251
  return Buffer.from(u)
}
async function feed(writer, total, chunkBytes) {
  let off = 0
  const sizes = Array.isArray(chunkBytes) ? chunkBytes : null
  for (let i = 0; off < total; i++) {
    const len = Math.min(sizes ? sizes[i % sizes.length] : chunkBytes, total - off)
    await writer.push(chunk(0, off, len))
    off += len
  }
  await writer.flush()
}

const tests = []
const test = (name, fn) => tests.push({ name, fn })

test('小块慢慢攒:不足一批也只写一次,内容一致', async () => {
  const fs = fakeFs()
  const w = createWriter(fs, '/a.bin')
  await feed(w, 300 * 1024, 128 * 1024)                 // 128KB × 2 + 44KB
  assert.strictEqual(fs.writes(), 1)
  assert(fs.content('/a.bin').equals(expected(300 * 1024)))
  assert.strictEqual(w.onDiskBytes, 300 * 1024)
})

test('跨批:批次逐次翻倍(4→8→16→16MB 封顶),顺序与内容一致', async () => {
  const fs = fakeFs()
  const w = createWriter(fs, '/b.bin')
  await feed(w, 40 * MB, 128 * 1024)                    // 相当于 128KB 一块、共 320 块
  const sizes = fs.log.filter(x => x.op !== 'unlink').map(x => x.bytes / MB)
  assert.deepStrictEqual(sizes, [4, 8, 16, 12], '应为 4/8/16MB 三整批 + 12MB 收尾,实际 ' + sizes)
  assert.strictEqual(fs.log[0].op, 'writeFile')
  assert(fs.log.slice(1).every(x => x.op === 'appendFile'))
  assert(fs.content('/b.bin').equals(expected(40 * MB)))
})

test('块比一批还大:也能完整落下', async () => {
  const fs = fakeFs()
  const w = createWriter(fs, '/c.bin')
  await feed(w, 50 * MB, 7 * MB)                       // 单块 7MB > 首批 4MB
  assert(fs.content('/c.bin').equals(expected(50 * MB)))
  assert(fs.log.every(x => x.bytes <= MAX_FLUSH_BYTES), '单次落盘不应超过 MAX_FLUSH_BYTES')
})

test('大小不一的块:内容一致', async () => {
  const fs = fakeFs()
  const w = createWriter(fs, '/d.bin')
  await feed(w, 9 * MB + 12345, [720 * 1024, 3, 100 * 1024, 1, 2048 * 1024])
  assert(fs.content('/d.bin').equals(expected(9 * MB + 12345)))
})

test('超过 maxBytes:报指定的文案,之后不再收也不再写', async () => {
  const fs = fakeFs()
  const w = createWriter(fs, '/e.bin', { maxBytes: 5 * MB, overMessage: '太大了' })
  await feed(w, 3 * MB, 128 * 1024)
  await assert.rejects(feed(w, 3 * MB, 128 * 1024), e => e.message === '太大了' && e.code === 'over')   // 再来 3MB 会超过 5MB
  await assert.rejects(w.push(chunk(0, 0, 10)), /太大了/)
  await assert.rejects(w.flush(), /太大了/)              // 已判超限:不再落盘(调用方会作废这个文件)
})

test('写到一半失败:错误传给调用方,落盘字节数只算成功的那些', async () => {
  const fs = fakeFs({ failAt: 2 })
  const w = createWriter(fs, '/f.bin', { diskFailMessage: raw => '存不下(' + raw + ')' })
  await feed(w, 3 * MB, 128 * 1024)                     // 第 1 次落盘(3MB)成功
  // 继续喂:攒满 4MB 触发第 2 次落盘 —— 这一次失败
  await assert.rejects(feed(w, 12 * MB, 512 * 1024), e => /存不下/.test(e.message) && /mock/.test(e.message))
  assert.strictEqual(w.onDiskBytes, 3 * MB, '只有成功的那一次算数')
  await assert.rejects(w.flush(), /存不下/)              // 之后的也一直是失败态
})

test('作废:没落过盘就不删文件;落过就删', async () => {
  const fs = fakeFs()
  const w = createWriter(fs, '/g.bin')
  await w.push(chunk(0, 0, 1000))
  await w.discard()
  assert(!fs.log.some(x => x.op === 'unlink'), '没落过盘不该去删')
  assert.strictEqual(w.onDiskBytes, 0)
  const w2 = createWriter(fs, '/h.bin')
  await feed(w2, 5 * MB, 128 * 1024)
  await w2.discard()
  assert(fs.log.some(x => x.op === 'unlink' && x.path === '/h.bin'))
  await assert.rejects(w2.push(chunk(0, 0, 10)), /已取消/)
})

test('作废时在途的那一批:等它落定后再删,不留半成品', async () => {
  const fs = fakeFs()
  const w = createWriter(fs, '/i.bin')
  let off = 0
  for (let i = 0; i < 40; i++) { await w.push(chunk(0, off, 128 * 1024)); off += 128 * 1024 }   // 5MB:第 1 批已排队
  await w.discard()
  assert(!fs.files.has('/i.bin'), '文件应被删掉')
})

test('续传:接着已有文件追加,内容前后衔接', async () => {
  const fs = fakeFs()
  fs.files.set('/j.bin', expected(2 * MB + 777))
  const w = createWriter(fs, '/j.bin', { append: true, appendFrom: 2 * MB + 777 })
  let off = 2 * MB + 777
  for (let i = 0; off < 9 * MB; i++) { const len = Math.min(720 * 1024, 9 * MB - off); await w.push(chunk(0, off, len)); off += len }
  await w.flush()
  assert(fs.log[0].op === 'appendFile', '续传第一下就应该是追加')
  assert(fs.content('/j.bin').equals(expected(9 * MB)))
  assert.strictEqual(w.bytes, 9 * MB)
})

test('平方计数配额(模拟器实测规则):128KB 一块直接追加会爆,攒批写 60MB 没问题', async () => {
  // 对照组:来一块写一块(128KB 一块,直接 appendFile)—— 模拟器里就是这样爆的
  const raw = fakeFs({ quadratic: true })
  let off = 0
  for (; off < 60 * MB; off += 128 * 1024) {
    const ok = await new Promise(resolve => raw.appendFile({ filePath: '/k.bin', data: chunk(0, off, 128 * 1024), success: () => resolve(true), fail: () => resolve(false) }))
    if (!ok) break
  }
  assert(off < 30 * MB, '一块一写的对照组应当在几十 MB 内就撞上上限,实际写到 ' + (off / MB).toFixed(1) + 'MB')
  // 攒批写:60MB = 4 + 8 + 16 + 16 + 16 五次,配额累计 = 4+12+28+44+60 = 148MB
  const fs = fakeFs({ quadratic: true })
  const w = createWriter(fs, '/l.bin')
  await feed(w, 60 * MB, 128 * 1024)
  assert(fs.content('/l.bin').equals(expected(60 * MB)))
  assert.strictEqual(fs.log.length, 5)
})

test('常量:首批 4MB、上限 16MB', () => {
  assert.strictEqual(FIRST_FLUSH_BYTES, 4 * MB)
  assert.strictEqual(MAX_FLUSH_BYTES, 16 * MB)
})

;(async () => {
  let pass = 0
  let fail = 0
  for (const t of tests) {
    try {
      await t.fn()
      pass++
      console.log('  ✓ ' + t.name)
    } catch (e) {
      fail++
      console.log('  ✗ ' + t.name + '\n      ' + String(e && e.message || e).split('\n').join('\n      '))
    }
  }
  console.log('\n' + pass + ' 过 / ' + fail + ' 败')
  process.exit(fail ? 1 : 0)
})()
