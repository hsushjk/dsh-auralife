// 器官 worker（organ-worker）：self-made 器官的唯一运行环境。
//
// 为什么单独开线程：
// - 器官是 LLM 写的代码，可能写出死循环、process.exit、爆内存——放在宿主线程里会拖死整个 DSH 插件；
// - 放进 worker 后，同步死循环只会阻塞这个 worker，宿主用加载/调用超时兜底并 terminate；
// - worker 作用域里仍然有 process/fs（Node 没有真正的内存沙箱），所以真正的约束来自：
//   guardOrgan 静态闸 + 本文件注入的白名单 api + 宿主侧 SSRF 过滤 + 动作审计。
//
// 协议：worker → 宿主 {type:'rpc', organ, callId, method, args}；宿主 → worker {type:'rpcResult', callId, ok, value|error}
import { parentPort, workerData } from 'node:worker_threads'

const { url, id } = workerData

/** 器官实例（create(api) 的返回值） */
let instance = null
/** name → execute 函数；函数不能序列化，只能留在 worker 里供宿主通过 toolCall 触发 */
const toolExecs = new Map()
/** 给宿主的可序列化工具描述 */
const toolDescs = []

const pending = new Map()
let rpcSeq = 0

function rpc(method, args) {
  return new Promise((resolve, reject) => {
    const callId = ++rpcSeq
    pending.set(callId, { resolve, reject })
    try {
      parentPort.postMessage({ type: 'rpc', organ: id, callId, method, args })
    } catch (error) {
      pending.delete(callId)
      reject(error)
    }
  })
}

function makeLogger(prefix) {
  const emit = (level, args) => {
    const message = args
      .map((a) => {
        if (typeof a === 'string') return a
        try { return JSON.stringify(a) } catch { return String(a) }
      })
      .join(' ')
    // 日志走 RPC 回宿主，不阻塞器官；失败就算了
    rpc('log', { level, message: `${prefix} ${message}`.trim() }).catch(() => {})
  }
  return {
    info: (...a) => emit('info', a),
    warn: (...a) => emit('warn', a),
    error: (...a) => emit('error', a),
    debug: (...a) => emit('debug', a),
    child: (name) => makeLogger(`${prefix}[${name}]`),
  }
}

const api = {
  log: makeLogger(`[organ:${id}]`),
  net: {
    fetchText: (url, opts) => rpc('net.fetchText', { url, opts }),
    fetchJson: (url, opts) => rpc('net.fetchJson', { url, opts }),
  },
  store: {
    get: (key, fallback) => rpc('store.get', { key, fallback }),
    set: (key, value) => rpc('store.set', { key, value }),
  },
  llm: {
    ask: (prompt, opts) => rpc('llm.ask', { prompt, opts }),
  },
  tools: {
    add(def) {
      if (!def || typeof def !== 'object') return null
      const name = String(def.name || '').trim()
      if (!name) return null
      if (typeof def.execute === 'function') toolExecs.set(name, def.execute)
      toolDescs.push({
        name,
        description: String(def.description || ''),
        properties: (def.properties && typeof def.properties === 'object') ? def.properties : {},
        required: Array.isArray(def.required) ? def.required : [],
      })
      return name
    },
  },
}

const reply = (payload) => {
  try { parentPort.postMessage(payload) } catch { /* 宿主已退出 */ }
}

try {
  const mod = await import(url)
  if (!mod.meta || !mod.meta.id) throw new Error('缺少 export const meta = { id }')
  if (typeof mod.create !== 'function') throw new Error('缺少 export function create(api)')
  instance = await mod.create(api)
  if (!instance || typeof instance !== 'object') throw new Error('create(api) 没有返回对象')
  reply({
    type: 'ready',
    meta: mod.meta,
    tools: toolDescs,
    contextLine: typeof instance.contextLine === 'function' ? String(instance.contextLine() || '') : '',
  })
} catch (error) {
  reply({ type: 'initError', error: String(error?.message || error) })
}

parentPort.on('message', async (msg) => {
  if (!msg || typeof msg !== 'object') return

  if (msg.type === 'rpcResult') {
    const p = pending.get(msg.callId)
    if (!p) return
    pending.delete(msg.callId)
    if (msg.ok) p.resolve(msg.value)
    else p.reject(new Error(String(msg.error || '宿主 RPC 失败')))
    return
  }

  if (msg.type === 'tick') {
    try {
      if (!instance || typeof instance.tick !== 'function') throw new Error('这个器官没有 tick()')
      const value = await instance.tick()
      const contextLine = typeof instance.contextLine === 'function' ? String(instance.contextLine() || '') : ''
      reply({ type: 'tickResult', callId: msg.callId, ok: true, value: value === undefined ? null : value, contextLine })
    } catch (error) {
      reply({ type: 'tickResult', callId: msg.callId, ok: false, error: String(error?.message || error) })
    }
    return
  }

  if (msg.type === 'toolCall') {
    try {
      const exec = toolExecs.get(msg.name)
      if (typeof exec !== 'function') throw new Error(`器官没有注册工具 ${msg.name}`)
      const value = await exec(msg.args || {})
      let safe
      try { safe = JSON.parse(JSON.stringify(value ?? null)) } catch { safe = String(value) }
      reply({ type: 'toolResult', callId: msg.callId, ok: true, value: safe })
    } catch (error) {
      reply({ type: 'toolResult', callId: msg.callId, ok: false, error: String(error?.message || error) })
    }
    return
  }

  if (msg.type === 'shutdown') process.exit(0)
})