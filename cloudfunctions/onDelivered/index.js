// onDelivered —— 接收微信「道具发货推送」xpay_goods_deliver_notify
//
// 两种接法都兼容：
//   ① 云开发消息推送（推荐）：云开发控制台 → 设置 → 其他设置 → 消息推送 →
//      推送模式「云函数」→ 事件 xpay_goods_deliver_notify → 选本云函数
//      此时事件字段直接在 event 顶层（Event/OpenId/OutTradeNo/GoodsInfo…）
//   ② HTTP 触发（MP 后台消息推送 URL）：推送体在 event.body，可能是 JSON 或 XML
//
// 规则：
//   - 必须幂等：同一 outTradeNo 只能发一次货（用 deliveries 集合做发货锁）
//   - 必须回执：返回 { ErrCode: 0, ErrMsg: 'success' }，否则微信最多重推 15 次
//   - 前端 success 回调不能作为发货依据，发货只认推送 / 查单

const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

// 商品定义与 createOrder 保持一致
const PRODUCTS = {
  pkg_60:    { minutes: 60 },
  pkg_month: { monthly: true, days: 30 },
}

function xmlTag(xml, name) {
  const m = xml.match(new RegExp('<' + name + '>([\\s\\S]*?)</' + name + '>'))
  if (!m) return ''
  return m[1].replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim()
}

/** 统一成普通对象：云函数推送 / JSON body / XML body 三种来源 */
function parseEvent(event) {
  const e = event || {}
  if (typeof e.body === 'string') {
    const s = e.body.trim()
    if (s.charAt(0) === '<') {
      return {
        Event: xmlTag(s, 'Event'),
        OpenId: xmlTag(s, 'OpenId'),
        OutTradeNo: xmlTag(s, 'OutTradeNo'),
        Env: Number(xmlTag(s, 'Env') || 0),
        GoodsInfo: {
          ProductId: xmlTag(s, 'ProductId'),
          Quantity: Number(xmlTag(s, 'Quantity') || 1),
        },
        _xml: true,
      }
    }
    try { return JSON.parse(s) } catch (err) { return e }
  }
  if (e.body && typeof e.body === 'object') return e.body
  return e
}

/** 首次调用时集合可能还没建 */
async function ensureCollection(name) {
  try { await db.createCollection(name) } catch (e) { /* 已存在或无权限时忽略 */ }
}

async function getUser(openid) {
  try {
    const { data } = await db.collection('users').where({ _openid: openid }).limit(1).get()
    return data[0] || null
  } catch (e) {
    if (/not exist|不存在|COLLECTION_NOT_EXIST/i.test(String(e.message || ''))) {
      await ensureCollection('users')
      return null
    }
    throw e
  }
}

/** 发货（真正加权益）。调用方保证同一订单只会进来一次 */
async function deliver(order, evt) {
  const product = PRODUCTS[order.productId]
  if (!product) throw new Error('未知商品：' + order.productId)

  const qty = Math.max(1, Number(evt.GoodsInfo && evt.GoodsInfo.Quantity) || 1)
  const users = db.collection('users')
  const user = await getUser(order._openid)
  const now = Date.now()

  if (product.monthly) {
    // 包月：仍在包月内则顺延，否则从今晚起算
    const base = user && user.monthlyUntil > now ? user.monthlyUntil : now
    const monthlyUntil = base + product.days * 86400000 * qty
    if (user) await users.doc(user._id).update({ data: { monthlyUntil } })
    else await users.add({ data: { _openid: order._openid, minutes: 0, monthlyUntil } })
  } else {
    const addMinutes = product.minutes * qty
    if (user) await users.doc(user._id).update({ data: { minutes: _.inc(addMinutes) } })
    else await users.add({ data: { _openid: order._openid, minutes: addMinutes, monthlyUntil: 0 } })
  }
}

/** 发货锁：_id = outTradeNo，add 成功才算抢到；重复推送抢不到直接回成功 */
async function acquireDeliveryLock(order) {
  const data = {
    _id: order.outTradeNo,
    outTradeNo: order.outTradeNo,
    openid: order._openid,
    productId: order.productId,
    at: db.serverDate(),
  }
  try {
    await db.collection('deliveries').add({ data })
    return true
  } catch (e) {
    const msg = String(e.message || '')
    if (/not exist|不存在|COLLECTION_NOT_EXIST/i.test(msg)) {
      await ensureCollection('deliveries')
      try { await db.collection('deliveries').add({ data }); return true } catch (e2) {
        if (/duplicate|E11000|已存在/i.test(String(e2.message || ''))) return false
        throw e2
      }
    }
    // 重复发货锁 = 已经发过；其他异常要抛出去让平台重推，不能吞掉
    if (/duplicate|E11000|已存在/i.test(msg)) return false
    throw e
  }
}

async function releaseDeliveryLock(outTradeNo) {
  try { await db.collection('deliveries').doc(outTradeNo).remove() } catch (e) { /* */ }
}

exports.main = async (event) => {
  const evt = parseEvent(event)
  const isXml = !!evt._xml
  const ok = () => isXml
    ? '<xml><ErrCode>0</ErrCode><ErrMsg><![CDATA[success]]></ErrMsg></xml>'
    : { ErrCode: 0, ErrMsg: 'success' }
  const fail = (msg) => isXml
    ? '<xml><ErrCode>1</ErrCode><ErrMsg><![CDATA[' + msg + ']]></ErrMsg></xml>'
    : { ErrCode: 1, ErrMsg: msg }

  // 非道具发货事件：记录后回成功，避免平台持续重推
  if (evt.Event && evt.Event !== 'xpay_goods_deliver_notify') {
    console.log('[onDelivered] 忽略事件', evt.Event, evt.OutTradeNo || '')
    return ok()
  }

  const outTradeNo = evt.OutTradeNo || evt.outTradeNo
  if (!outTradeNo) return fail('missing OutTradeNo')

  let order = null
  try {
    const { data } = await db.collection('orders').where({ outTradeNo }).limit(1).get()
    order = data[0] || null
  } catch (e) {
    console.error('[onDelivered] 查订单失败', e.message)
    return fail('query order failed')
  }
  if (!order) return fail('order not found')

  // 防御：推送里的 openid 必须与落单用户一致
  if (evt.OpenId && order._openid && evt.OpenId !== order._openid) {
    return fail('openid mismatch')
  }

  // 已发过货：直接回成功（重复推送）
  if (order.status === 'paid' || order.status === 'refunded') return ok()

  // 抢发货锁：并发/重复推送只有一个能发
  let locked = false
  try {
    locked = await acquireDeliveryLock(order)
  } catch (e) {
    console.error('[onDelivered] 发货锁异常', e.message)
    return fail('lock failed')
  }
  if (!locked) return ok()

  // 1) 真正发货：失败才释放锁，让平台重推
  try {
    await deliver(order, evt)
  } catch (e) {
    console.error('[onDelivered] 发货失败，释放锁等待重推', e.message)
    await releaseDeliveryLock(outTradeNo)
    return fail(e.message || 'deliver failed')
  }

  // 2) 记录订单状态：失败也不能释放锁（权益已发，释放会导致重推重复到账）
  try {
    await db.collection('orders').doc(order._id).update({
      data: {
        status: 'paid',
        paidAt: db.serverDate(),
        wxOrderId: (evt.WeChatPayInfo && evt.WeChatPayInfo.MchOrderNo) || '',
        pushPayload: evt,
      },
    })
  } catch (e) {
    console.error('[onDelivered] 权益已发但订单状态更新失败（保留发货锁）', e.message)
  }

  return ok()
}
