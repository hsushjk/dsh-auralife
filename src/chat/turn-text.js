// chat/turn-text.js — 按轮号暂存本轮最终文本。
//
// 不能只用 st.lastTurn === d.turn 判空轮：轮号对不上（事件乱序、晚到的 turn/end）
// 时会把「这一轮其实有话」误判成空轮，白退一半体力。这里按轮号存文本，
// turn/end 只认自己那一轮；同时只留最近十几轮，避免长会话一直涨。

const KEEP = 12

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

// 同一轮只记一次扣费、只结一次账。turn/end 重复到达时，第二轮不会再退一份体力。
const KEEP_TURNS = 24

function pruneSet(set) {
  if (!(set instanceof Set)) return
  if (set.size > KEEP_TURNS) { for (const k of set) { set.delete(k); break } }
}

// 轮号只在「开新轮」时推进；轮号变小说明会话重建/进程重启后重新编号，旧的记账作废。
function noteNewTurn(state, turn) {
  const t = turn === undefined || turn === null || turn === '' ? null : Number(turn)
  if (t === null || !Number.isFinite(t)) return null
  const last = Number(state.lastTurnNo)
  if (Number.isFinite(last) && t < last) {
    state.chargedTurns = new Set()
    state.settledTurns = new Set()
    state.pendingCharge = 0
  }
  state.lastTurnNo = t
  return t
}

export function chargeTurn(state, turn) {
  const t = noteNewTurn(state, turn)
  if (t === null) {
    state.pendingCharge = (Number(state.pendingCharge) || 0) + 1
    return true
  }
  if (!(state.chargedTurns instanceof Set)) state.chargedTurns = new Set()
  if (state.chargedTurns.has(t)) return false
  state.chargedTurns.add(t)
  pruneSet(state.chargedTurns)
  return true
}

// 结清这一轮的扣费（不管退不退）。返回「这轮确实扣过费吗」。
// 没有轮号的老格式按扣费次数配对：重复的 turn/end 会因没有余额而退不出第二份。
export function settleTurnCharge(state, turn) {
  const t = turn === undefined || turn === null || turn === '' ? null : Number(turn)
  if (t === null || !Number.isFinite(t)) {
    const pending = Number(state.pendingCharge) || 0
    if (pending <= 0) return false
    state.pendingCharge = pending - 1
    return true
  }
  if (!(state.chargedTurns instanceof Set) || !state.chargedTurns.has(t)) return false
  state.chargedTurns.delete(t)
  return true
}

// 标记这一轮已经结束过；重复的 turn/end 直接忽略。
export function markSettledTurn(state, turn) {
  const t = turn === undefined || turn === null || turn === '' ? null : Number(turn)
  if (t === null || !Number.isFinite(t)) return true
  if (!(state.settledTurns instanceof Set)) state.settledTurns = new Set()
  if (state.settledTurns.has(t)) return false
  state.settledTurns.add(t)
  pruneSet(state.settledTurns)
  return true
}

export function takeTurnText(map, turn) {
  const key = keyOf(turn)
  if (!(map instanceof Map) || key === null) return ''
  const text = map.get(key) || ''
  map.delete(key)
  return text
}