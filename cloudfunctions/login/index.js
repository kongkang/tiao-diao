// login —— 返回当前用户 openid（管理员白名单判定）
//
// 说明：虚拟支付需要的 session_key 不在这里返回——createOrder 用前端每次
// 新取的 wx.login code 直接调 code2session 换取，session_key 永不出云端。
//
// 云函数环境变量（可选）：
//   ADMIN_OPENIDS  逗号分隔的管理员 openid 白名单

const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

exports.main = async () => {
  const { OPENID, APPID, UNIONID } = cloud.getWXContext()

  const adminList = (process.env.ADMIN_OPENIDS || '')
    .split(',').map(s => s.trim()).filter(Boolean)
  const isAdmin = adminList.indexOf(OPENID) > -1

  return {
    ok: true,
    openid: OPENID,
    appid: APPID,
    unionid: UNIONID || '',
    isAdmin,
  }
}
