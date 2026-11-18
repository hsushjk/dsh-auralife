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
import { containment, normalizeText, similarity, tokenize } from './similar.js'
import { numOr } from '../core/store.js'

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
  const tau = 20 * strength * (0.5 + numOr(f.conf, 0.5))
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
      // 检索要带当前聊天：事件注入不能把客人那边的事串进主人提示（#12）。
      chatId: String(ctx.chatId || ''),
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
      const score = base * recallability(f, cue.now) * (0.7 + 0.3 * numOr(f.conf, 0.5)) * (f.archived ? 1.3 : 1) * att
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
      .filter((f) => (cue.about ? f.subj === cue.about : true) || numOr(f.conf, 0) >= 0.5)
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

  // 4b) 近似删重：MMR 只是给相似项降权、不删，同一件事换个说法仍可能一起挤进提示（#16）。
  //     这里在最后按正文相似度删一遍，保留分高的那条；阈值比判重松一档（注入宁少勿重，#3）。
  function dedupePicked(picked) {
    const out = []
    for (const x of picked) {
      const t = normalizeText(String(x.f.text || ''))
      const near = out.find((p) => {
        const pt = normalizeText(String(p.f.text || ''))
        return pt === t || similarity(pt, t) >= 0.75 || containment(pt, t) >= 0.82
      })
      if (!near) out.push(x)
    }
    return out
  }

  // 4c) 联想扩散：顺着 edges 把已命中事实的邻居也拉进来一点（「顺着想起」）。
  // edges 以前只写不读，联想等于空转（#16）。
  function assocExpand(scored, cue, { limit = 6 } = {}) {
    if (!scored.length) return scored
    const factsById = new Map(visibleFacts(store.currentFacts(), cue.chatId).map((f) => [f.id, f]))
    const scoreById = new Map(scored.map((x) => [x.f.id, x.score]))
    const boost = new Map()
    for (const e of store.edges()) {
      if (!factsById.has(e.a) || !factsById.has(e.b)) continue
      const sa = scoreById.get(e.a)
      const sb = scoreById.get(e.b)
      const w = numOr(e.w, 0.5)
      if (sa) {
        const v = sa * (0.28 + 0.22 * w)
        if (!boost.has(e.b) || boost.get(e.b) < v) boost.set(e.b, v)
      }
      if (sb) {
        const v = sb * (0.28 + 0.22 * w)
        if (!boost.has(e.a) || boost.get(e.a) < v) boost.set(e.a, v)
      }
    }
    const out = [...scored]
    for (const [id, v] of boost) {
      if (scoreById.has(id)) continue
      const f = factsById.get(id)
      if (!f) continue
      const s = v * recallability(f, cue.now) * attentionMultiplier(cue.cortisol, f.archived)
      if (s < 0.02) continue
      out.push({ f, score: s, bm25: 0, aboutHit: false, assoc: true })
    }
    out.sort((a, b) => b.score - a.score)
    return out.slice(0, Math.max(limit * 3, 12))
  }

  // 5) 预算裁剪 + 四档格式化
  // #3：注入预算收紧（默认 1800 字）+ 条数上限（默认 5 条），别一轮就把整批记忆塞进提示。
  function format(scored, cue) {
    const lines = []
    const used = new Set()
    let chars = 0
    const budget = Number(cfg().maxContextChars) || 1500
    const factCap = Math.max(1, Number(cfg().recallFactLimit) || 3)
    const now = cue.now

    const tier = (f) => (f.archived ? '硬档' : numOr(f.conf, 0) >= 0.6 ? '印象' : '模糊')
    const lineOf = (f) => {
      const days = Math.max(0, Math.round((now - (f.t0 || now)) / 86400_000))
      const conf = Math.round(numOr(f.conf, 0.5) * 10) / 10
      const nm = f.aboutName ? `[${f.aboutName}] ` : ''
      return `[${tier(f)}] [第${days}天·信度${conf}] ${nm}${f.text}`
    }

    // 先塞硬档/印象（高可信），再塞事件（最近做过的事），最后模糊
    const order = (x) => (x.f.archived ? 0 : numOr(x.f.conf, 0) >= 0.6 ? 1 : 2)
    for (const x of [...scored].sort((a, b) => order(a) - order(b))) {
      if (used.has(x.f.id)) continue
      if (used.size >= factCap) break
      const line = lineOf(x.f)
      if (chars + line.length > budget) break
      lines.push(line)
      used.add(x.f.id)
      chars += line.length
    }

    // 事件：挑 1 条和当前对话相关的事件。优先同一聊天，其次无 chatId 的全局事件；
    // 以前永远取全局最近一条，客人聊的事也会塞进主人提示（#12）。
    const recallChat = cue.chatId || ''
    const eps = store.episodes().filter((e) => e.summary)
    const chatEps = recallChat ? eps.filter((e) => e.chatId === recallChat) : []
    const pool = chatEps.length ? chatEps : eps.filter((e) => !recallChat || !e.chatId)
    const recent = pool.sort((a, b) => b.t1 - a.t1)[0]
    if (recent && !used.has(recent.id)) {
      const line = `[事件] [${whenText(recent.t1, now)}] ${recent.summary}`
      if (chars + line.length <= budget) lines.push(line)
    }

    return { lines, chars }
  }

  // 6a) 梦的定向召回（#11）：「梦见过 X 吗」不能只靠联想扩散，直接翻 kind='dream' 的 episode。
  //     只在问句带「梦」时触发，平时不占注入预算。
  function dreamLines(cue) {
    const q = String(cue.query || '')
    if (!/梦/.test(q)) return []
    let eps = []
    try { eps = store.episodes().filter((e) => e && e.kind === 'dream' && e.summary) } catch { return [] }
    if (!eps.length) return []
    const key = q.replace(/[？?！!。.,，\s]/g, '').replace(/你|我|她|他|记得|梦见过|梦到|做过|那个|一次|吗|过/g, '')
    const toks = new Set(tokenize(q).filter((t) => t.length > 1))
    const scored = []
    for (const e of eps) {
      const s = String(e.summary)
      const strong = key && s.includes(key)
      let shared = 0
      for (const t of tokenize(s)) if (toks.has(t)) shared++
      // 至少要有「关键词整体命中」或「两个以上实词重合」才算相关，别让「梦见」这个词本身把不相干的梦都拉进来。
      if (!strong && shared < 2) continue
      const hit = (strong ? 0.6 : 0) + Math.min(0.3, shared * 0.06)
      if (hit > 0.05) scored.push({ e, s: hit })
    }
    scored.sort((a, b) => b.s - a.s)
    return scored.slice(0, 2).map(({ e }) => `[梦] [${whenText(e.t1, cue.now)}] ${String(e.summary).slice(0, 120)}`)
  }

  // 6) 忽然想起：不是每轮把记忆整批塞进提示（#17），而是某个时刻自己冒出一件旧事。
  // chatId 过滤：客人那边的事不会忽然想起到主人这边；同一句 12 小时内不重复被想起。
  const SPONTANEOUS_COOLDOWN_MS = 12 * 3600_000
  function spontaneous(now = Date.now(), { chatId = '' } = {}) {
    const cid = String(chatId || '')
    const fs = store.currentFacts().filter((f) => !f.archived && (!cid || !f.chatId || f.chatId === cid))
    const fresh = fs.filter((f) => now - (Number(f.lastSpokenAt) || 0) >= SPONTANEOUS_COOLDOWN_MS)
    // 全都刚想起过时退一步：至少隔 1 小时；还不行就这次不想起（宁可没有，也别同一句连着冒）。
    const pool = fresh.length ? fresh : fs.filter((f) => now - (Number(f.lastSpokenAt) || 0) >= 3600_000)
    if (!pool.length) return null
    const recent = pool.length > 40 ? pool.slice(-40) : pool
    // 优先挑命中过、更「熟」的记忆，但保留随机性。
    const weighted = recent.flatMap((f) => Array(Math.min(4, 1 + Math.floor(Number(f.hits) || 0))).fill(f))
    const f = weighted[Math.floor(Math.random() * weighted.length)]
    const days = Math.max(0, Math.round((now - (f.t0 || now)) / 86400_000))
    return {
      id: f.id,
      text: f.text,
      fact: f,
      days,
      // #14b：别在这里就 markSpoken——被模型回成 [沉默]/发送失败时，12 小时冷却白耗。
      // 由调用方在真正说出口（或真的注入了这一轮）之后再调 mark()。
      mark: () => store.markSpoken(f.id, now).catch((error) => log.warn('记忆想起标记写失败：' + (error?.message || error))),
      line: `你忽然想起：${f.text}${days ? `（${days} 天前的事）` : ''}`,
    }
  }

  // 可见事实：单聊里主人看不到客人那边的事实（全局/她自己的事 chatId 为空，两边都可见）。
  function visibleFacts(all, chatId) {
    const cid = String(chatId || '')
    if (!cid) return all
    return all.filter((f) => !f.chatId || f.chatId === cid)
  }

  // 主入口：query + 环境 → 一段可直接注入的文本
  function recall(query, ctx = {}) {
    const cue = buildCue(query, ctx)
    const dream = dreamLines(cue)
    const allFacts = store.currentFacts()
    const fs = visibleFacts(allFacts, cue.chatId)
    if (!fs.length) return { lines: dream, cue, stats: { candidates: 0, picked: 0, dream: dream.length } }

    const limit = Number(ctx.limit) || Number(cfg().recallCount) || 6
    const aboutSet = cue.about ? new Set([cue.about]) : new Set()
    const bm = bm25(fs, cue, { aboutSet, limit })
    // #3（结构性）：没有真正命中就不塞记忆。about 是「聊天对象」（主人是常量），
    // 不能只因为「关于主人」就把一批事实塞进去——那正是「整批塞」的来源。
    // 只有 query 的词真的命中了某条事实（bm25 > 0），才进入召回管线。
    const hasHit = bm.some((x) => (x.bm25 || 0) > 0)
    if (!hasHit) return { lines: dream, cue, stats: { candidates: 0, picked: 0, gated: true, dream: dream.length } }
    const cold = coldSupplement(fs, bm, cue, { count: Math.max(1, Math.floor(limit * 0.25)) })
    let scored = anchorRerank([...bm, ...cold], cue)
    scored = assocExpand(scored, cue, { limit })
    scored.sort((a, b) => b.score - a.score)
    const picked = dedupePicked(mmr(scored, { k: limit }))

    // 成功回忆加固（DESIGN §5.3「成功回忆 S*=1.8」的落地）：
    // 被挑中的事实 hitDays++ → strength 上升 → 更难遗忘。
    // 每个事实每天至多 bump 一次，避免每条消息都写盘。
    for (const x of picked) {
      const f = x.f
      const sameDay = f.lastHit ? new Date(f.lastHit).toDateString() === new Date(cue.now).toDateString() : false
      if (!sameDay) store.bumpHit(x.f.id, cue.now).catch((error) => log.warn('记忆召回计数写失败：' + (error?.message || error)))
    }

    const { lines, chars } = format(picked, cue)
    // 梦的定向召回补在事实后面：不占事实条数，但受同一总预算约束（#11/#3）。
    let totalChars = chars
    for (const line of dream) {
      if (totalChars + line.length > 1800) break
      lines.push(line)
      totalChars += line.length
    }

    return {
      lines,
      cue,
      stats: { candidates: scored.length, picked: picked.length, cold: picked.filter((x) => x.cold).length, chars: totalChars, dream: dream.length },
      candidates: picked.map((x) => ({ id: x.f.id, text: x.f.text, score: Number(x.score.toFixed(3)) })),
    }
  }

  return { recall, spontaneous, buildCue, bm25, coldSupplement, anchorRerank, assocExpand, mmr, format }
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
