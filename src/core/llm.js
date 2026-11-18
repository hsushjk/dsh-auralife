import { randomUUID } from 'node:crypto'

export function defaultModel(dsh, cfg) {
  if (cfg?.model?.provider && cfg?.model?.model) return { provider: cfg.model.provider, model: cfg.model.model }
  try {
    const svc = dsh.get('agentDefaultModel')
    const sel = svc && typeof svc.currentSelection === 'function' ? svc.currentSelection() : null
    if (sel && sel.provider && sel.model) return { provider: sel.provider, model: sel.model }
  } catch (error) {}
  return null
}

// ——内部调用用的「低思考强度」探测——
// 解析 JSON 这类内部调用不该跟着用户配置的 max 思考强度跑：思考 token 会把正文预算吃光，
// 输出为空或被截断。宿主暴露 resolveModelInfo 时按 off → minimal → low 挑一档支持的；
// 拿不到能力信息就不显式传强度，交给宿主默认（绝不硬塞一个可能不被支持的值）。
const LOW_EFFORTS = ['off', 'minimal', 'low']
const effortCache = new Map()

async function supportedEfforts(llm, provider, model) {
  const key = provider + '::' + model
  if (effortCache.has(key)) return effortCache.get(key)
  let list = null
  try {
    if (typeof llm.resolveModelInfo === 'function') {
      // #16a：宿主查询能力信息也可能挂住，别让它拖死整轮/整次整理。
      // 注意定时器不能 unref：调用方正 await 这个 race，事件循环不能因为只剩它而提前空掉。
      let timer = null
      const slow = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('模型能力查询超时')), 5000) })
      let info
      try {
        info = await Promise.race([llm.resolveModelInfo(provider, model), slow])
      } finally {
        clearTimeout(timer)
      }
      if (info && info.reasoning) list = (info.reasoning.efforts || []).map((e) => String(e?.id ?? e))
    }
  } catch { list = null }
  effortCache.set(key, list)
  return list
}

const EFFORT_UNSUPPORTED = /UNSUPPORTED_REASONING_EFFORT|does not support reasoning effort/i

async function runStream(llm, req) {
  let out = ''
  for await (const chunk of llm.stream(req)) {
    if (!chunk) continue
    if (chunk.type === 'text-delta') out += chunk.text
    if (chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') {
      const f = chunk.reason.failure || {}
      throw new Error('模型报错：' + (f.message || f.code || '未知'))
    }
  }
  return out.trim()
}

// 内部调用也要有超时：模型挂住时不能把调用方（比如记忆整理）一起拖死（#46）。
const DEFAULT_TIMEOUT_MS = 120_000

function timeoutOf(o) {
  const n = Number(o?.timeoutMs)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS
  return Math.min(600_000, Math.max(1000, Math.round(n)))
}

async function runWithTimeout(llm, req, timeoutMs) {
  const ctl = new AbortController()
  let timer = null
  // 不依赖底层是否真的响应 abort：超时了就自己把 Promise race 掉（#46）。
  const timeoutError = new Promise((_, reject) => {
    timer = setTimeout(() => {
      ctl.abort()
      reject(new Error(`模型调用超时（${Math.round(timeoutMs / 1000)} 秒）`))
    }, timeoutMs)
  })
  try {
    return await Promise.race([runStream(llm, { ...req, signal: ctl.signal }), timeoutError])
  } finally {
    clearTimeout(timer)
  }
}

export async function askModel(dsh, o) {
  const llm = dsh.llm || dsh.get('llm')
  if (!llm || typeof llm.stream !== 'function') throw new Error('宿主没有 llm 服务')
  const t = defaultModel(dsh, o.cfg)
  if (!t) throw new Error('拿不到默认模型')
  let content = [{ type: 'text', text: o.text }]
  for (const img of o.images || []) content.push({ type: 'image', data: img.data, mediaType: img.mediaType, name: 'auralife-image' })

  if (content.length > 1) {
    const att = dsh.attachments || dsh.get('attachments')
    if (!att || typeof att.admitPromptContent !== 'function') throw new Error('宿主没有附件服务，看不了图')
    content = await att.admitPromptContent(content)
  }
  const messages = [{ role: 'user', id: randomUUID(), content, source: { kind: 'plugin', plugin: 'auralife' } }]
  const baseMax = Math.max(1, Number(o.maxTokens) || 600)
  const timeoutMs = timeoutOf(o)

  // 思考强度优先级：显式传 > preferLowEffort 探测 > 配置默认。
  // preferLowEffort 只给内部结构化调用用；聊天/开口这类正文生成仍然尊重她的配置。
  let effort = o.reasoningEffort ?? null
  if (!effort && o.preferLowEffort) {
    const supported = await supportedEfforts(llm, t.provider, t.model)
    // 有支持列表就挑一档低强度；没有低档（或拿不到能力信息）就不显式传，交给宿主默认。
    if (supported && supported.length) effort = LOW_EFFORTS.find((id) => supported.includes(id)) || null
  }
  if (!effort && !o.preferLowEffort) effort = o.cfg?.model?.reasoningEffort ?? 'low'

  const request = (reasoningEffort, maxTokens) => {
    const req = {
      provider: t.provider,
      model: t.model,
      system: o.system || '',
      messages,
      maxTokens,
      temperature: o.temperature ?? 0.3,
    }
    if (reasoningEffort) req.reasoningEffort = reasoningEffort
    return req
  }

  let out
  try {
    out = await runWithTimeout(llm, request(effort, baseMax), timeoutMs)
  } catch (error) {
    if (!EFFORT_UNSUPPORTED.test(String(error?.message || error))) throw error
    // 宿主不认这个思考强度（不 clamp 也不别名，直接 throw）：退到宿主默认，放大预算再试一次。
    return runWithTimeout(llm, request(null, Math.max(1200, baseMax * 4)), timeoutMs)
  }
  if (out) return out
  // 正文为空：多半是思考 token 吃光了预算（适配器不支持 off 时尤其常见）。
  // 放大预算再给一次机会；#16b：preferLowEffort 的内部调用重试时也别偷偷退回高思考强度。
  let retryEffort = null
  if (o.preferLowEffort) {
    retryEffort = effort || null
    if (!retryEffort) {
      const supported = await supportedEfforts(llm, t.provider, t.model)
      retryEffort = supported && supported.length ? (LOW_EFFORTS.find((id) => supported.includes(id)) || null) : null
    }
  }
  return runWithTimeout(llm, request(retryEffort, Math.max(1200, baseMax * 4)), timeoutMs)
}
