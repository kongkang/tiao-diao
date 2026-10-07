// 激励视频广告状态机 —— 核心原则：广告失败绝不卡用户
//   ① 实例创建失败 → 放行          ② load/show 失败 → 放行
//   ③ 中途关闭(isEnded=false) → 不放行，可重看
//   ④ 多个广告中途失败 → 已看的有效，剩余直接放行
//   ⑤ 加载超 8 秒 → 按失败放行
//   每日失败放行有上限（防断网刷免费），走云函数计数；内测模式记在本地。
//
// 三种运行模式（按优先级）：
//   ① AD_ENABLED=true          → 真实激励视频（流量主开通后）
//   ② AD_ENABLED=false + 管理页开了「广告演示」→ pages/adsim 演示广告页
//      （走同一套状态机：看完/中途关/失败放行，供内测期联调完整流程）
//   ③ 都不满足                  → 直接放行（内测免费，与之前行为一致）

const config = require('../config.js')
const cloud = require('./cloud.js')

let adInstance = null

const KEY_AD_SIM = 'td_ad_sim'
const SIM_SEC = 5 // 演示广告时长（秒）：真广告 15~30s，演示取短值便于联调

function isSimEnabled() {
  try { return !!wx.getStorageSync(KEY_AD_SIM) } catch (e) { return false }
}

function setSimEnabled(v) {
  try {
    if (v) wx.setStorageSync(KEY_AD_SIM, true)
    else wx.removeStorageSync(KEY_AD_SIM)
  } catch (e) { /* */ }
  return isSimEnabled()
}

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

/** 演示广告：跳到 pages/adsim，页面通过 EventChannel 回传 {isEnded} */
function watchOneSim(idx, total) {
  return new Promise(resolve => {
    let settled = false
    const done = r => { if (settled) return; settled = true; resolve(r) }
    const timer = setTimeout(() => done('timeout'), 120000)
    wx.navigateTo({
      url: '/pages/adsim/index?idx=' + idx + '&total=' + total + '&sec=' + SIM_SEC,
      events: {
        simResult: r => {
          clearTimeout(timer)
          done(r && r.isEnded === true ? 'done' : 'skipped')
        },
      },
      fail: () => { clearTimeout(timer); done('error') },
    })
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

/** 多个广告的公共循环：done 继续 / skipped 可重看 / 失败按位置放行 */
async function runLoop(needCount, watchFn) {
  for (let i = 1; i <= needCount; i++) {
    const r = await watchFn(i, needCount)
    if (r === 'done') continue
    if (r === 'skipped') return { ok: false, reason: 'skipped' }
    // error / timeout
    if (i > 1) return grantFree('partial_done') // 已看的算数，剩余放行
    return grantFree(r)
  }
  return { ok: true, free: false }
}

/**
 * 通过看广告解锁本次处理
 * @returns {ok, free, reason?}  ok=false 且 reason==='skipped' → 提示重看
 */
async function unlockByAd(needCount) {
  if (config.AD_ENABLED) {
    const ad = getAd()
    if (!ad) return grantFree('no_ad_instance')
    return runLoop(needCount, i => watchOne(ad))
  }
  if (isSimEnabled()) {
    return runLoop(needCount, (i, n) => watchOneSim(i, n))
  }
  return { ok: true, free: true, reason: 'disabled' }
}

module.exports = { unlockByAd, isSimEnabled, setSimEnabled, SIM_SEC }
