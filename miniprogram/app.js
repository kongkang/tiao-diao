const config = require('./config.js')
const identity = require('./services/identity.js')

App({
  globalData: {
    fontScale: 1, // 微信字体缩放倍率（关怀模式 ≈ 1.4，安卓最大 ≈ 1.55）
  },

  onLaunch() {
    // 本地身份识别：生成/读取本地用户 ID，累计启动次数；
    // CLOUD_LOGIN_ENABLED=true 时自动 wx.login 换 openid（云开发部署后生效）
    identity.init()

    // 大字适配：读微信字体缩放倍率
    // ⚠️ 用 getAppBaseInfo，不要用 getSystemInfo（官方不再维护）
    try {
      const info = wx.getAppBaseInfo()
      const f = info.fontSizeScaleFactor
      if (f && f > 1) this.globalData.fontScale = f
    } catch (e) { /* 低版本基础库兜底：保持 1 */ }

    // 内存警告：音频处理是内存大户，收到警告立即提示用户
    wx.onMemoryWarning(() => {
      console.warn('[memory] 收到系统内存警告')
    })

    console.log('[app] 启动完成', {
      AD_ENABLED: config.AD_ENABLED,
      PAY_ENABLED: config.PAY_ENABLED,
      ENCODE: config.ENCODE,
    })
  },
})
