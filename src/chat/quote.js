// chat/quote.js — 引用（quote）快照。
// 消息上的 quote 只是一份快照：{ id, who, text, at, kind }。显示不依赖原消息还在，
// 翻到旧分片里也能看清「在回哪句」；模型侧拿到的是同一份文本。
//
// 安全边界：快照是客户端提交的，不能直接信（客人可以伪造一份
// 「你之前说过的话」写进历史，还会被抽成记忆）。落盘/进模型前，
// 一律用 history.findById 查到真实消息，再用真实内容重建快照；
// 查不到就丢掉这条引用。

export function quoteTextOf(m) {
  if (!m) return ''
  if (m.kind === 'voice') return m.heard ? `[语音] ${m.heard}` : String(m.text || '[语音]')
  if (m.kind === 'image') return '[图片]'
  if (m.kind === 'sticker') return m.name ? `[表情 ${m.name}]` : '[表情]'
  if (m.kind === 'file') return `[文件] ${m.fileName || ''}`.trim()
  return String(m.text || '').slice(0, 300)
}

export function quoteOfMessage(m) {
  if (!m || !m.id) return null
  const text = quoteTextOf(m)
  if (!text) return null
  return { id: String(m.id), who: m.who === 'bot' ? 'bot' : 'user', text, at: Number(m.t) || 0, kind: m.kind || 'text' }
}

// 只从客户端快照里取 id；text/who/kind 一律以服务端历史为准。
export function cleanQuoteRef(q) {
  if (!q || typeof q !== 'object') return null
  const id = String(q.id || '').trim().slice(0, 80)
  if (id.length < 6) return null
  return { id }
}

// 用真实消息重建引用快照；查不到返回 null（调用方当作没引用）。
export function resolveQuote(history, chatId, q) {
  const ref = cleanQuoteRef(q)
  if (!ref) return null
  let found = null
  try { found = history?.findById?.(chatId, ref.id) || null } catch { found = null }
  return found ? quoteOfMessage(found) : null
}