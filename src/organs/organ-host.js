// 器官宿主（organ-host）：数字生命的「能力清单」+ 器官加载器。
//
// 定位：一个统一层，让 Ta（LLM）知道「自己会什么、不会什么」。
// - register(meta)：登记内置器官（host.js 装配时调用）。
// - capabilities()：扁平能力清单（每个能力带 organ 归属）。
// - contextLine()：注入 system prompt 的「你拥有哪些能力」文本。
// - loadSelfMade()：扫描数据目录 organs/self-made/ 热加载 Ta 自己写的器官。
//
// 器官自举链路（全 AI 托管，无人工审批）：gap 检测到缺口 → 判断「清单里没有能解决这事的器官」
// → LLM 生成器官（meta + 受控代码）→ guardOrgan 静态检查 + 四重干跑 → 落盘 status=active
// → host.js 立刻 loadSelfMade 动态 import + create(api) 热加载。
// （曾经有 pending/主人批准机制，但 DSH agent 本身有 shell/文件工具，批准只是假动作，
// 所以取消人工审批。防线 = 四重验证 + apiFor 白名单 + tick 熔断 + 磁盘热卸载。）

import { readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { dataDir, readJson, writeJson, ensureDir, existsSync, withFileLock } from '../core/store.js'
import { guardOrgan } from './organ-guard.js'
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

export function createOrganHost({ dsh, getConfig, log }) {
  const logger = log
  const organs = new Map()

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

  const contextLine = () => {
    const active = [...organs.values()].filter((o) => o.status === 'active')
    if (!active.length) return ''
    const lines = active.map((o) => `- ${o.name}（${o.id}）：${o.description}`)
    const tail = '如果遇到超出这些能力的事，说明你可能缺一个器官，你可以自己写一个新的补上（写出来立即生效，没有审批）。'
    const head = ['你此刻拥有的能力（器官）：', ...lines, tail].join('\n')
    // 聚合绑定器官的「当下状态 / 说话方式」行为指令（mood/chemistry/energy 等，遵守内感受铁律不报数）。
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

  // 白名单 API：器官代码里拿不到 fs/process/globalThis，只能拿这几个受控入口。
  // 主人批准 = 信任，所以给足「软能力」：llm.ask 让器官可以借模型的脑子做判断/翻译/总结，
  // 而不是只能硬编码规则（这正是 AI 造废器官的头号原因——它想造"聪明"器官却只拿到 net/store）。
  const apiFor = (id) => ({
    log: (typeof logger.child === 'function') ? logger.child(`organ:${id}`) : logger,
    net: {
      async fetchText(url, opts = {}) {
        if (!/^https?:\/\//i.test(url)) throw new Error('只允许 http/https 地址')
        const res = await fetch(url, { signal: AbortSignal.timeout(opts.timeoutMs || 15000), ...(opts.init || {}) })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.text()
      },
      async fetchJson(url, opts = {}) {
        return JSON.parse(await this.fetchText(url, opts))
      },
    },
    store: {
      get: (key, fallback) => readJson(dataDir('organs', id, `${key}.json`), fallback),
      set: (key, value) => withFileLock(`organ-store-${id}`, () => {
        ensureDir(dataDir('organs', id))
        writeJson(dataDir('organs', id, `${key}.json`), value)
      }, { staleMs: 10000, timeoutMs: 5000 }),
    },
    // 注册工具：器官的能力要能被 AI 真正调到，不只是出现在能力清单里。
    tools: {
      add(def) {
        const o = organs.get(id)
        if (!o) return null
        if (!o.toolDefs) o.toolDefs = []
        o.toolDefs.push(def)
        return def.name
      },
    },
    // 借模型的脑子：器官可以调 LLM 做软逻辑（判断/翻译/总结/解析）。
    llm: {
      ask(prompt, opts = {}) {
        return askModel(dsh, {
          cfg: getConfig(),
          system: String(opts.system || ''),
          text: String(prompt || ''),
          maxTokens: Number(opts.maxTokens) || 800,
          temperature: opts.temperature === undefined ? 0.3 : Number(opts.temperature),
        })
      },
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

  // 扫描 self-made 目录：全 AI 托管，磁盘上有的器官一律热加载（无 pending/批准）。
  // guard 拦住的 warn 跳过；create 抛错/没注册工具的 warn 跳过（bootstrap 落盘前已四重验证，这里是最后防线）。
  const loadSelfMade = async () => {
    const dir = selfMadeDir()
    // 热卸载：磁盘上已不存在的 self-made 器官（被 AI 卸载/手动删除）要从内存清单清掉。
    // 此前只增不减——一个进程删目录后，其他进程的幽灵条目永远留着，
    // AI 上下文里还写着「你有这个能力」，实际器官已没了。
    const diskIds = new Set()
    if (existsSync(dir)) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) diskIds.add(entry.name)
      }
    }
    for (const [id, o] of [...organs]) {
      if (o.source === 'self-made' && !diskIds.has(id)) organs.delete(id)
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
      // 幂等：已热加载的 active 器官跳过（bootstrap 落盘后、refreshIfChanged 重扫都会再调 loadSelfMade，
      // 重复 import 会重复 create + 重复注册工具）。
      const existing = organs.get(manifest.id)
      if (existing && existing.status === 'active' && existing.instance) continue
      const code = readFileSync(indexPath, 'utf8')
      const g = guardOrgan(code)
      if (!g.ok) {
        logger.warn(`器官 ${manifest.id} 被 guard 拦截：${g.problems.join('、')}`)
        continue
      }
      try {
        const url = pathToFileURL(indexPath).href + '?t=' + Date.now()
        const mod = await import(url)
        const meta = mod.meta || manifest
        const prev = organs.get(meta.id)
        // 先占位再 create：apiFor 的 tools.add 靠 organs.get(id) 找落点，
        // 首次加载时 Map 里还没有该条目 → 不占位的话 create(api) 期间注册的工具全部静默丢失。
        organs.set(meta.id, { ...meta, status: 'active', source: 'self-made', module: mod, instance: null, toolDefs: (prev && prev.toolDefs) || [] })
        const instance = typeof mod.create === 'function' ? await mod.create(apiFor(meta.id)) : {}
        // create(api) 期间 tools.add 往占位条目 push 工具定义；覆盖时要保留的是「占位后」的 toolDefs。
        const cur = organs.get(meta.id)
        organs.set(meta.id, { ...meta, status: 'active', source: 'self-made', module: mod, instance, toolDefs: (cur && cur.toolDefs) || [] })
        loaded.push(meta.id)
      } catch (e) {
        logger.warn(`器官 ${manifest.id} 加载失败：${e.message}`)
      }
    }
    return loaded
  }

  // 自举器官的心跳调度：只调 self-made 器官的 tick（内置器官由 host.js 各自的 interval 直接调，避免重复）。
  // 熔断：连续 3 次异常 → status='tripped'，停用，回面板看原因。
  const trips = new Map()
  const tickAll = async () => {
    const results = []
    for (const [id, o] of organs) {
      if (o.source !== 'self-made' || o.status !== 'active' || !o.instance || typeof o.instance.tick !== 'function') continue
      try {
        const r = await o.instance.tick()
        results.push({ id, ok: true, result: r })
      } catch (e) {
        const n = (trips.get(id) || 0) + 1
        trips.set(id, n)
        if (n >= 3) {
          o.status = 'tripped'
          logger.warn(`器官 ${id} 熔断（连续 ${n} 次异常）：${e.message}`)
        }
        results.push({ id, ok: false, error: e.message, trips: n })
      }
    }
    return results
  }

  // AI 卸载自己的器官（web_manage_organ remove 调这里）：删除目录 + 清内存。
  const remove = (id) => {
    const dir = join(selfMadeDir(), id)
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    organs.delete(id)
    return { ok: true, id }
  }

  // 磁盘快照比对：DSH 是多进程（web 进程答 API、agent 进程跑聊天），各进程的 organs Map 各自为政。
  // bootstrap 在 agent 进程落盘、remove 在任一进程删目录——对端进程必须重扫磁盘才能看到。
  // 快照 = 目录 mtime + 每个器官目录的 manifest/index.js mtime，变了才重扫（loadSelfMade 本身幂等）。
  let lastScanKey = ''
  const scanKey = () => {
    const dir = selfMadeDir()
    if (!existsSync(dir)) return 'none'
    let key = String(statSync(dir).mtimeMs)
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const sub = join(dir, entry.name)
      for (const f of ['manifest.json', 'index.js']) {
        const p = join(sub, f)
        key += '|' + entry.name + ':' + f + ':' + (existsSync(p) ? statSync(p).mtimeMs : '-')
      }
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

  return { register, registerBuiltins, list, capabilities, contextLine, loadSelfMade, remove, apiFor, bind, tickAll, toolDefs, organs, refreshIfChanged }
}
