// 用户身份识别 —— 本地版（2026-10-06）
//
// 现状：云开发未部署，前端拿不到 openid（openid 只能由服务端用 wx.login 的 code
// 换取，前端无任何途径直接获取）。所以本阶段采用「本地用户 ID」识别这台设备上的
// 用户；历史记录、权益模拟都挂在这个 ID 下。
//
// 后续接入服务器只需两步（代码已预埋，不用改逻辑）：
//   ① 部署 cloudfunctions/login 后，config.CLOUD_LOGIN_ENABLED = true
//      → 启动时自动 wx.login → 云函数换 openid 存本地
//   ② 管理页复制自己的 openid，填进 config.ADMIN_OPENIDS
//      → 白名单命中即管理员，无需本地手势解锁
//
// 管理员判定 = 本地手势解锁（首页图标连点 5 次） || openid 白名单命中

const config = require('../config.js')
const cloud = require('./cloud.js')

const KEY_USER_ID = 'td_user_id'
const KEY_USER_META = 'td_user_meta'
const KEY_OPENID = 'td_openid'
const KEY_ADMIN_LOCAL = 'td_admin_local'
const KEY_PROFILE = 'td_profile' // { avatarUrl, nickname, loggedAt }

// 模块内缓存，getUser() 同步可用
let cached = null

function genUserId() {
  // 简易 uuid v4（本地标识用，无安全要求）
  return 'u_' + 'xxxxxxxx-xxxx-4xxx'.replace(/x/g, () =>
    Math.floor(Math.random() * 16).toString(16)) + Date.now().toString(36)
}

function load() {
  let userId = ''
  let meta = { firstLaunchAt: 0, lastLaunchAt: 0, launchCount: 0 }
  let openid = ''
  let adminLocal = false
  let profile = null
  try {
    userId = wx.getStorageSync(KEY_USER_ID) || ''
    meta = wx.getStorageSync(KEY_USER_META) || meta
    openid = wx.getStorageSync(KEY_OPENID) || ''
    adminLocal = !!wx.getStorageSync(KEY_ADMIN_LOCAL)
    profile = wx.getStorageSync(KEY_PROFILE) || null
  } catch (e) { /* 存储异常按新用户处理 */ }

  if (!userId) {
    userId = genUserId()
    meta.firstLaunchAt = Date.now()
    try { wx.setStorageSync(KEY_USER_ID, userId) } catch (e) { /* */ }
  }
  return { userId, meta, openid, adminLocal, profile }
}

/** 云端登录换 openid（CLOUD_LOGIN_ENABLED=true 时生效；失败静默，不影响本地功能） */
async function tryCloudLogin() {
  if (!config.CLOUD_LOGIN_ENABLED) return
  try {
    const { code } = await new Promise((resolve, reject) =>
      wx.login({ success: resolve, fail: reject }))
    const r = await cloud.call('login', { code })
    if (r && r.openid) {
      cached.openid = r.openid
      wx.setStorageSync(KEY_OPENID, r.openid)
      console.log('[identity] 云端登录成功，openid 已更新')
    }
  } catch (e) {
    console.warn('[identity] 云端登录失败（云开发未部署？），继续使用本地身份', e)
  }
}

/** 应用启动时调用（app.js onLaunch） */
function init() {
  cached = load()
  cached.meta.launchCount = (cached.meta.launchCount || 0) + 1
  cached.meta.lastLaunchAt = Date.now()
  try { wx.setStorageSync(KEY_USER_META, cached.meta) } catch (e) { /* */ }

  console.log('[identity] 用户', cached.userId,
    '第 ' + cached.meta.launchCount + ' 次启动，admin=' + isAdmin())

  tryCloudLogin() // 异步，不阻塞启动
}

function ensureLoaded() { if (!cached) cached = load() }

/** 当前用户（同步）：{ userId, openid, launchCount, firstLaunchAt } */
function getUser() {
  ensureLoaded()
  return {
    userId: cached.userId,
    openid: cached.openid,
    launchCount: cached.meta.launchCount || 0,
    firstLaunchAt: cached.meta.firstLaunchAt || 0,
  }
}

/** 是否管理员：本地手势解锁 || openid 白名单命中 */
function isAdmin() {
  ensureLoaded()
  if (cached.adminLocal) return true
  const list = config.ADMIN_OPENIDS || []
  return !!cached.openid && list.indexOf(cached.openid) > -1
}

/** 本地手势解锁管理员（首页图标连点触发） */
function unlockAdminLocal() {
  ensureLoaded()
  cached.adminLocal = true
  try { wx.setStorageSync(KEY_ADMIN_LOCAL, true) } catch (e) { /* */ }
}

/** 退出本地管理员模式（白名单命中的不受影响） */
function lockAdminLocal() {
  ensureLoaded()
  cached.adminLocal = false
  try { wx.removeStorageSync(KEY_ADMIN_LOCAL) } catch (e) { /* */ }
}

// ---- 登录资料（头像 + 昵称，微信官方「头像昵称填写能力」） ----
// chooseAvatar 返回的是临时文件（当次会话有效），必须先落盘到用户目录才能跨启动使用。

/** 当前登录资料：{ avatarUrl, nickname, loggedAt } 或 null（未登录） */
function getProfile() {
  ensureLoaded()
  return cached.profile && cached.profile.loggedAt ? cached.profile : null
}

/** 把 chooseAvatar 给的临时头像落盘为持久文件（已是本地路径则原样返回） */
function persistAvatar(tempPath) {
  return new Promise((resolve, reject) => {
    if (!tempPath) return reject(new Error('没有头像'))
    if (tempPath.indexOf(wx.env.USER_DATA_PATH) === 0) return resolve(tempPath)
    const fs = wx.getFileSystemManager()
    fs.saveFile({
      tempFilePath: tempPath,
      success: r => resolve(r.savedFilePath),
      fail: e => reject(new Error('保存头像失败：' + (e && e.errMsg || ''))),
    })
  })
}

/** 登录/更新资料：{ avatarTempPath?, nickname? }。至少有头像或昵称才算登录 */
async function saveProfile(patch) {
  ensureLoaded()
  const cur = cached.profile || {}
  let avatarUrl = cur.avatarUrl || ''
  if (patch && patch.avatarTempPath) {
    avatarUrl = await persistAvatar(patch.avatarTempPath).catch(() => cur.avatarUrl || patch.avatarTempPath)
  }
  const nickname = (patch && patch.nickname != null) ? String(patch.nickname).trim().slice(0, 12) : cur.nickname
  const profile = {
    avatarUrl,
    nickname: nickname || '歌友',
    loggedAt: cur.loggedAt || Date.now(),
  }
  cached.profile = profile
  try { wx.setStorageSync(KEY_PROFILE, profile) } catch (e) { /* */ }
  return profile
}

/** 退出登录（只清资料，不影响权益/历史） */
function clearProfile() {
  ensureLoaded()
  cached.profile = null
  try { wx.removeStorageSync(KEY_PROFILE) } catch (e) { /* */ }
}

module.exports = {
  init, getUser, isAdmin, unlockAdminLocal, lockAdminLocal,
  getProfile, saveProfile, clearProfile, persistAvatar,
}
