// life/chemistry.js — 内分泌三激素：dopamine / cortisol / serotonin。
// 与社交 mood 分轨：mood 是对话层的即时情绪，chemistry 是身体层的慢变量状态。
// 校准参考真人神经内分泌动力学：
//   多巴胺 = 奖赏/兴致的相位性信号，来得快去得也快（半衰 ~25 分钟）；
//   皮质醇 = 应激激素，急性升高、缓慢回落（半衰 ~90 分钟），且有昼夜节律（醒后高、夜间低）；
//   血清素 = 情绪稳定剂，由社会性接纳（被感谢/被安抚）缓慢积累（半衰 ~3 小时），被应激压制。
// 慢变量（每分钟积分）：cor≥70 → ser−1.5；ser≥70 → cor−0.5；dopamine≥75 → cor−0.5（兴奋缓冲应激）。
// 反应调节：血清素高时被激怒的皮质醇增量打七折（心情稳的人不容易被激怒）；
//          多巴胺正增量带习惯化（同一件事 24h 内反复奖励，效果每次 ×0.8 递减）。
// 衰减公式同 digital-life-core：baseline + (current - baseline) * 0.5^(elapsed/halfLife)。
// 每个事件都会记一条 history（三激素共同记录，用户可见但不可干预）。

const CHEM = {
  dopamine: { baseline: 50, halfLifeMin: 25 },   // 愉悦 / 兴致：相位性尖峰，兴头半小时
  cortisol: { baseline: 20, halfLifeMin: 90 },   // 应激 / 焦虑：升高快、消散慢（真人血浆半衰 60-90 分钟）
  serotonin: { baseline: 50, halfLifeMin: 180 }, // 平静 / 安全感：状态级慢变量，踏实一晚上
}

// 皮质醇昼夜节律：真人醒后 30-45 分钟达峰、入睡前最低。
// 7 点峰值 30、19 点谷值 10，摆幅 ±10。深夜基线低 → 夜里不容易被点燃、也不容易兴奋。
export function cortisolBaselineAt(hour) {
  const h = (((Number(hour) || 0) % 24) + 24) % 24
  return 20 + 10 * Math.cos(((h - 7) / 24) * Math.PI * 2)
}

function clamp(v, lo = 0, hi = 100) {
  if (!Number.isFinite(v)) return Math.round((lo + hi) / 2)
  return Math.max(lo, Math.min(hi, v))
}

export function decayToward(current, baseline, elapsedMs, halfLifeMs) {
  return baseline + (current - baseline) * Math.pow(0.5, elapsedMs / halfLifeMs)
}

export function defaultChemistry(now = Date.now()) {
  return { version: 1, at: now, dopamine: 50, cortisol: 20, serotonin: 50, history: [] }
}

export function normalizeChemistry(raw, now = Date.now()) {
  const d = defaultChemistry(now)
  const c = raw && typeof raw === 'object' ? raw : {}
  return {
    version: Number(c.version) || d.version,
    at: Number(c.at) || now,
    dopamine: clamp(Number(c.dopamine)),
    cortisol: clamp(Number(c.cortisol)),
    serotonin: clamp(Number(c.serotonin)),
    history: Array.isArray(c.history)
      ? c.history.filter((h) => h && typeof h === 'object' && Number.isFinite(h.at)).slice(0, 60)
      : [],
  }
}

export function createChemistry({ life, log }) {
  const load = () => normalizeChemistry(life.load().chemistry)

  // 衰减到 now + 慢变量规则（按经过分钟积分：cor≥70 持续压制血清素；ser≥70 安抚皮质醇；dopamine≥75 缓冲应激），纯计算不落盘。
  function compute(c, now) {
    const elapsed = Math.max(0, now - c.at)
    const elapsedMin = elapsed / 60_000
    let d = decayToward(c.dopamine, CHEM.dopamine.baseline, elapsed, CHEM.dopamine.halfLifeMin * 60_000)
    let cor = decayToward(c.cortisol, cortisolBaselineAt(new Date(now).getHours()), elapsed, CHEM.cortisol.halfLifeMin * 60_000)
    let ser = decayToward(c.serotonin, CHEM.serotonin.baseline, elapsed, CHEM.serotonin.halfLifeMin * 60_000)
    if (cor >= 70) ser -= 1.5 * elapsedMin // 慢变量：应激持续压制平静
    if (ser >= 70) cor -= 0.5 * elapsedMin // 慢变量：安全感安抚应激
    if (d >= 75) cor -= 0.5 * elapsedMin // 慢变量：兴奋缓冲应激（奖赏系统抑制 HPA 轴）
    return { version: 1, at: now, dopamine: clamp(d), cortisol: clamp(cor), serotonin: clamp(ser), history: c.history || [] }
  }

  // 落盘衰减结果（60s 心跳用，让状态文件保持最新）。
  function tick(now = Date.now()) {
    const next = compute(load(), now)
    return life.update((st) => { st.chemistry = next })
  }

  // 纯读当前值（P4 劫持 / contextLine / 前端用），不写盘。
  const peek = (now = Date.now()) => compute(load(), now)

  // 事件驱动：先衰减到 now，再按真人反应调节增量，记一条三激素共同记录。
  // 读-算-写整体进锁（审计：compute(load()) 的读在锁外，跨进程时增量会被抹掉）。
  function event(delta = {}, reason = '', now = Date.now()) {
    return life.update((st) => {
      const c = compute(normalizeChemistry(st.chemistry), now)
      let dd = Number(delta.dopamine) || 0
      let dc = Number(delta.cortisol) || 0
      let ds = Number(delta.serotonin) || 0
      if (dc > 0 && c.serotonin >= 70) dc *= 0.7 // 血清素高 → 应激反应被缓冲（心情稳的人不容易被激怒）
      if (dd > 0 && reason) {
        // 奖赏习惯化：同一件事 24h 内反复出现，每次效果 ×0.8 递减（天天被夸同一句就不新鲜了）
        const n = (c.history || []).filter((h) => h.reason === reason && h.at >= now - 86_400_000).length
        dd *= Math.pow(0.8, n)
      }
      const dd2 = clamp(c.dopamine + dd) - c.dopamine
      const dc2 = clamp(c.cortisol + dc) - c.cortisol
      const ds2 = clamp(c.serotonin + ds) - c.serotonin
      const next = {
        version: 1,
        at: now,
        dopamine: clamp(c.dopamine + dd2),
        cortisol: clamp(c.cortisol + dc2),
        serotonin: clamp(c.serotonin + ds2),
        history: [
          {
            at: now,
            reason: String(reason || '').slice(0, 60),
            dopamine: Math.round(dd2 * 10) / 10,
            cortisol: Math.round(dc2 * 10) / 10,
            serotonin: Math.round(ds2 * 10) / 10,
          },
          ...(c.history || []),
        ].slice(0, 60),
      }
      st.chemistry = next
      return next
    })
  }

  const history = (now = Date.now()) => {
    const h = compute(load(), now).history || []
    return h.filter((e) => e.dopamine !== 0 || e.cortisol !== 0 || e.serotonin !== 0)
  }

  // 身体状态 → 行为暗示（内感受铁律：不报数不命名，只描述说话方式）。
  function contextLine() {
    const c = peek()
    const parts = []
    if (c.cortisol >= 70) parts.push('神经紧绷，容易想多、有点防御，话会短而急')
    if (c.dopamine >= 70) parts.push('兴致很高，想玩、话会密，爱接梗')
    if (c.serotonin <= 25) parts.push('缺安全感，渴望被安抚')
    if (!parts.length) return ''
    return '[身体状态] 你此刻' + parts.join('；') + '。这些不用说出来，让它从语气里自然透出来。'
  }

  return { load, tick, peek, event, history, state: () => { const c = peek(); return { ...c, history: history() } }, contextLine }
}
