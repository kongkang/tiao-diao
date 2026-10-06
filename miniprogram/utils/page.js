// 页面包装器：注入大字适配的根字号倍率
// 用法：const page = require('../../utils/page.js')
//       page({ data: {...}, ... })  // 代替直接调 Page()
module.exports = function page(cfg) {
  const rawOnLoad = cfg.onLoad
  cfg.data = Object.assign({ fontScale: 1 }, cfg.data || {})
  cfg.onLoad = function () {
    this.setData({ fontScale: getApp().globalData.fontScale || 1 })
    if (rawOnLoad) rawOnLoad.apply(this, arguments)
  }
  return Page(cfg)
}
