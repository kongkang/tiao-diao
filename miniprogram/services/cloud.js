// 云函数调用封装（微信云开发 CloudBase）
// ⚠️ 需要先在开发者工具里开通云开发并部署 cloudfunctions/ 下的函数
// 内测阶段 PAY_ENABLED=false，所有云调用都会被跳过

let inited = false

function init() {
  if (inited || !wx.cloud) return
  try {
    wx.cloud.init({ traceUser: true })
    inited = true
  } catch (e) {
    console.warn('[cloud] init 失败（未开通云开发？）', e)
  }
}

function call(name, data) {
  init()
  if (!wx.cloud) return Promise.reject(new Error('云开发不可用'))
  return wx.cloud.callFunction({ name, data }).then(res => {
    const r = res.result
    if (r && r.ok === false) throw new Error(r.message || '云函数返回失败')
    return r
  })
}

module.exports = { call }
