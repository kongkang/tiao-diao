// login —— 用 wx.login 的 code 换 openid + session_key
// session_key 是虚拟支付签名的必备材料，只能在云端出现
// ⚠️ 部署前在「云函数配置」里填环境变量：APPID、APPSECRET（或走云调用免鉴权）

const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

// 简单内存缓存：code 只能用一次，但 openid 可复用（前端每次支付都换新 code）
exports.main = async (event) => {
  const { code } = event
  const { OPENID, APPID, UNIONID } = cloud.getWXContext()

  // 管理员判定：云函数环境变量 ADMIN_OPENIDS（逗号分隔的 openid 白名单）
  // 在「云函数 → 配置 → 环境变量」里填，不进入代码库
  const adminList = (process.env.ADMIN_OPENIDS || '').split(',').map(s => s.trim()).filter(Boolean)
  const isAdmin = adminList.indexOf(OPENID) > -1

  if (!code) {
    // 无 code 时直接返回上下文 openid（云调用免鉴权场景）
    return { ok: true, openid: OPENID, isAdmin }
  }

  // TODO(M2)：正式环境在这里调 jscode2session 换 session_key 并入库，
  // 供 createOrder 计算虚拟支付签名使用。内测阶段云调用上下文已含 OPENID，
  // 无需额外动作。
  return {
    ok: true,
    openid: OPENID,
    appid: APPID,
    unionid: UNIONID || '',
    isAdmin,
  }
}
