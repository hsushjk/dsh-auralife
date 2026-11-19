// chat/turn-text.js — 按轮号暂存本轮最终文本、结清每轮体力扣费。
//
// 区分两个「轮号」变量，别混用：
//   st.lastTurn     —— 最近一次有文本的轮，只做旧逻辑兜底；
//   ledger.lastTurnNo —— 最后见到的轮号，只给「轮号回绕」判断用。
// 正常乱序时两者可以不相等；拿 st.lastTurn 判回绕会把乱序当成重编号，账被清空却不报错。

const KEEP = 12
const KEEP_LEDGER = 24
// 没有轮号的旧格式无法精确配对：只留最近几笔，并在 30 分钟后作废。
// 插件 dispose、进程被杀留下的残值不能无限期保留，否则下一个真实 turn/end 会把它捡走白退一半。
// 代价是跑超 30 分钟的无轮号轮会一起被当残值清掉（那一轮扣满不退）；
// 这是有意的保守方向：宁可少退，也不给后来的 turn/end 白退的机会。
const PENDING_TTL_MS = 30 * 60_000
const PENDING_MAX = 4

export function initTurnText() {
  return new Map()
}

function keyOf(turn) {
  return turn === undefined || turn === null || turn === '' ? null : turn
}

export function rememberTurnText(map, turn, text) {
  const key = keyOf(turn)
  if (!(map instanceof Map) || !text || key === null) return
  map.set(key, text)
  // 只留最近 KEEP 轮：新轮插进来后清掉最老的别的轮（当前这轮永远保留）。
  if (map.size > KEEP) {
    for (const k of map.keys()) {
      if (k !== key) { map.delete(k); break }
    }
  }
}

// ---- 体力扣费账本 ----
export function initTurnLedger() {
  return { lastTurnNo: null, chargedTurns: new Set(), settledTurns: new Set(), pendingCharges: [] }
}

function pruneSet(set) {
  if (!(set instanceof Set)) return
  if (set.size > KEEP_LEDGER) { for (const k of set) { set.delete(k); break } }
}

function prunePending(ledger, now) {
  if (!Array.isArray(ledger.pendingCharges)) ledger.pendingCharges = []
  const list = ledger.pendingCharges
  const cutoff = now - PENDING_TTL_MS
  while (list.length && !(Number(list[0]) >= cutoff)) list.shift()
  return list
}

// 轮号只在「开新轮」时推进；轮号变小说明会话重建/进程重启后重新编号，旧的记账作废。
function noteNewTurn(ledger, turn) {
  const raw = turn === undefined || turn === null || turn === '' ? null : Number(turn)
  if (raw === null || !Number.isFinite(raw)) return null
  const last = Number(ledger.lastTurnNo)
  if (Number.isFinite(last) && raw < last) {
    ledger.chargedTurns = new Set()
    ledger.settledTurns = new Set()
    ledger.pendingCharges = []
  }
  ledger.lastTurnNo = raw
  return raw
}

export function chargeTurn(ledger, turn, now = Date.now()) {
  if (!ledger || typeof ledger !== 'object') return false
  const t = noteNewTurn(ledger, turn)
  if (t === null) {
    const list = prunePending(ledger, now)
    list.push(now)
    while (list.length > PENDING_MAX) list.shift()
    return true
  }
  if (!(ledger.chargedTurns instanceof Set)) ledger.chargedTurns = new Set()
  if (ledger.chargedTurns.has(t)) return false
  ledger.chargedTurns.add(t)
  pruneSet(ledger.chargedTurns)
  return true
}

// 结清这一轮的扣费（不管退不退）。返回「这轮确实扣过费吗」。
// 无轮号时按带时效的扣费队列配对：重复 turn/end 与过期残值都退不出第二份。
export function settleTurnCharge(ledger, turn, now = Date.now()) {
  if (!ledger || typeof ledger !== 'object') return false
  const raw = turn === undefined || turn === null || turn === '' ? null : Number(turn)
  if (raw === null || !Number.isFinite(raw)) {
    const list = prunePending(ledger, now)
    if (!list.length) return false
    list.shift()
    return true
  }
  if (!(ledger.chargedTurns instanceof Set) || !ledger.chargedTurns.has(raw)) return false
  ledger.chargedTurns.delete(raw)
  return true
}

// 标记这一轮已经结束过；重复的 turn/end 直接忽略。
export function markSettledTurn(ledger, turn) {
  if (!ledger || typeof ledger !== 'object') return true
  const raw = turn === undefined || turn === null || turn === '' ? null : Number(turn)
  if (raw === null || !Number.isFinite(raw)) return true
  if (!(ledger.settledTurns instanceof Set)) ledger.settledTurns = new Set()
  if (ledger.settledTurns.has(raw)) return false
  ledger.settledTurns.add(raw)
  pruneSet(ledger.settledTurns)
  return true
}

export function takeTurnText(map, turn) {
  const key = keyOf(turn)
  if (!(map instanceof Map) || key === null) return ''
  const text = map.get(key) || ''
  map.delete(key)
  return text
}