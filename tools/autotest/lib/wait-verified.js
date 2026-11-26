// 等选调页的「解码确认」通过
// 背景(2026-11-26):选调页现在先确认这首歌真的能解出声音,通过之后才出现「下一步」、才响应播放。
// 自动化脚本进到 pages/pitch/index 后先 await waitVerified(page),再点播放 / 下一步。
const sleep = ms => new Promise(r => setTimeout(r, ms))

module.exports = async function waitVerified(page, timeoutMs) {
  const t0 = Date.now()
  const limit = timeoutMs || 20000
  while (Date.now() - t0 < limit) {
    const d = await page.data()
    if (d.verifyState === 'ok') return true
    if (d.verifyState === 'failed') throw new Error('这首歌没通过解码确认: ' + d.verifyText)
    await sleep(300)
  }
  throw new Error('等解码确认超时')
}
