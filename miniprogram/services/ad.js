// 激励视频广告状态机 —— 核心原则：广告失败绝不卡用户
//   ① 实例创建失败 → 放行          ② load/show 失败 → 放行
//   ③ 中途关闭(isEnded=false) → 不放行，可重看
//   ④ 多个广告中途失败 → 已看的有效，剩余直接放行
//   ⑤ 加载超 8 秒 → 按失败放行
//   每日失败放行有上限（防断网刷），走云函数计数；内测模式记在本地。

const config = require('../config.js')
const cloud = require('./cloud.js')

let adInstance = null

function getAd() {
  if (!config.AD_ENABLED || !wx.createRewardedVideoAd) return null
  if (!adInstance) {
    adInstance = wx.createRewardedVideoAd({ adUnitId: config.AD_UNIT_ID })
  }
  return adInstance
}

/** 看完一个广告（resolve 'done' / 'skipped' / 'error'） */
function watchOne(ad) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve('timeout'), 8000)
    const onClose = res => {
      cleanup()
      resolve(res && res.isEnded === true ? 'done' : 'skipped')
    }
    const onError = () => { cleanup(); resolve('error') }
    function cleanup() {
      clearTimeout(timer)
      ad.offClose && ad.offClose(onClose)
      ad.offError && ad.offError(onError)
    }
    ad.onClose(onClose)
    ad.onError(onError)
    ad.show().catch(() => { cleanup(); resolve('error') })
  })
}

/** 失败放行计数（内测：本地；正式：云函数） */
async function grantFree(reason) {
  try {
    if (!config.PAY_ENABLED) {
      const key = 'ad_fail_grant_' + new Date().toDateString()
      const n = (wx.getStorageSync(key) || 0) + 1
      if (n > config.AD_FAIL_GRANT_MAX_PER_DAY) return { ok: false, reason: 'daily_limit' }
      wx.setStorageSync(key, n)
      return { ok: true, free: true, reason }
    }
    return await cloud.call('grantAdFail', { reason })
  } catch (e) {
    // 计数失败也放行：宁可被占便宜，不能卡用户
    return { ok: true, free: true, reason: 'count_fail' }
  }
}

/**
 * 通过看广告解锁本次处理
 * @returns {ok, free, reason?}  ok=false 且 reason==='skipped' → 提示重看
 */
async function unlockByAd(needCount) {
  if (!config.AD_ENABLED) return { ok: true, free: true, reason: 'disabled' }
  const ad = getAd()
  if (!ad) return grantFree('no_ad_instance')

  for (let i = 1; i <= needCount; i++) {
    const r = await watchOne(ad)
    if (r === 'done') continue
    if (r === 'skipped') return { ok: false, reason: 'skipped' }
    // error / timeout
    if (i > 1) return grantFree('partial_done') // 已看的算数，剩余放行
    return grantFree(r)
  }
  return { ok: true, free: false }
}

module.exports = { unlockByAd }
