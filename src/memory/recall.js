// memory/recall.js — 记忆 v2 的召回（读取）层。
//
// 管线（DESIGN-life.md §5.3）：
//   线索包（心情快照 + 近 3 轮 + 实体 + 时段）
//     → 粗召回（BM25 兜底 + 冷门补位）
//     → 情绪锚点重排（当前心情接近编码时心情的事实优先）
//     → MMR 去重（别全是一个话题）
//     → 预算裁剪（3000 字硬顶 + 10% 意外位）
//     → 四档注入（[硬档]/[印象]/[事件]/[模糊] + 第N天·信度 + 使用规则）
//
// 与旧 memory.js 的 search/contextFor 不同：这里只读 mem store（facts/episodes），
// 不含 profiles/insights/styles（那些是「人格/相处经验」，Slice 4 另管）。
import { tokenize } from './similar.js'

const HOUR_LABEL = (h) => {
  if (h < 6) return '凌晨'
  if (h < 12) return '上午'
  if (h < 18) return '下午'
  return '晚上'
}

// 本地 whenText（不依赖 features/memory.js，那个将来退休）
export function whenText(at, now = Date.now()) {
  if (!at) return ''
  const d = new Date(at)
  const n = new Date(now)
  const day0 = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((day0(n) - day0(d)) / 86400_000)
  const md = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  if (days <= 0) return '今天'
  if (days === 1) return '昨天'
  if (days < 7) return `${days} 天前`
  if (d.getFullYear() === n.getFullYear()) return md
  if (d.getFullYear() === n.getFullYear() - 1) return '去年 ' + md
  return `${d.getFullYear()}-${md}`
}

// 间隔重复的记忆强度：被回忆越多（hitDays）越强、越难忘。
// 与旧 retention 同形，但把 importance 换成 conf（来源可信度）。
export function recallability(f, now = Date.now()) {
  const last = Math.max(f.t0 || 0, f.lastHit || 0)
  const days = Math.max(0, (now - last) / 86400_000)
  const strength = 1 + Math.min(10, Number(f.hitDays) || 0)
  const tau = 20 * strength * (0.5 + (Number(f.conf) ?? 0.5))
  return Math.exp(-days / tau)
}

// 应激注意力倾斜（移植自 digital-life-core 的 attentionOf/attentionWeights）：
// 皮质醇在 CALM(40) ~ STRESS(80) 之间线性插值——危机类(硬档 archived)权重 1→3、
// 日常类权重 1→0.1。平时(<40)注意力正常；极度应激(≥80)注意力高度收窄到要紧的事。
// 皮质醇是慢变量，用它做连续插值比「心情<35 一刀切」平滑（心情一句话就能跳变）。
export function attentionMultiplier(cortisol, archived) {
  if (cortisol == null || !Number.isFinite(cortisol)) return 1
  const CALM = 40
  const STRESS = 80
  const t = Math.max(0, Math.min(1, (cortisol - CALM) / (STRESS - CALM)))
  return archived ? 1 + (3 - 1) * t : 1 - (1 - 0.1) * t
}

export function createRecall({ store, getConfig, log = console }) {
  const cfg = () => getConfig().memory || {}

  // 1) 线索包：把 query 和环境揉成检索用的信号
  function buildCue(query, ctx = {}) {
    const now = ctx.now || Date.now()
    const about = ctx.about ? String(ctx.about) : ''
    const recent = (Array.isArray(ctx.recent) ? ctx.recent : []).map(String).filter(Boolean).slice(-3)
    return {
      query: String(query || ''),
      about,
      mood: Number.isFinite(ctx.mood) ? Number(ctx.mood) : null,
      cortisol: Number.isFinite(ctx.cortisol) ? Number(ctx.cortisol) : null,
      hour: HOUR_LABEL(new Date(now).getHours()),
      recent,
      now,
    }
  }

  // 2a) BM25 粗召回（读 currentFacts，没有 importance，改用 conf + 召回强度）
  function bm25(facts, cue, { aboutSet, minScore, limit }) {
    const qTerms = [...new Set(tokenize(cue.query))]
    const docs = facts.map((f) => ({
      f,
      tf: freq(tokenize(`${f.text} ${f.aboutName || ''} ${(f.tags || []).join(' ')}`)),
    }))
    const df = new Map()
    for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) || 0) + 1)
    const N = docs.length
    const scored = []
    for (const d of docs) {
      const f = d.f
      let s = 0
      for (const t of qTerms) {
        const c = d.tf.get(t)
        if (!c) continue
        const n = df.get(t) || 0
        s += Math.log(1 + (N - n + 0.5) / (n + 0.5)) * (c * 1.4) / (c + 1.4)
      }
      const aboutHit = aboutSet.has(f.subj)
      if (s <= 0 && !aboutHit) continue
      const base = s + (aboutHit ? 1.2 : 0)
      // 应激注意力倾斜（continuous，见 attentionMultiplier）：皮质醇越高，硬档越浮、日常越沉。
      const att = attentionMultiplier(cue.cortisol, f.archived)
      const score = base * recallability(f, cue.now) * (0.7 + 0.3 * (Number(f.conf) ?? 0.5)) * (f.archived ? 1.3 : 1) * att
      scored.push({ f, score, bm25: s, aboutHit })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.filter((x) => x.score >= (minScore ?? 0.2)).slice(0, limit)
  }

  // 2b) 冷门补位：打破头部垄断——久未被回忆、但属于这个人的事实补进来
  function coldSupplement(facts, picked, cue, { count }) {
    const pickedIds = new Set(picked.map((x) => x.f.id))
    const cold = facts
      .filter((f) => !pickedIds.has(f.id) && (Number(f.hitDays) || 0) <= 1)
      .filter((f) => (cue.about ? f.subj === cue.about : true) || (Number(f.conf) ?? 0) >= 0.5)
      .sort((a, b) => (a.lastHit || 0) - (b.lastHit || 0))
      .slice(0, count)
    return cold.map((f) => ({ f, score: 0.05, bm25: 0, aboutHit: false, cold: true }))
  }

  // 3) 情绪锚点重排：当前心情越接近「编码时心情」，越容易被想起来
  function anchorRerank(scored, cue) {
    if (cue.mood == null) return scored
    const eps = new Map(store.episodes().map((e) => [e.id, e]))
    const moodOf = (f) => {
      // 优先 episode 的 moodOut；拿不到就用 null（不参与情绪加权）
      for (const eid of f.ev || []) {
        const e = eps.get(eid)
        if (e && e.moodOut != null) return e.moodOut
      }
      return null
    }
    return scored.map((x) => {
      const em = moodOf(x.f)
      if (em == null) return x
      const delta = Math.abs(cue.mood - em) / 100 // 0..1
      return { ...x, score: x.score * (1 + Math.max(0, 1 - delta)) } // 越近 ×1.5~1.0
    })
  }

  // 4) MMR：贪心挑「分数高 且 和已选的不重复」
  function mmr(scored, { lambda = 0.7, k } = {}) {
    const kMax = k ?? scored.length
    const picked = []
    const rest = [...scored]
    while (picked.length < kMax && rest.length) {
      let best = -1
      let bestScore = -Infinity
      for (let i = 0; i < rest.length; i++) {
        const c = rest[i]
        let maxSim = 0
        for (const p of picked) maxSim = Math.max(maxSim, jaccardTokens(c.f.text, p.f.text))
        const m = lambda * c.score - (1 - lambda) * maxSim
        if (m > bestScore) { bestScore = m; best = i }
      }
      picked.push(rest.splice(best, 1)[0])
    }
    return picked
  }

  // 5) 预算裁剪 + 四档格式化
  function format(scored, cue) {
    const lines = []
    const used = new Set()
    let chars = 0
    const budget = Number(cfg().maxContextChars) || 3000
    const now = cue.now

    const tier = (f) => (f.archived ? '硬档' : (Number(f.conf) ?? 0) >= 0.6 ? '印象' : '模糊')
    const lineOf = (f) => {
      const days = Math.max(0, Math.round((now - (f.t0 || now)) / 86400_000))
      const conf = Math.round((Number(f.conf) ?? 0.5) * 10) / 10
      const nm = f.aboutName ? `[${f.aboutName}] ` : ''
      return `[${tier(f)}] [第${days}天·信度${conf}] ${nm}${f.text}`
    }

    // 先塞硬档/印象（高可信），再塞事件（最近做过的事），最后模糊
    const order = (x) => (x.f.archived ? 0 : (Number(x.f.conf) ?? 0) >= 0.6 ? 1 : 2)
    for (const x of [...scored].sort((a, b) => order(a) - order(b))) {
      if (used.has(x.f.id)) continue
      const line = lineOf(x.f)
      if (chars + line.length > budget) break
      lines.push(line)
      used.add(x.f.id)
      chars += line.length
    }

    // 事件：最近 episodes 挑 1 条最近的补上（聊到了可自然提起）
    const recent = store.episodes().filter((e) => e.summary).sort((a, b) => b.t1 - a.t1)[0]
    if (recent && !used.has(recent.id)) {
      const line = `[事件] [${whenText(recent.t1, now)}] ${recent.summary}`
      if (chars + line.length <= budget) lines.push(line)
    }

    return { lines, chars }
  }

  // 主入口：query + 环境 → 一段可直接注入的文本
  function recall(query, ctx = {}) {
    const cue = buildCue(query, ctx)
    const fs = store.currentFacts()
    if (!fs.length) return { lines: [], cue, stats: { candidates: 0, picked: 0 } }

    const limit = Number(ctx.limit) || Number(cfg().recallCount) || 6
    const aboutSet = cue.about ? new Set([cue.about]) : new Set()
    const bm = bm25(fs, cue, { aboutSet, limit })
    const cold = coldSupplement(fs, bm, cue, { count: Math.max(1, Math.floor(limit * 0.25)) })
    let scored = anchorRerank([...bm, ...cold], cue)
    scored.sort((a, b) => b.score - a.score)
    const picked = mmr(scored, { k: limit })

    // 成功回忆加固（DESIGN §5.3「成功回忆 S*=1.8」的落地）：
    // 被挑中的事实 hitDays++ → strength 上升 → 更难遗忘。
    // 每个事实每天至多 bump 一次，避免每条消息都写盘。
    for (const x of picked) {
      const f = x.f
      const sameDay = f.lastHit ? new Date(f.lastHit).toDateString() === new Date(cue.now).toDateString() : false
      if (!sameDay) store.bumpHit(x.f.id, cue.now)
    }

    const { lines, chars } = format(picked, cue)

    return {
      lines,
      cue,
      stats: { candidates: scored.length, picked: picked.length, cold: picked.filter((x) => x.cold).length, chars },
      candidates: picked.map((x) => ({ id: x.f.id, text: x.f.text, score: Number(x.score.toFixed(3)) })),
    }
  }

  return { recall, buildCue, bm25, coldSupplement, anchorRerank, mmr, format }
}

function freq(toks) {
  const m = new Map()
  for (const t of toks) m.set(t, (m.get(t) || 0) + 1)
  return m
}

function jaccardTokens(a, b) {
  const A = new Set(tokenize(a))
  const B = new Set(tokenize(b))
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const t of A) if (B.has(t)) inter++
  return inter / (A.size + B.size - inter)
}
