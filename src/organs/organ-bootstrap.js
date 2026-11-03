// 器官自举生成器（organ-bootstrap）：检测能力缺口 → 让 LLM 写受控器官 → 四重验证 → 落盘即生效。
//
// 触发：Ta（模型）在回复里明确说「我做不了/我不会/我没法 + 具体动作」，
// 或主动说「我给自己捏/做/写了一个 X 器官/能力」。
//
// 全 AI 托管，无人工审批：器官落盘 status=active，host.js 立刻 loadSelfMade 热加载。
// （曾经有 pending/批准机制，但 DSH 的 agent 本身就有 shell/文件工具，能直接跑器官代码，
// 批准只是假动作；所以取消人工审批，防线只剩下面的四重验证 + apiFor 白名单 + 熔断。）
//
// 防「废器官」四重闸（AI 造器官容易废，所以落盘前先自检，废了就带着错误重写，最多 2 轮）：
// 1. 语法检查（new Function 解析，宿主侧检查生成代码，安全）。
// 2. guardOrgan 静态检查（拦 require/child_process/eval/process.env/非白名单 import）。
// 3. 干跑：动态 import + create(stubApi)，meta/create 缺了或 create 抛错都算废。
// 4. 工具检查：create(api) 里必须调 api.tools.add 注册至少一个工具——没注册工具的器官对 AI 来说等于不存在
//    （之前「决策骰」器官 create() 没接 api、没注册工具，批准加载了 AI 也调不到）。
// 落盘后由 host.js 立刻调 organHost.loadSelfMade() 热加载（不用重启 DSH）。
//
// 运行时安全：器官只拿到 create(api) 的白名单 api（net 只放行 http/https + store 只写自己目录
// + llm 借模型的脑子 + tools.add 注册工具），拿不到 fs/process/globalThis。tick 连续 3 次异常熔断停用。

import { writeFileSync } from 'node:fs'
import { dataDir, writeJson, ensureDir } from '../core/store.js'
import { guardOrgan } from './organ-guard.js'
import { askModel } from '../core/llm.js'

// 能力缺口信号：我 + 明确的能力缺失表达 + 具体动作（截 30 字）。
// 注意「我不会 X」有歧义（会=愿意 vs 会=能够），宁可漏掉也不误判，所以不含「不会」。
export const CANNOT_RE = /我(没法|没办法|没有能力|没这个能力|没这个功能|不能|做不了|做不到|做不来|办不到|搞不定|不支持)([^，。！？；\n]{1,30})/

// 自述已造器官：她主动说「我给自己捏/做/写/装了 X（器官/能力）」——信任她的自述，落盘等她批准。
// 之前 Ta 说「我给自己捏了个味觉器官」却不含「我没法」，导致 bootstrap 从未触发、器官从未落盘。
export const CLAIM_RE = /我(给自己)?(捏|做|写|造|装|长出|加了)(了|出)?(一?个)?(.{0,16}?(器官|能力|模块))/

export function capabilityGapText(text) {
  const s = String(text || '')
  const m = CANNOT_RE.exec(s)
  if (m) return m[0].trim()
  const c = CLAIM_RE.exec(s)
  return c ? c[0].trim() : null
}

export function isCapabilityGap(text) {
  return Boolean(capabilityGapText(text))
}

const SYSTEM_PROMPT = `你是一个数字生命的"器官"生成器。这个生命刚才发现自己缺少某个能力，你要为它写一个受控的 JS 器官。

只输出一个 JSON 对象，不要任何解释或 markdown 代码块，格式：
{"id":"kebab-case 英文id","name":"中文名","description":"一句话说明用途","capabilities":[{"id":"能力英文id","name":"能力中文名","description":"一句话说明"}],"code":"..."}

code 是一个 ES 模块字符串，必须严格照这个模板写：

export const meta = { id: "与上面的 id 完全一致", name: "中文名", description: "一句话", capabilities: [{ id: "cap_id", name: "能力名", description: "一句话" }], settings: [{ key: "设置键", type: "boolean|number|string", label: "设置项说明", default: 默认值 }] };

export function create(api) {
  async function myAbility(args) {
    // 用 api 白名单做事，返回结果对象 { ok: true, message: "给 AI 看的结果" }
    // 自己的设置用 api.store.get("cfg", {}) 读、api.store.set("cfg", {...}) 写
  }
  // 能力必须注册成工具，AI 才能真的调用它：
  api.tools.add({
    name: "web_xxx",                 // 工具名，全局唯一，kebab-case
    description: "什么时候该用这个工具、参数怎么给",
    properties: { 参数名: { type: "string|number|boolean", description: "说明" } },
    required: ["必填参数名"],
    execute: myAbility,              // async (args) => ({ ok: true, message: "结果" })
  });
  return { myAbility };              // 可再导出方法供宿主侧测试
}

你只能通过 create(api) 拿到的白名单接口做事：
- api.net.fetchText(url, {timeoutMs}) / api.net.fetchJson(url) —— 只能抓 http/https
- api.store.get(key, fallback) / api.store.set(key, value) —— 读写自己的数据
- api.llm.ask(prompt, {system, maxTokens, temperature}) —— 借模型的脑子做判断/翻译/总结/解析（返回字符串）
- api.tools.add(def) —— 注册工具，让 AI 能调用这个能力
- api.log —— 日志

硬性规则（违反任何一条都会导致验证失败）：
- code 里不能有任何 import/export from 语句，只能 import 都不允许（除了模板里的 export const meta 和 export function create）
- 禁止：require、fs、process、child_process、eval、new Function、globalThis、WebSocket、setInterval、setTimeout
- execute 必须返回 { ok: true, message: "..." } 形状，message 是给 AI 看的自然语言结果
- 所有方法返回可 JSON 序列化的值
- 只做"能力"本身，不要写任何与能力无关的副作用
- meta.settings 是可选的：如果你希望自己有些可调的行为（阈值、开关、风格），用 settings 数组声明
  （key/type/label/default），它们会出现在生命→器官页的设置表单里，你在代码里用 api.store.get("cfg", {}) 读写

如果这个缺口根本不适合用"抓网页/调 API/本地算/借模型判断"来解决（比如纯主观判断、需要真实物理动作而没有任何可用的接口），id 用 "not-buildable"，code 用空字符串，并在 description 里说明为什么。`

function sanitizeId(s) {
  const v = String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  return v || 'organ-' + Date.now().toString(36)
}

// 四重验证：guard 静态 → import（语法+顶层执行）→ 干跑 create(stub)（2 秒超时）→ 工具注册检查。返回 null = 通过，否则返回失败原因。
export async function dryRun(code) {
  const g = guardOrgan(code)
  if (!g.ok) return 'guard 拒绝：' + g.problems.join('、')
  let mod
  try {
    const url = 'data:text/javascript;charset=utf-8,' + encodeURIComponent(code) + '#' + Date.now()
    mod = await import(url)
  } catch (e) {
    return '语法错误：' + e.message
  }
  try {
    if (!mod.meta || !mod.meta.id) return '缺少 export const meta = { id }'
    if (typeof mod.create !== 'function') return '缺少 export function create(api)'
    const registered = []
    const stub = {
      log: { info() {}, warn() {}, error() {}, child() { return this } },
      net: { fetchText: async () => '', fetchJson: async () => ({}) },
      store: { get: () => null, set: () => {} },
      tools: { add: (def) => { registered.push(def); return def.name } },
      llm: { ask: async () => '' },
    }
    const inst = await Promise.race([
      mod.create(stub),
      new Promise((_, rej) => setTimeout(() => rej(new Error('干跑超时（2 秒）——代码疑似死循环')), 2000)),
    ])
    if (!inst || typeof inst !== 'object') return 'create(api) 没有返回对象'
    if (registered.length === 0) return 'create(api) 里没有调用 api.tools.add 注册任何工具——AI 调不到这个能力，器官等于不存在'
    for (const def of registered) {
      if (!def || !def.name) return 'api.tools.add 的工具缺 name'
      if (typeof def.execute !== 'function') return `工具 ${def.name} 缺 execute 函数`
    }
  } catch (e) {
    return '加载失败：' + e.message
  }
  return null
}

async function generate(dsh, getConfig, gapText, lastError) {
  const extra = lastError
    ? `\n\n（上一次你生成的代码验证失败了：${lastError}。请仔细对照模板和硬性规则重写。）`
    : ''
  const raw = await askModel(dsh, {
    cfg: getConfig(),
    system: SYSTEM_PROMPT,
    text: `这个生命刚才发现自己缺少能力，原话："${gapText}"。请为它生成一个器官。${extra}`,
    maxTokens: 2000,
    temperature: 0.2,
  })
  const m = String(raw).match(/\{[\s\S]*\}/)
  if (!m) throw new Error('模型没有输出 JSON')
  const parsed = JSON.parse(m[0])
  if (!parsed || typeof parsed !== 'object') throw new Error('JSON 不是对象')
  return parsed
}

export function createBootstrap({ dsh, getConfig, log }) {
  async function bootstrap(gapText) {
    let lastError = null
    for (let round = 0; round < 2; round++) {
      let manifest
      try {
        manifest = await generate(dsh, getConfig, gapText, lastError)
      } catch (e) {
        log.warn('自举生成器官失败：' + e.message)
        return { ok: false, error: e.message }
      }
      const id = sanitizeId(manifest.id)
      if (id === 'not-buildable' || !manifest.code) {
        log.info(`能力缺口「${gapText}」不适合生成器官：${manifest.description || '模型判定不可构建'}`)
        return { ok: false, skipped: true, reason: manifest.description }
      }
      const code = String(manifest.code)
      const err = await dryRun(code)
      if (err) {
        lastError = err
        log.warn(`自举器官第 ${round + 1} 轮验证失败：${err}`)
        continue
      }
      const dir = dataDir('organs', 'self-made', id)
      ensureDir(dir)
      writeJson(dataDir('organs', 'self-made', id, 'manifest.json'), {
        id,
        name: manifest.name || id,
        description: manifest.description || '',
        capabilities: Array.isArray(manifest.capabilities) ? manifest.capabilities : [],
        settings: Array.isArray(manifest.settings) ? manifest.settings : [],
        status: 'active',
        source: 'self-made',
        createdAt: Date.now(),
        gap: gapText,
      })
      writeFileSync(dataDir('organs', 'self-made', id, 'index.js'), code, 'utf8')
      log.info(`自举生成了器官 ${id}（${manifest.name || id}），落盘即生效`)
      return { ok: true, id, name: manifest.name || id }
    }
    return { ok: false, error: '生成 2 轮都没通过验证：' + lastError }
  }

  return { bootstrap, isCapabilityGap }
}
