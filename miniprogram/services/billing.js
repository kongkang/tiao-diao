// 计费引擎 —— 规则已定稿（2026-10-05），勿随意改：
//   计费分钟 = max(1, round(秒/60))   四舍五入，最少 1 分钟（3:30 → 4）
//   广告数   = ceil(分钟/3)           3:30 起 2 个；6:30 起 3 个
//   金额     = 分钟 × 0.1 元          4 分 12 秒 → 4 分钟 → ¥0.4
//
// 权益读取三层（2026-10-06 加本地层）：
//   PAY_ENABLED=true  → 云函数 getEntitlement（订阅状态以服务器为准）
//   PAY_ENABLED=false → 本地权益（wx.setStorageSync td_local_entitlement）：
//     默认 { free:true }（内测全免费，与之前行为一致）；
//     管理页可模拟「包月用户 / 有余额用户 / 普通用户」，用于提前联调
//     解锁/购买流程；接服务器后此层整体被 PAY_ENABLED 分支取代，不用删。

const config = require('../config.js')
const cloud = require('./cloud.js')

const ENT_KEY = 'td_local_entitlement'

function calcBilling(durationSec) {
  const minutes = Math.max(1, Math.round(durationSec / 60))
  const adCount = Math.ceil(minutes / config.AD_MINUTES_PER_UNIT)
  const priceFen = minutes * config.PRICE_PER_MIN_FEN
  return {
    minutes,
    adCount,
    priceFen,
    priceYuan: (priceFen / 100).toFixed(1).replace(/\.0$/, ''),
    showMonthlyHint: adCount >= 2, // 要看 2 个以上视频时引导包月
  }
}

/** 规范化本地权益：包月到期自动降级；返回结构对齐云函数版 */
function normalizeEnt(e) {
  const minutes = Math.max(0, e.minutes || 0)
  if (e.monthly && e.monthlyUntil) {
    const daysLeft = Math.ceil((e.monthlyUntil - Date.now()) / 86400000)
    if (daysLeft > 0) {
      return { free: false, monthly: true, minutes, monthlyDaysLeft: daysLeft, monthlyUntil: e.monthlyUntil }
    }
  }
  if (e.free) return { free: true, monthly: false, minutes, monthlyDaysLeft: 0 }
  return { free: false, monthly: false, minutes, monthlyDaysLeft: 0 }
}

/** 读本地权益（同步，内部用） */
function readLocalEnt() {
  try {
    const e = wx.getStorageSync(ENT_KEY)
    if (e && typeof e === 'object') return normalizeEnt(e)
  } catch (err) { /* 读取异常按内测免费处理 */ }
  return { free: true, monthly: false, minutes: 0, monthlyDaysLeft: 0 }
}

/** 查权益：包月 > 分钟额度。PAY_ENABLED=false 时走本地存储 */
async function getEntitlement() {
  if (!config.PAY_ENABLED) {
    return readLocalEnt()
  }
  return cloud.call('getEntitlement')
}

/** 扣减（处理成功后调用）。内测免费模式直接放行 */
async function consume(minutes) {
  if (!config.PAY_ENABLED) {
    const ent = readLocalEnt()
    if (ent.free || ent.monthly) return { ok: true, free: ent.free }
    if (ent.minutes >= minutes) {
      const remain = ent.minutes - minutes
      writeLocalEnt({ free: false, monthly: false, minutes: remain })
      return { ok: true, minutes: remain }
    }
    // 余额不足：不扣，交给流程层处理（process 页扣费失败不阻塞交付）
    return { ok: false, reason: 'insufficient', minutes: ent.minutes }
  }
  return cloud.call('consume', { minutes })
}

/** 写本地权益（管理页模拟用；PAY_ENABLED=true 时不生效） */
function writeLocalEnt(ent) {
  try { wx.setStorageSync(ENT_KEY, ent) } catch (e) { /* */ }
  return normalizeEnt(ent)
}

/** 清掉本地权益，恢复内测免费默认态 */
function resetLocalEnt() {
  try { wx.removeStorageSync(ENT_KEY) } catch (e) { /* */ }
  return readLocalEnt()
}

module.exports = { calcBilling, getEntitlement, consume, writeLocalEnt, resetLocalEnt, readLocalEnt }
