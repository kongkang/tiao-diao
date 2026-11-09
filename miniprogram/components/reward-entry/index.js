// 赞赏入口 —— 官方 reward 组件的包装（2026-11-04）
// 官方约束（developers.weixin.qq.com → 开放能力/小程序赞赏组件）：
//   1. 全小程序只能接入一个 reward，放第二个起全部不渲染 → 本项目只允许在
//      unlock 页放 <reward-entry/>，未来付费上线要挪位置时移动这一行即可
//   2. 组件零参数零事件，作者/头像/人数/跳转全由后台下发；后台判定不可展示
//      （未在开发者助手开通、未绑贴图号、灰度外）时组件不占高度
//   3. 基础库 ≥3.17.3、微信 ≥8.0.78
const config = require('../../config.js')
const { compareVersion } = require('../../utils/format.js')

// 官方组件要求的最低基础库
const MIN_SDK = '3.17.3'

Component({
  data: {
    show: false, // 开关 + 版本守卫通过
    hint: false, // reward 实际渲染出高度后才亮引导文案（避免后台未开通时孤零零一行字）
  },

  lifetimes: {
    attached() {
      let ok = !!config.REWARD_ENABLED
      try {
        const info = wx.getAppBaseInfo ? wx.getAppBaseInfo() : wx.getSystemInfoSync()
        // SDKVersion 拿不到（自动化环境等）时放行：低版本基础库遇到未知组件本来就忽略
        if (info && info.SDKVersion && compareVersion(info.SDKVersion, MIN_SDK) < 0) ok = false
      } catch (e) { /* 取版本失败不拦截，交给基础库兜底 */ }
      this.setData({ show: ok })
      if (ok) this.probeHint()
    },
    detached() {
      // 组件销毁时清掉还在排队的探测，防止 setData 打到已卸载实例
      if (this._hintTimers) this._hintTimers.forEach(clearTimeout)
    },
  },

  methods: {
    /** reward 渲染与否由后台异步决定，页面拿不到事件 —— 探测占位高度来联动文案。
     *  两次探测覆盖后台下发时序；高度 >2px 视为已渲染。 */
    probeHint() {
      this._hintTimers = [800, 2500].map(delay => setTimeout(() => {
        this.createSelectorQuery()
          .select('.reward-slot')
          .boundingClientRect()
          .exec(res => {
            const rect = res && res[0]
            if (rect && rect.height > 2 && !this.data.hint) this.setData({ hint: true })
          })
      }, delay))
    },
  },
})
