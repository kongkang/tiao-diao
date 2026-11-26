#!/usr/bin/env node
/**
 * 模块加载冒烟(不需要开发者工具):把 services / utils 下的模块在 Node 里逐个加载一遍
 * (wx、getApp 打桩),抓「一加载就报错」和「导出了未定义的名字」这两类低级错误。
 * 这种错在开发者工具里要等到跑到那条路径才暴露,这里一秒钟就能扫出来。
 *
 * 运行:node tools/autotest/smoke-modules.js
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '../..')
const noop = () => {}
global.wx = new Proxy({ env: { USER_DATA_PATH: '/usr' } }, { get: (t, k) => (k in t ? t[k] : noop) })
global.getApp = () => ({ globalData: {} })
global.getCurrentPages = () => []

let bad = 0
for (const dir of ['miniprogram/services', 'miniprogram/utils']) {
  for (const name of fs.readdirSync(path.join(ROOT, dir)).filter(x => x.endsWith('.js'))) {
    const file = path.join(ROOT, dir, name)
    try {
      const m = require(file)
      const missing = Object.keys(m).filter(k => m[k] === undefined)
      if (missing.length) {
        bad++
        console.log('  ✗ ' + dir + '/' + name + ' 导出了未定义的: ' + missing.join(', '))
      } else {
        console.log('  ✓ ' + dir + '/' + name + ' (' + Object.keys(m).length + ' 项)')
      }
    } catch (e) {
      bad++
      console.log('  ✗ ' + dir + '/' + name + ' 加载失败: ' + e.message)
    }
  }
}
console.log(bad ? '\n' + bad + ' 个模块有问题' : '\n全部模块可加载')
process.exit(bad ? 1 : 0)
