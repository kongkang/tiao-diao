#!/usr/bin/env node
// 元宝 Cookie 有效期探针(零依赖)
//
// 用法:先把元宝 Cookie 放进 tools/yuanbao-cookie.txt(已 gitignore,不会进库),
// 然后跑 node tools/yuanbao-cookie-probe.js —— 可挂每日定时任务,积累真实过期数据。
//
// 判定:POST get_parse_result 用一个真实 sph 链接探测,
//   2xx → Cookie 有效;401 → 失效(20001=过期/20000=无凭据);其他 → 网络或接口异常
// 结果追加到 tools/yuanbao-cookie-probe.log(已 gitignore),格式:
//   [ISO时间] VALID|INVALID|NETERR|IDLE days=从Cookie文件创建起的天数 detail

const fs = require('fs')
const path = require('path')
const https = require('https')

const root = path.join(__dirname, '..')
const cookieFile = path.join(root, 'tools', 'yuanbao-cookie.txt')
const logFile = path.join(root, 'tools', 'yuanbao-cookie-probe.log')
const TEST_URL = 'https://weixin.qq.com/sph/A6e7uGh8J8'   // 公开作品,仅用于验证 Cookie 授权

function post(url, body, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body))
    const req = https.request(url, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': data.length }, headers),
      timeout: timeoutMs || 12000,
    }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.write(data)
    req.end()
  })
}

function logLine(line) {
  try { fs.appendFileSync(logFile, line + '\n') } catch (e) { /* */ }
}

async function main() {
  if (!fs.existsSync(cookieFile)) {
    const line = '[' + new Date().toISOString() + '] IDLE days=- (cookie 文件不存在,探针闲置)'
    logLine(line)
    console.log(line)
    return
  }
  const cookie = fs.readFileSync(cookieFile, 'utf8').trim()
  const days = ((Date.now() - fs.statSync(cookieFile).mtimeMs) / 86400000).toFixed(1)
  if (!cookie) {
    const line = '[' + new Date().toISOString() + '] IDLE days=' + days + ' (cookie 文件是空的)'
    logLine(line)
    console.log(line)
    return
  }

  let status = 'NETERR'
  let detail = ''
  try {
    const r = await post('https://yuanbao.tencent.com/api/weixin/get_parse_result',
      { type: 'video_channel_url', url: TEST_URL, scene: 1 },
      {
        'Content-Type': 'application/json',
        'Origin': 'https://yuanbao.tencent.com',
        'Referer': 'https://yuanbao.tencent.com/',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        Cookie: cookie,
      })
    if (r.status >= 200 && r.status < 300) {
      status = 'VALID'
      detail = ''
    } else if (r.status === 401) {
      status = 'INVALID'
      try { detail = String((JSON.parse(r.body).error || {}).code || '') } catch (e) { /* */ }
    } else {
      status = 'HTTP' + r.status
    }
  } catch (e) {
    detail = e.message
  }
  const line = '[' + new Date().toISOString() + '] ' + status + ' days=' + days + (detail ? ' detail=' + detail : '')
  logLine(line)
  console.log(line)
  if (status === 'INVALID') console.log('>>> Cookie 已失效!从放入文件起共 ' + days + ' 天。重新登录元宝取 Cookie 覆盖 tools/yuanbao-cookie.txt')
}

main().catch(e => { console.error('probe error:', e.message); process.exit(1) })
