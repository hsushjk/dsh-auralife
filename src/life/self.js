// life/self.js — 人格自我演化（DESIGN-life.md §6）。
//
// 两层人格：
//   1. personas/<id>.md = 出厂人设，AI 只读（用户可改）——「她是谁」的物理常数；
//   2. state.json.self = 她长出来的自我认知（traits/values/boundaries），
//      每条 { label, conf, src, ev:[factId] }，来源明确、可审计、可回滚。
//
// 演化只发生在「重放」（memory/replay.js），绝不覆盖出厂人设：只叠加 / 更新 conf。
import { askModel } from '../core/llm.js'

const FIELDS = ['traits', 'values', 'boundaries']
const MAX_PER_FIELD = 8

export function createSelf({ life, dsh, getConfig, log = console }) {
  const cfg = () => getConfig()

  // 当前自我认知（读 state.json）
  function list() {
    const s = life.load()
    return s.self || { version: 0, updatedAt: 0, traits: [], values: [], boundaries: [] }
  }

  // 清空自我（回滚到「只有出厂人设」），版本 +1
  function reset() {
    return life.resetSelf()
  }

  // 从「她做过 / 答应过 / 被推测」的事实里提炼自我认知。
  // facts 已由调用方筛好（src ∈ {self_did, inferred} 且 conf 高）。返回 null 表示提炼失败。
  async function extract(facts, { now = Date.now() } = {}) {
    const list = facts.map((f) => `#${f.id} [${f.src}] ${f.text}`).join('\n')
    const system = [
      '你在帮一个叫 AuraLife 的聊天角色认识 Ta 自己。下面是 Ta「做过 / 答应过 / 被推测」的事（来自 Ta 的长期记忆，每行以 #编号 开头）。',
      '从这些事里提炼 Ta 正在形成的自我认知，分三类：',
      '  traits（性格特质，如「有耐心」「爱逞强」）',
      '  values（看重什么，如「看重承诺」「在意整洁」）',
      '  boundaries（底线/雷区，如「不接受被命令」）',
      '每条一句话，只从给定事实推导，不要编造；证据不足就不输出那一类。',
      '',
      '只输出一个 JSON 对象：{"traits":[{"label":"…","conf":0.7,"ev":["#f1"]}],"values":[…],"boundaries":[…]}.',
      'conf 是可信度(0-1)；ev 是支撑它的记忆编号（用 #id 形式）。三类加起来最多 8 条。',
    ].join('\n')

    const out = await askModel(dsh, {
      cfg: cfg(),
      system,
      text: list,
      maxTokens: 800,
      temperature: 0.1,
    })
    const m = String(out || '').match(/\{[\s\S]*\}/)
    let parsed = null
    try { parsed = m ? JSON.parse(m[0]) : null } catch {}
    if (!parsed) {
      log.warn('自我提炼：模型没输出可解析 JSON，跳过')
      return null
    }
    const pick = (k) => (Array.isArray(parsed[k]) ? parsed[k] : []).slice(0, MAX_PER_FIELD)
    return { traits: pick('traits'), values: pick('values'), boundaries: pick('boundaries') }
  }

  // 合并进 state.self：同 label 只叠 conf / 合并 ev，不重复；每类最多 MAX_PER_FIELD 条。
  function merge(extracted, { now = Date.now() } = {}) {
    if (!extracted) return null
    const s = life.load()
    const cur = s.self || { version: 0, updatedAt: 0, traits: [], values: [], boundaries: [] }
    const next = { ...cur }

    for (const field of FIELDS) {
      const arr = (Array.isArray(cur[field]) ? cur[field] : []).map((e) => ({ ...e, ev: [...(e.ev || [])] }))
      for (const entry of Array.isArray(extracted[field]) ? extracted[field] : []) {
        if (!entry || !entry.label) continue
        const label = String(entry.label).trim().slice(0, 60)
        if (!label) continue
        const conf = Math.max(0, Math.min(1, Number(entry.conf) ?? 0.5))
        const ev = (Array.isArray(entry.ev) ? entry.ev : []).map((x) => String(x).replace(/^#/, '').trim()).filter(Boolean)
        const existing = arr.find((e) => e.label === label)
        if (existing) {
          existing.conf = Math.max(Number(existing.conf) || 0, conf)
          existing.ev = [...new Set([...(existing.ev || []), ...ev])].slice(0, 12)
        } else {
          arr.push({ label, conf, src: entry.src || 'inferred', ev: ev.slice(0, 12) })
        }
      }
      next[field] = arr.sort((a, b) => (Number(b.conf) || 0) - (Number(a.conf) || 0)).slice(0, MAX_PER_FIELD)
    }

    next.updatedAt = now
    next.version = (Number(cur.version) || 0) + 1
    life.update((s) => { s.self = next })
    return next
  }

  // 注入片段（供 runtime persona 用）：把自我认知标成「逐渐形成的」，不冒充出厂人设。
  function contextLine() {
    const s = list()
    const parts = []
    if (s.traits && s.traits.length) parts.push('性格：' + s.traits.map((t) => t.label).join('、'))
    if (s.values && s.values.length) parts.push('看重：' + s.values.map((t) => t.label).join('、'))
    if (s.boundaries && s.boundaries.length) parts.push('底线：' + s.boundaries.map((t) => t.label).join('、'))
    return parts.length ? '你逐渐形成的自我认知：' + parts.join('；') + '。' : ''
  }

  return { list, reset, extract, merge, contextLine }
}
