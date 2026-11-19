import { numOr } from './store.js'

// 提示词记录钩子（契约）
//
// 每轮真正发给模型的 content（admit 之后、宿主注入块也算）都会以事件形式交给
// 订阅者。器官/插件要留痕、做审计、统计上下文组成，都挂在这里，不要改核心链路。
//
// 事件形状（PromptEvent）：
//   chatId    string  会话标识：'owner' / 客人 id / 'system:diary' 等
//   sessionId string  DSH 会话 id（agent.session.id），拿不到时为空串
//   via       string  'chat'（一次对话轮）| 'chat-part'（连发合并里的单条，预留）| 'system-turn'（系统轮）
//   sender    string  触发这轮的用户标识，系统轮为空串
//   senders   string[] 这一轮所有参与者（主人+客人合并时 > 1）
//   role      string  通常是 'user'
//   blocks    array   实际发送的 content 数组（已 admit，可能是 [{type:'text'},…]）
//   injected  number  宿主注入块在 blocks 里的下标，-1 表示没有；目前只有身体状态块，恒为 0
//
// 订阅：hub.onPrompt(fn) → 返回取消订阅函数。fn 可以是 async；抛错/拒绝只记一条
// 警告，不影响回复链路。没有订阅者时 emit 是空操作（默认什么都不做）。

const MAX_WARN_MS = 60_000

export function createPromptSink({ log = console } = {}) {
  const listeners = new Set()
  let lastWarnAt = 0

  const warn = (e) => {
    const now = Date.now()
    if (now - lastWarnAt < MAX_WARN_MS) return
    lastWarnAt = now
    try { log.warn?.('提示词记录钩子出错（60s 内只报一次）：' + (e?.message || e)) } catch { /* 日志坏了也不能影响对话 */ }
  }

  // 把外部传进来的事件收敛成契约形状：字段缺失给默认值，blocks 一定是数组。
  function normalize(event = {}) {
    const blocks = Array.isArray(event.blocks) ? event.blocks : []
    return {
      chatId: String(event.chatId || ''),
      sessionId: String(event.sessionId || ''),
      via: String(event.via || 'chat'),
      sender: String(event.sender || ''),
      senders: Array.isArray(event.senders) ? event.senders.map(String) : (event.sender ? [String(event.sender)] : []),
      role: String(event.role || 'user'),
      blocks,
      injected: Number.isFinite(Number(event.injected)) ? Number(event.injected) : -1,
    }
  }

  return {
    // 注册记录器，返回取消订阅函数。传函数以外的东西直接拒绝，免得静默挂了个空的。
    register(fn) {
      if (typeof fn !== 'function') throw new TypeError('onPrompt 只接受函数')
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    // 发射：不等待、不阻塞回复；订阅者各自 try/catch，互不影响。
    emit(event) {
      if (!listeners.size) return
      const rec = normalize(event)
      for (const fn of [...listeners]) {
        try {
          const out = fn(rec)
          if (out && typeof out.then === 'function') out.catch(warn)
        } catch (e) { warn(e) }
      }
    },
    // 当前订阅者数量（调试/测试用）
    get size() { return listeners.size },
    // 内部测试用：清空订阅者
    clear() { listeners.clear() },
  }
}

// 给记录器用的小工具：把一次事件的块压成可落盘的摘要行，避免把整段 base64 写进日志。
// 返回 [{i,type,len,bytes,injected}]，正文本身不复制。
export function describeBlocks(event) {
  const injected = numOr(event.injected, -1)
  return (event.blocks || []).map((b, i) => {
    const type = String(b?.type || 'unknown')
    const text = typeof b?.text === 'string' ? b.text : ''
    const data = typeof b?.data === 'string' ? b.data : (typeof b?.source?.data === 'string' ? b.source.data : '')
    const bytes = numOr(b?.bytes, 0) || (data ? Math.floor(data.length * 3 / 4) : 0) || Buffer.byteLength(text)
    return { i, type, len: text.length || data.length, bytes, injected: i === injected }
  })
}