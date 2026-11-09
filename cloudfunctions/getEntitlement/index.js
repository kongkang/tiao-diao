// getEntitlement —— 查询当前用户权益（以服务器为准）
// 输出：{ ok, monthly, minutes, monthlyDaysLeft, monthlyUntil }
// 规则：包月优先于分钟额度；包月期间 minutes 冻结不动

const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async () => {
  const { OPENID } = cloud.getWXContext()

  let user = null
  try {
    const { data } = await db.collection('users')
      .where({ _openid: OPENID }).limit(1).get()
    user = data[0] || null
  } catch (e) {
    // 集合还没建（从未购买过）：按零权益返回
    if (!/not exist|不存在|COLLECTION_NOT_EXIST/i.test(String(e.message || ''))) throw e
  }

  const now = Date.now()
  const monthlyUntil = (user && user.monthlyUntil) || 0
  const monthly = monthlyUntil > now

  return {
    ok: true,
    monthly: monthly,
    minutes: (user && user.minutes) || 0,
    monthlyDaysLeft: monthly ? Math.ceil((monthlyUntil - now) / 86400000) : 0,
    monthlyUntil: monthlyUntil,
  }
}
