// consume —— 扣减分钟额度（前端在处理成功后才调用，见 pages/process）
// 输入：{ minutes, songKey? }
// 规则：
//   1. 包月期间不扣，直接放行
//   2. 同一首歌在 RETRY_FREE_MINUTES 窗口内重转不重复扣（防失败重试双扣）
//   3. 余额不足返回 { ok:false, message }，前端引导购买

const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const RETRY_FREE_MS = 30 * 60 * 1000 // 与前端 config.RETRY_FREE_MINUTES 一致

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const minutes = Math.max(1, Math.round(event.minutes || 0))
  const songKey = event.songKey || ''

  const users = db.collection('users')
  const { data } = await users.where({ _openid: OPENID }).limit(1).get()
  const user = data[0]
  if (!user) return { ok: false, message: '余额不足，请先购买分钟' }

  const now = Date.now()

  // 1) 包月放行
  if (user.monthlyUntil && user.monthlyUntil > now) {
    return { ok: true, monthly: true, minutes: user.minutes || 0 }
  }

  // 2) 重转窗口内不重复扣
  if (songKey && user.lastSongKey === songKey &&
      user.lastConsumeAt && now - user.lastConsumeAt < RETRY_FREE_MS) {
    return { ok: true, retry: true, minutes: user.minutes || 0 }
  }

  // 3) 扣减（条件更新防并发双扣）
  const res = await users.where({
    _openid: OPENID,
    minutes: _.gte(minutes),
  }).update({
    data: {
      minutes: _.inc(-minutes),
      lastSongKey: songKey,
      lastConsumeAt: now,
    },
  })

  if (res.stats.updated === 0) {
    return { ok: false, message: '余额不足，请先购买分钟' }
  }

  // 记流水（对账用）
  await db.collection('consume_logs').add({
    data: { _openid: OPENID, minutes, songKey, at: db.serverDate() },
  })

  return { ok: true, minutes: (user.minutes || 0) - minutes }
}
