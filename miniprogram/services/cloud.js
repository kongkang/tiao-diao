// 云函数调用封装（微信云开发 CloudBase）
// ⚠️ 需要先在开发者工具里开通云开发并部署 cloudfunctions/ 下的函数
// PAY_ENABLED=true 时支付/权益都走这里；云不可用时由上层按 config.PAY_OFFLINE_FREE 兜底

const config = require('../config.js')

let inited = false

function init() {
  if (inited || !wx.cloud) return
  try {
    const opts = { traceUser: true }
    // 只有一个云环境时可以不填；多环境必须填，否则默认环境可能不对
    if (config.CLOUD_ENV) opts.env = config.CLOUD_ENV
    wx.cloud.init(opts)
    inited = true
  } catch (e) {
    console.warn('[cloud] init 失败（未开通云开发？）', e)
  }
}

/** 云能力是否可用（基础库/开发者工具提供 wx.cloud 才有） */
function available() {
  return !!wx.cloud
}

function call(name, data) {
  init()
  if (!wx.cloud) return Promise.reject(new Error('云服务不可用，请更新微信后重试'))
  return wx.cloud.callFunction({ name, data }).then(
    res => {
      const r = res && res.result
      if (r && r.ok === false) throw new Error(r.message || '云函数返回失败')
      return r
    },
    err => {
      console.warn('[cloud] 调用失败', name, (err && err.errMsg) || err)
      throw new Error('网络或支付服务不可用，请稍后重试')
    }
  )
}

module.exports = { call, available }
