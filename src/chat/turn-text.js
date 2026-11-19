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

// 同一轮最多退一次体力。turn/end 重复到达（或同一轮被结束两次）时，
// 第二次会因为没有文本落进「空轮退款」分支——不退重就会白退，比误判还亏。
// 没有轮号的老格式没法按轮去重，直接放行（保持旧行为）。
export function claimTurnRefund(state, turn) {
  if (turn === undefined || turn === null || turn === '') return true
  if (!(state.refundedTurns instanceof Set)) state.refundedTurns = new Set()
  if (state.refundedTurns.has(turn)) return false
  state.refundedTurns.add(turn)
  if (state.refundedTurns.size > 24) {
    for (const k of state.refundedTurns) { state.refundedTurns.delete(k); break }
  }
  return true
}

export function takeTurnText(map, turn) {
  const key = keyOf(turn)
  if (!(map instanceof Map) || key === null) return ''
  const text = map.get(key) || ''
  map.delete(key)
  return text
}