// 页面包装器：注入大字适配的根字号倍率 + 全站默认分享
// 用法：const page = require('../../utils/page.js')
//       page({ data: {...}, ... })  // 代替直接调 Page()

// 默认分享文案：分享卡片统一指向首页（歌曲都在本地，中途页面分享出去别人打不开）
// 封面图 tools/design/share-cover.html 渲染（1000×800 5:4，微信推荐比例）
const DEFAULT_SHARE_TITLE = '把歌调高调低'
const DEFAULT_SHARE_PATH = '/pages/index/index'
const DEFAULT_SHARE_IMAGE = '/images/share-cover.png'

module.exports = function page(cfg) {
  const rawOnLoad = cfg.onLoad
  cfg.data = Object.assign({ fontScale: 1 }, cfg.data || {})
  cfg.onLoad = function () {
    this.setData({ fontScale: getApp().globalData.fontScale || 1 })
    if (rawOnLoad) rawOnLoad.apply(this, arguments)
  }
  // 全站开启分享：页面自己定义了处理器则不覆盖
  // - onShareAppMessage → 右上角菜单出现「转发给朋友」
  // - onShareTimeline   → 出现「分享到朋友圈」（需基础库 2.11.3+）
  // - 「复制链接」是微信默认能力，转发开启后真机菜单里自动有
  if (!cfg.onShareAppMessage) {
    cfg.onShareAppMessage = () => ({
      title: DEFAULT_SHARE_TITLE, path: DEFAULT_SHARE_PATH, imageUrl: DEFAULT_SHARE_IMAGE,
    })
  }
  if (!cfg.onShareTimeline) {
    cfg.onShareTimeline = () => ({ title: DEFAULT_SHARE_TITLE, query: 'from=timeline', imageUrl: DEFAULT_SHARE_IMAGE })
  }
  return Page(cfg)
}
