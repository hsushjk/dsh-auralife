// memory/assess.js — 认知验证闭环（移植自 InquisiMind 的 _assess_session_cognition）。
//
// InquisiMind 在 session 结束跑 meta-review，判断「召回的每条记忆这轮帮没帮上忙」：
//   positive → verified（强化）；negative → falsified（质疑）。
// auralife 已有「隐式 verified」= 召回命中 bumpHit，「显式 falsified」= 用户纠正 supersede。
// 这里补的是「主动审计」：凌晨重放时，用 LLM 扫一遍「中等可信、有点旧」的事实，
// 拿最近的事件摘要当证据，把已经过时/被推翻的自动打墓碑（可逆，不真删）——
// 兜底 encode 漏掉的 supersede（主人某句话隐含推翻旧事实，但编码时 LLM 没识别出 op=update）。
import { askModel } from '../core/llm.js'

function extractJson(raw) {
  if (!raw) return null
  const s = String(raw).trim()
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try { return JSON.parse(s.slice(start, end + 1)) } catch { return null }
}

export function createAssess({ dsh, getConfig, store, log = console }) {
  async function auditFacts(now = Date.now()) {
    const candidates = store.currentFacts().filter((f) => {
      if (f.archived) return false // 硬档（承诺/底线/雷点）永不审计
      const conf = Number(f.conf) ?? 0.5
      if (conf < 0.3 || conf >= 0.8) return false // 太低不值得审、太高是硬性事实
      const age = (now - Math.max(f.t0 || 0, f.lastHit || 0)) / 86400_000
      return age >= 3 // 至少 3 天没被碰过的才审
    })
    if (!candidates.length) return { audited: 0, outdated: [] }

    // 证据：最近 7 天的事件摘要（能反映主人最新的变化）
    const evidence = store.episodes()
      .filter((e) => e.summary && now - e.t1 < 7 * 86400_000)
      .sort((a, b) => b.t1 - a.t1)
      .slice(0, 10)
      .map((e) => `- ${e.summary}`)
      .join('\n') || '（没有最近的事件记录）'

    const system = '你是记忆审计员。下面是「记住的关于用户的事实」和「用户最近发生的事件」。判断哪些事实已经过时、被推翻、不再成立（用户改了主意、换了喜好、情况变了）。只输出 JSON：{"outdated":["id"...]}，一条都没有就输出 {"outdated":[]}。不要解释。'

    const outdated = []
    const BATCH = 8
    for (let i = 0; i < candidates.length; i += BATCH) {
      const batch = candidates.slice(i, i + BATCH)
      const factLines = batch.map((f) => `#${f.id} ${f.text}`).join('\n')
      const text = `最近的事件：\n${evidence}\n\n待审计的事实：\n${factLines}`
      let raw = ''
      try {
        raw = await askModel(dsh, { cfg: getConfig(), system, text, maxTokens: 300, temperature: 0 })
      } catch (err) {
        log.warn('auditFacts: LLM 调用失败', err.message)
        continue
      }
      const parsed = extractJson(raw)
      const ids = Array.isArray(parsed?.outdated) ? parsed.outdated : []
      for (const id of ids) {
        const f = store.findFact(String(id))
        if (!f || f.invalidAt) continue
        if (store.forget(String(id), now)) {
          outdated.push({ id: String(id), text: f.text })
          log.info(`审计遗忘：「${f.text.slice(0, 40)}」`)
        }
      }
    }
    return { audited: candidates.length, outdated }
  }

  return { auditFacts }
}
