// 格式化工具

/** 秒 → "4 分 12 秒" */
function fmtDurationChinese(sec) {
  const s = Math.round(sec)
  const m = Math.floor(s / 60)
  const r = s % 60
  if (m === 0) return r + ' 秒'
  return m + ' 分 ' + r + ' 秒'
}

/** 半音数 → 专业文案："升 2 个半音" / "降 1 个半音" / "原调"（用户懂音乐，术语直接用半音） */
function fmtPitchLabel(semitones) {
  if (semitones > 0) return '升 ' + semitones + ' 个半音'
  if (semitones < 0) return '降 ' + (-semitones) + ' 个半音'
  return '原调'
}

/** 分 → "0.4" 元字符串 */
function fmtFenToYuan(fen) {
  return (fen / 100).toFixed(fen % 10 === 0 ? 1 : 2).replace(/\.0$/, '')
}

/** 文件名 → 安全基础名（去扩展名、去非法字符、限长） */
function safeBaseName(name) {
  let n = String(name || '音乐')
  n = n.replace(/\.[^.]+$/, '')            // 去扩展名
  n = n.replace(/[\\/:*?"<>|\s]+/g, '')     // 非法字符
  n = n.slice(0, 24)                        // 限长
  return n || '音乐'
}

/** 时间戳 → "10-06 21:30"（历史记录/管理页用） */
function fmtDateTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  const p2 = n => String(n).padStart(2, '0')
  return p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes())
}

module.exports = { fmtDurationChinese, fmtPitchLabel, fmtFenToYuan, safeBaseName, fmtDateTime }
