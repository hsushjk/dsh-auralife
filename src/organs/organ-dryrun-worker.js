// 器官干跑 worker（organ-dryrun-worker）：验证 LLM 生成的器官代码能加载、能 create、
// 能注册至少一个带 name/execute 的工具——但全程在独立线程里跑，超时/死循环/process.exit
// 只杀这个 worker，不会卡住宿主。
//
// 注意：干跑只是「能不能装」的快速验证；安全检查以 guardOrgan + 正式运行时的 worker 隔离为准。
import { parentPort, workerData } from 'node:worker_threads'

const registered = []

const stub = {
  log: { info() {}, warn() {}, error() {}, debug() {}, child() { return this } },
  net: { fetchText: async () => '', fetchJson: async () => ({}) },
  store: { get: () => null, set: async () => {} },
  llm: { ask: async () => '' },
  tools: {
    add(def) {
      if (!def || typeof def !== 'object') return null
      registered.push({ name: String(def.name || ''), hasExecute: typeof def.execute === 'function' })
      return def.name
    },
  },
}

try {
  const url = 'data:text/javascript;charset=utf-8,' + encodeURIComponent(workerData.code) + '#' + Date.now()
  const mod = await import(url)
  if (!mod.meta || !mod.meta.id) throw new Error('缺少 export const meta = { id }')
  if (typeof mod.create !== 'function') throw new Error('缺少 export function create(api)')
  const inst = await mod.create(stub)
  if (!inst || typeof inst !== 'object') throw new Error('create(api) 没有返回对象')
  if (!registered.length) throw new Error('create(api) 里没有调用 api.tools.add 注册任何工具——AI 调不到这个能力，器官等于不存在')
  for (const def of registered) {
    if (!def.name) throw new Error('api.tools.add 的工具缺 name')
    if (!def.hasExecute) throw new Error(`工具 ${def.name} 缺 execute 函数`)
  }
  parentPort.postMessage({ type: 'ok', tools: registered.map((d) => d.name) })
} catch (error) {
  parentPort.postMessage({ type: 'fail', error: String(error?.message || error) })
}