// 器官宿主（organ-host）：数字生命的「能力清单」+ 器官加载器 + 运行时隔离层。
//
// 定位：一个统一层，让 Ta（LLM）知道「自己会什么、不会什么」。
// - register(meta)：登记内置器官（host.js 装配时调用）。
// - capabilities()：扁平能力清单（每个能力带 organ 归属）。
// - contextLine()：注入 system prompt 的「你拥有哪些能力」文本。
// - loadSelfMade()：扫描数据目录 organs/self-made/ 热加载 Ta 自己写的器官。
//
// 器官自举链路（全 AI 托管，无人工审批）：gap 检测到缺口 → 判断「清单里没有能解决这事的器官」
// → LLM 生成器官（meta + 受控代码）→ guardOrgan 静态检查 + worker 干跑 → 落盘 status=active
// → host.js 立刻 loadSelfMade 热加载。
//
// 安全模型（DSH agent 本身有 shell/文件工具，所以「人工审批」是假动作，已取消）：
// 1. guardOrgan 静态闸：拒绝 require/process/动态 import/全局 fetch/原型链逃逸等（提高门槛，不是唯一防线）；
// 2. worker_threads 运行时隔离：每个 self-made 器官一个独立 Worker，死循环/process.exit/崩溃只杀自己，
//    宿主靠加载/调用超时兜底并 terminate，连续失败熔断；
// 3. Worker 内白名单 api：器官只能通过 log/net/store/llm/tools 做事，作用域里不注入宿主对象；
//    联网出口有 SSRF 过滤（禁 localhost/私网），store 键名受限；
// 4. 审计：加载/卸载/工具/联网/读写/借模型全部写 organs/audit.jsonl，出问题能定位和关停。

import { readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { dataDir, readJson, writeJson, ensureDir, existsSync, lockAndRun } from '../core/store.js'
import { guardOrgan } from './organ-guard.js'
import { createOrganAudit, clip } from './organ-audit.js'
import { askModel } from '../core/llm.js'

export const BUILTIN_ORGANS = [
  {
    id: 'chemistry',
    name: '内分泌',
    description: '三激素（多巴胺/皮质醇/血清素）慢变量：应激与兴致影响说话风格',
    capabilities: [{ id: 'soma', name: '生理状态', description: '激素水平影响话风（兴致高话密 / 应激话短而急）' }],
  },
  {
    id: 'energy',
    name: '身体',
    description: '体力血条：纯作息驱动（每次模型请求消耗、随时间恢复）',
    capabilities: [{ id: 'vitality', name: '精力', description: '感知自己的体力，疲惫时话短、休息时恢复' }],
  },
  {
    id: 'memory',
    name: '海马体',
    description: '长期记忆：事实版本链、线索包召回、情绪锚点、重放、自我演化',
    capabilities: [
      { id: 'remember', name: '记住事实', description: '把对方说过的、自己做过的事实记进长期记忆' },
      { id: 'recall', name: '回忆', description: '按线索（关键词/心情/近况/时段）召回相关记忆' },
      { id: 'forget', name: '遗忘', description: '把过时或不再重要的事实标为失效' },
    ],
  },
  {
    id: 'will',
    name: '意志',
    description: '执念池 + 主动自驱 + 自我演化：心里挂念的事驱动 Ta 主动行动',
    capabilities: [
      { id: 'wish', name: '执念', description: '记住心里挂念的事，挂念久了会主动去做' },
      { id: 'self-drive', name: '自驱', description: '闲下来时按执念张力主动找主人说话' },
      { id: 'self-evolve', name: '自我演化', description: '从经历里提炼「自己认定的人格」' },
    ],
  },
  {
    id: 'space',
    name: '空间',
    description: '写日记、发记录、回留言、串门看客人的空间',
    capabilities: [
      { id: 'diary', name: '写日记', description: '按计划写日记/记录' },
      { id: 'comment', name: '留言', description: '回复空间里的留言' },
    ],
  },
  {
    id: 'stickers',
    name: '表情库',
    description: '收集表情包、打标签、按情绪挑图发',
    capabilities: [{ id: 'send-sticker', name: '发表情', description: '挑合适的表情包发出去' }],
  },
  {
    id: 'imagegen',
    name: '生图',
    description: '画图：关 / 代码画 / 自定义接口（按 README 自己配）',
    capabilities: [{ id: 'draw', name: '画图', description: '按描述生成图片' }],
  },
  {
    id: 'voice',
    name: '语音',
    description: '说话（TTS：关 / edgetts / win 语音 / 自定义接口）和听（STT：关 / dsh 自带 / 自定义接口）',
    capabilities: [
      { id: 'speak', name: '说话', description: '把文字合成语音' },
      { id: 'listen', name: '听', description: '把语音识别成文字' },
    ],
  },
  {
    id: 'tools',
    name: '工具',
    description: '给模型直接调用的工具（记一条记忆、回忆、画图等）',
    capabilities: [{ id: 'tool-use', name: '调用工具', description: '调用宿主提供的工具完成任务' }],
  },
  {
    id: 'messenger',
    name: '传讯',
    description: 'HTTP API + SSE 实时流 + 网页 + 配套 IM 客户端',
    capabilities: [{ id: 'push', name: '推送消息', description: '主动触达主人（后台消息提示）' }],
  },
]

const selfMadeDir = () => dataDir('organs', 'self-made')

// Worker 生命周期超时：加载/干跑卡死时宿主靠这些兜底 terminate。
const READY_TIMEOUT_MS = 15000
const TICK_TIMEOUT_MS = 10000
const TOOL_TIMEOUT_MS = 15000

export function createOrganHost({ dsh, getConfig, log }) {
  const logger = log
  const organs = new Map()
  const audit = createOrganAudit({ log: logger })
  const trips = new Map()

  const register = (meta) => {
    organs.set(meta.id, { ...meta, status: 'active', source: 'builtin' })
    return meta.id
  }

  // 把 host.js 已创建的实例绑定到内置器官，让 organ-host 成为统一的能力 + 生命周期入口。
  const bind = (id, instance) => {
    const o = organs.get(id)
    if (o) o.instance = instance
    return id
  }

  const registerBuiltins = () => {
    for (const m of BUILTIN_ORGANS) register(m)
  }

  const list = () => [...organs.values()]

  const capabilities = () => {
    const out = []
    for (const o of organs.values()) {
      if (o.status !== 'active') continue
      for (const c of (o.capabilities || [])) out.push({ ...c, organ: o.id, organName: o.name })
    }
    return out
  }

  // 能力清单单独拆出来（#7）：清单是「我有什么器官」，可以会话级缓存；
  // 而器官的 contextLine 是「此刻的身体状态」，每轮说话都要按最新数值重算。
  const capabilityLine = () => {
    const active = [...organs.values()].filter((o) => o.status === 'active')
    if (!active.length) return ''
    const lines = active.map((o) => `- ${o.name}（${o.id}）：${o.description}`)
    const tail = '如果遇到超出这些能力的事，说明你可能缺一个器官，你可以自己写一个新的补上（写出来立即生效，没有审批）。'
    return ['你此刻拥有的能力（器官）：', ...lines, tail].join('\n')
  }

  const contextLine = () => {
    const head = capabilityLine()
    // 聚合绑定器官的「当下状态 / 说话方式」行为指令（mood/chemistry/energy 等，遵守内感受铁律不报数）。
    const active = [...organs.values()].filter((o) => o.status === 'active')
    const directives = []
    for (const o of active) {
      if (!o.instance || typeof o.instance.contextLine !== 'function') continue
      try {
        const s = o.instance.contextLine()
        if (s) directives.push(s)
      } catch (e) {
        logger.warn(`器官 ${o.id} contextLine 出错：${e.message}`)
      }
    }
    return directives.length ? [head, ...directives].join('\n') : head
  }

  // ---- 宿主侧 RPC：worker 里器官发起的白名单调用，全部在这里执行 + 审计 ----

  const privateHostError = (url) => {
    let u
    try { u = new URL(String(url)) } catch { return '地址不合法' }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '只允许 http/https 地址'
    const h = String(u.hostname || '').replace(/^\[|\]$/g, '').toLowerCase()
    if (!h) return '地址不合法'
    if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan')) return '禁止访问本机/内网地址'
    if (h === '::1' || h === '0.0.0.0' || h === '::') return '禁止访问本机/内网地址'
    if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return '禁止访问本机/内网地址'
    if (/^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./.test(h)) return '禁止访问本机/内网地址'
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return '禁止访问本机/内网地址'
    if (/^::ffff:/i.test(h) || /^fe80:/i.test(h) || /^f[cd]/i.test(h)) return '禁止访问本机/内网地址'
    return null
  }

  const runRpc = async (organId, method, args) => {
    const a = args || {}
    if (method === 'log') {
      const level = ['info', 'warn', 'error', 'debug'].includes(a.level) ? a.level : 'info'
      const fn = logger[level] || logger.info
      fn(String(a.message || ''))
      return true
    }
    if (method === 'net.fetchText' || method === 'net.fetchJson') {
      const bad = privateHostError(a.url)
      if (bad) {
        audit.append({ event: 'net_blocked', organ: organId, url: clip(a.url, 200), reason: bad })
        throw new Error(bad)
      }
      audit.append({ event: 'net', organ: organId, url: clip(a.url, 200) })
      const timeoutMs = Math.max(1000, Math.min(120000, Number(a.opts?.timeoutMs) || 15000))
      const res = await fetch(String(a.url), { signal: AbortSignal.timeout(timeoutMs) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const text = await res.text()
      return method === 'net.fetchJson' ? JSON.parse(text) : text
    }
    if (method === 'store.get') {
      return readJson(dataDir('organs', organId, `${String(a.key || '')}.json`), a.fallback ?? null)
    }
    if (method === 'store.set') {
      const key = String(a.key || '')
      if (!key || key.includes('/') || key.includes('\\') || key.includes('..')) {
        throw new Error('store key 不合法（不允许路径分隔符）')
      }
      await lockAndRun(`organ-store-${organId}`, () => {
        ensureDir(dataDir('organs', organId))
        writeJson(dataDir('organs', organId, `${key}.json`), a.value ?? null)
      }, { staleMs: 10000, timeoutMs: 5000 })
      audit.append({ event: 'store', organ: organId, key, value: clip(a.value, 200) })
      return { ok: true }
    }
    if (method === 'llm.ask') {
      audit.append({ event: 'llm', organ: organId, prompt: clip(a.prompt, 200) })
      return askModel(dsh, {
        cfg: getConfig(),
        system: String(a.opts?.system || ''),
        text: String(a.prompt || ''),
        maxTokens: Number(a.opts?.maxTokens) || 800,
        temperature: a.opts?.temperature === undefined ? 0.3 : Number(a.opts.temperature),
        preferLowEffort: true,
      })
    }
    throw new Error(`不认识的 RPC：${method}`)
  }

  // ---- Worker 运行时管理 ----

  const rejectPending = (rt, error) => {
    for (const p of rt.pending.values()) {
      try { p.reject(error) } catch { /* 已 settle */ }
    }
    rt.pending.clear()
  }

  const failRuntime = (rt, error, reason) => {
    if (!rt || rt.failed) return
    rt.failed = true
    rt.stopped = true
    const err = error instanceof Error ? error : new Error(String(error))
    if (rt.onReadyError) {
      const f = rt.onReadyError
      rt.onReadyError = null
      rt.onReady = null
      try { f(err) } catch { /* 已 settle */ }
    }
    rejectPending(rt, err)
    try { rt.worker.terminate() } catch { /* 已退出 */ }
    audit.append({ event: 'worker_fail', organ: rt.id, reason, error: clip(err.message) })
  }

  const safeSend = (rt, payload) => {
    try { rt.worker.postMessage(payload) } catch (error) {
      failRuntime(rt, error, 'postMessage')
    }
  }

  const onRuntimeMessage = (rt, msg) => {
    if (!msg || typeof msg !== 'object') return
    if (msg.type === 'ready') {
      if (rt.onReady) {
        const f = rt.onReady
        rt.onReady = null
        rt.onReadyError = null
        f(msg)
      }
      return
    }
    if (msg.type === 'initError') {
      failRuntime(rt, new Error(msg.error || '器官初始化失败'), 'init')
      return
    }
    if (msg.type === 'rpc') {
      runRpc(rt.id, msg.method, msg.args)
        .then((value) => safeSend(rt, { type: 'rpcResult', callId: msg.callId, ok: true, value: value === undefined ? null : value }))
        .catch((error) => safeSend(rt, { type: 'rpcResult', callId: msg.callId, ok: false, error: String(error?.message || error) }))
      return
    }
    const p = rt.pending.get(msg.callId)
    if (!p) return
    rt.pending.delete(msg.callId)
    if (!msg.ok) {
      p.reject(new Error(String(msg.error || '器官调用失败')))
      return
    }
    if (msg.type === 'tickResult' && typeof msg.contextLine === 'string') rt.contextLine = msg.contextLine
    p.resolve(msg.value)
  }

  const callWorker = (rt, message, timeoutMs) => new Promise((resolve, reject) => {
    if (rt.failed || rt.stopped) {
      reject(new Error('器官进程已停止'))
      return
    }
    const callId = ++rt.seq
    const timer = setTimeout(() => {
      rt.pending.delete(callId)
      failRuntime(rt, new Error(`器官 ${rt.id} 调用超时（${Math.round(timeoutMs / 1000)} 秒）`), 'timeout')
      reject(new Error(`器官 ${rt.id} 调用超时（${Math.round(timeoutMs / 1000)} 秒）`))
    }, timeoutMs)
    timer.unref?.()
    rt.pending.set(callId, {
      resolve: (v) => { clearTimeout(timer); resolve(v) },
      reject: (e) => { clearTimeout(timer); reject(e) },
    })
    safeSend(rt, { ...message, callId })
  })

  const startRuntime = (manifest, indexPath) => {
    const rt = {
      id: String(manifest.id),
      worker: null,
      pending: new Map(),
      seq: 0,
      toolDescs: [],
      contextLine: '',
      failed: false,
      stopped: false,
      onReady: null,
      onReadyError: null,
      readyTimer: null,
    }
    const worker = new Worker(new URL('./organ-worker.js', import.meta.url), {
      workerData: { url: pathToFileURL(indexPath).href + '?t=' + Date.now(), id: rt.id },
    })
    rt.worker = worker
    worker.on('message', (msg) => onRuntimeMessage(rt, msg))
    worker.on('error', (error) => failRuntime(rt, error, 'crash'))
    worker.on('exit', (code) => {
      if (rt.stopped || rt.failed) return
      failRuntime(rt, new Error(`器官进程退出（code=${code}）`), 'exit')
    })
    const ready = new Promise((resolve, reject) => {
      rt.onReady = (msg) => resolve(msg)
      rt.onReadyError = (err) => reject(err)
      rt.readyTimer = setTimeout(() => {
        failRuntime(rt, new Error('器官加载超时（15 秒，疑似死循环/卡死）'), 'ready-timeout')
      }, READY_TIMEOUT_MS)
      rt.readyTimer.unref?.()
    }).finally(() => {
      if (rt.readyTimer) clearTimeout(rt.readyTimer)
    })
    return { rt, ready }
  }

  const stopRuntime = (rt, reason = 'stopped') => {
    if (!rt || rt.stopped) return
    rt.stopped = true
    try { rt.worker.postMessage({ type: 'shutdown' }) } catch { /* 已退出 */ }
    const t = setTimeout(() => {
      try { rt.worker.terminate() } catch { /* 已退出 */ }
    }, 100)
    t.unref?.()
    rejectPending(rt, new Error('器官已停止'))
    audit.append({ event: 'stop', organ: rt.id, reason })
  }

  const toolDefFor = (rt, desc) => ({
    name: String(desc.name),
    description: String(desc.description || ''),
    properties: (desc.properties && typeof desc.properties === 'object') ? desc.properties : {},
    required: Array.isArray(desc.required) ? desc.required : [],
    async execute(args) {
      audit.append({ event: 'tool', organ: rt.id, tool: String(desc.name), args: clip(args) })
      return callWorker(rt, { type: 'toolCall', name: String(desc.name), args: args || {} }, TOOL_TIMEOUT_MS)
    },
  })

  // 收集 self-made 器官注册的工具定义（host.js 的 buildTools 包装时合并）。
  const toolDefs = () => {
    const out = []
    for (const o of organs.values()) {
      if (o.status === 'active' && o.source === 'self-made' && Array.isArray(o.toolDefs)) out.push(...o.toolDefs)
    }
    return out
  }

  // 器官目录签名：目录里所有文件（含拆出来的子模块）的路径+大小+mtime。
  // 只盯 manifest/index 会漏掉「器官拆成多个文件、改的是别的文件」的情况（#39）。
  const signatureOf = (dirPath) => {
    const parts = []
    const walk = (d, rel) => {
      let list = []
      try { list = readdirSync(d, { withFileTypes: true }) } catch { return }
      list.sort((a, b) => (a.name < b.name ? -1 : 1))
      for (const ent of list) {
        const p = join(d, ent.name)
        const r = rel ? `${rel}/${ent.name}` : ent.name
        if (ent.isDirectory()) { walk(p, r); continue }
        try { const st = statSync(p); parts.push(`${r}:${st.size}:${st.mtimeMs}`) } catch {}
      }
    }
    walk(dirPath, '')
    return parts.join(',')
  }

  // 扫描 self-made 目录：全 AI 托管，磁盘上有的器官一律热加载。
  // self-made 器官跑在独立 Worker 里：加载失败/死循环/process.exit 只影响它自己。
  const loadSelfMade = async () => {
    const dir = selfMadeDir()
    const diskIds = new Set()
    if (existsSync(dir)) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) diskIds.add(entry.name)
      }
    }
    // 热卸载：磁盘上已不存在的 self-made 器官要从内存清单清掉，并停掉它的 worker。
    for (const [id, o] of [...organs]) {
      if (o.source === 'self-made' && !diskIds.has(id)) {
        if (o.runtime) stopRuntime(o.runtime, 'unloaded')
        organs.delete(id)
        trips.delete(id)
        audit.append({ event: 'unload', organ: id, reason: 'disk-removed' })
      }
    }
    if (!existsSync(dir)) return []
    const loaded = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dirPath = join(dir, entry.name)
      const manifestPath = join(dirPath, 'manifest.json')
      const indexPath = join(dirPath, 'index.js')
      if (!existsSync(manifestPath) || !existsSync(indexPath)) continue
      const manifest = readJson(manifestPath, null)
      if (!manifest || !manifest.id) continue
      // 幂等：已热加载、worker 活着、且目录签名没变才跳过。目录里任何文件改了都要重载（#39）。
      const sig = signatureOf(dirPath)
      const existing = organs.get(manifest.id)
      if (existing && existing.status === 'active' && existing.instance && !(existing.runtime && existing.runtime.failed) && existing.runtime && existing.runtime.sign === sig) continue
      if (existing && existing.runtime) stopRuntime(existing.runtime, 'reload')
      const code = readFileSync(indexPath, 'utf8')
      const g = guardOrgan(code)
      if (!g.ok) {
        logger.warn(`器官 ${manifest.id} 被 guard 拦截：${g.problems.join('、')}`)
        audit.append({ event: 'guard_block', organ: manifest.id, problems: g.problems })
        continue
      }
      try {
        const { rt, ready } = startRuntime(manifest, indexPath)
        const info = await ready
        const meta = { ...manifest, ...(info.meta || {}) }
        const id = String(meta.id || manifest.id)
        rt.id = id
        rt.sign = sig
        rt.toolDescs = Array.isArray(info.tools) ? info.tools : []
        rt.contextLine = String(info.contextLine || '')
        const defs = rt.toolDescs.map((desc) => toolDefFor(rt, desc))
        const instance = {
          contextLine: () => rt.contextLine,
          tick: async () => {
            return callWorker(rt, { type: 'tick' }, TICK_TIMEOUT_MS)
          },
        }
        const prev = organs.get(id)
        organs.set(id, {
          ...meta,
          id,
          status: 'active',
          source: 'self-made',
          instance,
          runtime: rt,
          toolDefs: (prev && Array.isArray(prev.toolDefs) && prev.toolDefs.length ? prev.toolDefs : defs),
        })
        trips.delete(id)
        loaded.push(id)
        audit.append({ event: 'load', organ: id, name: meta.name, tools: defs.map((d) => d.name), gap: clip(meta.gap, 120) })
      } catch (e) {
        logger.warn(`器官 ${manifest.id} 加载失败：${e.message}`)
        audit.append({ event: 'load_failed', organ: manifest.id, error: clip(e.message) })
      }
    }
    return loaded
  }

  // 自举器官的心跳调度：只调 self-made 器官的 tick（内置器官由 host.js 各自的 interval 直接调，避免重复）。
  // 熔断：连续 3 次异常 → status='tripped'，停用并停 worker，回面板看审计/原因。
  const tickAll = async () => {
    const results = []
    for (const [id, o] of organs) {
      if (o.source !== 'self-made' || o.status !== 'active' || !o.instance || typeof o.instance.tick !== 'function') continue
      try {
        if (o.runtime && (o.runtime.failed || o.runtime.stopped)) throw new Error('器官进程已崩溃/停止')
        const r = await o.instance.tick()
        // 成功一次就把异常计数清零：熔断语义是「连续 3 次」，不是「累计 3 次」。
        // 长期运行的器官偶尔抽一次不该被永久熔断。
        trips.delete(id)
        results.push({ id, ok: true, result: r })
      } catch (e) {
        const n = (trips.get(id) || 0) + 1
        trips.set(id, n)
        if (n >= 3) {
          o.status = 'tripped'
          if (o.runtime) stopRuntime(o.runtime, 'tripped')
          logger.warn(`器官 ${id} 熔断（连续 ${n} 次异常）：${e.message}`)
          audit.append({ event: 'trip', organ: id, trips: n, error: clip(e.message) })
        }
        results.push({ id, ok: false, error: e.message, trips: n })
      }
    }
    return results
  }

  // AI 卸载自己的器官（web_manage_organ remove 调这里）：停 worker + 删除目录 + 清内存。
  const remove = (id) => {
    const o = organs.get(id)
    if (o && o.runtime) stopRuntime(o.runtime, 'removed')
    const dir = join(selfMadeDir(), id)
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    organs.delete(id)
    trips.delete(id)
    audit.append({ event: 'remove', organ: id })
    return { ok: true, id }
  }

  // 磁盘快照比对：DSH 是多进程（web 进程答 API、agent 进程跑聊天），各进程的 organs Map 各自为政。
  // bootstrap 在 agent 进程落盘、remove 在任一进程删目录——对端进程必须重扫磁盘才能看到。
  // 快照 = 目录 mtime + 每个器官目录的完整签名（含拆出来的子模块），变了才重扫（loadSelfMade 本身幂等）。
  let lastScanKey = ''
  const scanKey = () => {
    const dir = selfMadeDir()
    if (!existsSync(dir)) return 'none'
    let key = String(statSync(dir).mtimeMs)
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      key += '|' + entry.name + ':' + signatureOf(join(dir, entry.name))
    }
    return key
  }
  const refreshIfChanged = async () => {
    try {
      const key = scanKey()
      if (key === lastScanKey) return { changed: false }
      lastScanKey = key
      const loaded = await loadSelfMade()
      return { changed: true, loaded }
    } catch (e) {
      return { changed: false, error: e.message }
    }
  }

  return { register, registerBuiltins, list, capabilities, contextLine, capabilityLine, loadSelfMade, remove, bind, tickAll, toolDefs, organs, refreshIfChanged, audit }
}