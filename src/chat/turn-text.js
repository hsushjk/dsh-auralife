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

export function takeTurnText(map, turn) {
  const key = keyOf(turn)
  if (!(map instanceof Map) || key === null) return ''
  const text = map.get(key) || ''
  map.delete(key)
  return text
}