// getEntitlement —— 查询当前用户权益
// 输出：{ ok, monthly, minutes, monthlyDaysLeft }
// 规则：包月优先于分钟额度；包月期间 minutes 冻结不动

const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async () => {
  const { OPENID } = cloud.getWXContext()
  const { data } = await db.collection('users')
    .where({ _openid: OPENID }).limit(1).get()

  const user = data[0] || { minutes: 0, monthlyUntil: 0 }
  const now = Date.now()
  const monthly = !!(user.monthlyUntil && user.monthlyUntil > now)

  return {
    ok: true,
    monthly,
    minutes: user.minutes || 0,
    monthlyDaysLeft: monthly
      ? Math.ceil((user.monthlyUntil - now) / 86400000)
      : 0,
  }
}
