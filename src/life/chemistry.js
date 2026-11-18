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

// 多巴胺的日周期：下午到傍晚最容易有兴致（15 点峰、3 点谷），摆幅 ±6。
// 没有这条，多巴胺永远靠事件顶起来、靠半衰落回 50，日子本身没有任何起伏（#50）。
export function dopamineBaselineAt(hour) {
  const h = (((Number(hour) || 0) % 24) + 24) % 24
  return 50 + 6 * Math.cos(((h - 15) / 24) * Math.PI * 2)
}

// 血清素的日周期：午后到傍晚稳一些（13 点峰、1 点谷），摆幅 ±5。
export function serotoninBaselineAt(hour) {
  const h = (((Number(hour) || 0) % 24) + 24) % 24
  return 50 + 5 * Math.cos(((h - 13) / 24) * Math.PI * 2)
}

function clamp(v, lo = 0, hi = 100) {
  if (!Number.isFinite(v)) return Math.round((lo + hi) / 2)
  return Math.max(lo, Math.min(hi, v))
}

export function decayToward(current, baseline, elapsedMs, halfLifeMs) {
  return baseline + (current - baseline) * Math.pow(0.5, elapsedMs / halfLifeMs)
}

export function defaultChemistry(now = Date.now()) {
  return {
    version: 1,
    at: now,
    dopamine: 50,
    cortisol: 20,
    serotonin: 50,
    bias: { dopamine: 0, cortisol: 0, serotonin: 0 },
    // 被冷落的累积项（存盘，不现算）：主人很久不理 → 血清素基线往下、皮质醇往上；
    // 主人回来之后也不是瞬间复位，而是按天级速度慢慢缓和。
    neglect: { serotonin: 0, cortisol: 0 },
    // 只涨不落的累积项（#50）：事件里吸收的正增量会沉在这里，平时不衰减，
    // 只有长期被冷落（>2 天没互动）才按天级半衰慢慢回落。
    accent: { dopamine: 0, cortisol: 0, serotonin: 0 },
    history: [],
  }
}

const BIAS_HALF_LIFE_MS = 12 * 3600_000 // 事件留下的长期偏移 12 小时半衰，不会永久顶在基线里
const NEGLECT_TAU_MS = 8 * 3600_000 // 被冷落/被安抚的基线偏移 8 小时时间常数
// #50 只涨不落累积项：吸收事件正增量的 20%，封顶 ±25；>2 天没互动后按 1 天半衰回落。
const ACCENT_CAP = 25
const ACCENT_EVENT_RATE = 0.2
// #50/#10：累积项只有长期冷落才回落；日常互动下也要能慢慢消，不然被凶几次就钉死在上限。
// 12 小时没互动就开始 24h 半衰（原来 2 天，皮质醇会把「今天被凶」永远留着）。
const ACCENT_NEGLECT_GRACE_MS = 12 * 3600_000
const ACCENT_NEGLECT_HALF_LIFE_MS = 86_400_000

function normalizeAccent(raw) {
  const a = raw && typeof raw === 'object' ? raw : {}
  const pick = (v) => (Number.isFinite(Number(v)) ? Math.max(-ACCENT_CAP, Math.min(ACCENT_CAP, Number(v))) : 0)
  return { dopamine: pick(a.dopamine), cortisol: pick(a.cortisol), serotonin: pick(a.serotonin) }
}

function normalizeBias(raw) {
  const b = raw && typeof raw === 'object' ? raw : {}
  const pick = (v) => Math.max(-20, Math.min(20, Number.isFinite(Number(v)) ? Number(v) : 0))
  return { dopamine: pick(b.dopamine), cortisol: pick(b.cortisol), serotonin: pick(b.serotonin) }
}

function normalizeNeglect(raw) {
  const n = raw && typeof raw === 'object' ? raw : {}
  const pick = (v, lo, hi) => (Number.isFinite(Number(v)) ? Math.max(lo, Math.min(hi, Number(v))) : 0)
  return { serotonin: pick(n.serotonin, -20, 0), cortisol: pick(n.cortisol, 0, 15) }
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
    // 累积项：事件不只是「当下波动」，还会往长期基线上留一点偏移，半衰期以「天」计。
    // 没有这一项，一天不理人、回来三激素照旧被半衰拉回中位，等于什么都没发生。
    bias: normalizeBias(c.bias),
    neglect: normalizeNeglect(c.neglect),
    accent: normalizeAccent(c.accent),
    history: Array.isArray(c.history)
      ? c.history.filter((h) => h && typeof h === 'object' && Number.isFinite(h.at)).slice(0, 60)
      : [],
  }
}

export function createChemistry({ life, log }) {
  const load = () => normalizeChemistry(life.load().chemistry)

  // 被冷落的「目标」基线偏移：主人很久没说话时，血清素基线往下走、皮质醇基线往上抬。
  // 存量的 neglect 会按 NEGLECT_TAU_MS 朝这个目标慢慢逼近，而不是每次现算、主人一开口就瞬间归零。
  function neglectTarget(now) {
    try {
      const last = Number(life.load().life?.lastInteractionAt) || 0
      if (!last) return { serotonin: 0, cortisol: 0 }
      const days = Math.max(0, (now - last) / 86_400_000)
      return { serotonin: -Math.min(20, days * 4), cortisol: Math.min(15, days * 2.5) }
    } catch { return { serotonin: 0, cortisol: 0 } }
  }

  // 衰减到 now + 慢变量规则（按经过分钟积分：cor≥70 持续压制血清素；ser≥70 安抚皮质醇；dopamine≥75 缓冲应激），纯计算不落盘。
  function compute(c, now) {
    const elapsed = Math.max(0, now - c.at)
    const elapsedMin = elapsed / 60_000
    // 事件留下的长期偏移会自己回落（12 小时半衰）——否则一次吵架的 -20 会永久顶在基线里（复查 #5）。
    const rawBias = normalizeBias(c.bias)
    const bias = {
      dopamine: clamp(decayToward(rawBias.dopamine, 0, elapsed, BIAS_HALF_LIFE_MS), -20, 20),
      cortisol: clamp(decayToward(rawBias.cortisol, 0, elapsed, BIAS_HALF_LIFE_MS), -20, 20),
      serotonin: clamp(decayToward(rawBias.serotonin, 0, elapsed, BIAS_HALF_LIFE_MS), -20, 20),
    }
    // 被冷落：存量值朝目标基线慢慢走（主人回来一句话不会立刻复位）（复查 #6）。
    const negStored = normalizeNeglect(c.neglect)
    const negTarget = neglectTarget(now)
    const neglect = normalizeNeglect({
      serotonin: decayToward(negStored.serotonin, negTarget.serotonin, elapsed, NEGLECT_TAU_MS),
      cortisol: decayToward(negStored.cortisol, negTarget.cortisol, elapsed, NEGLECT_TAU_MS),
    })
    // #50 累积项：事件攒下来的长期底色，平时只涨不落；只有长期被冷落（>2 天没互动）才慢慢回落。
    const accentStored = normalizeAccent(c.accent)
    const lastInter = (() => { try { return Number(life.load().life?.lastInteractionAt) || 0 } catch { return 0 } })()
    const quietDays = lastInter ? Math.max(0, (now - lastInter) / 86_400_000) : 0
    const accentDecay = quietDays > ACCENT_NEGLECT_GRACE_MS / 86_400_000 ? Math.pow(0.5, elapsed / ACCENT_NEGLECT_HALF_LIFE_MS) : 1
    const accent = normalizeAccent({
      dopamine: accentStored.dopamine * accentDecay,
      cortisol: accentStored.cortisol * accentDecay,
      serotonin: accentStored.serotonin * accentDecay,
    })
    const dBias = bias.dopamine
    const corBias = bias.cortisol + neglect.cortisol
    const serBias = bias.serotonin + neglect.serotonin
    // 基线 = 日周期基线 + 事件偏移 + 只涨不落累积项（#50：日子本身要有起伏）。
    let d = decayToward(c.dopamine, dopamineBaselineAt(new Date(now).getHours()) + dBias + accent.dopamine, elapsed, CHEM.dopamine.halfLifeMin * 60_000)
    let cor = decayToward(c.cortisol, cortisolBaselineAt(new Date(now).getHours()) + corBias + accent.cortisol, elapsed, CHEM.cortisol.halfLifeMin * 60_000)
    let ser = decayToward(c.serotonin, serotoninBaselineAt(new Date(now).getHours()) + serBias + accent.serotonin, elapsed, CHEM.serotonin.halfLifeMin * 60_000)
    if (cor >= 70) ser -= 1.5 * elapsedMin // 慢变量：应激持续压制平静
    if (ser >= 70) cor -= 0.5 * elapsedMin // 慢变量：安全感安抚应激
    if (d >= 75) cor -= 0.5 * elapsedMin // 慢变量：兴奋缓冲应激（奖赏系统抑制 HPA 轴）
    return { version: 1, at: now, dopamine: clamp(d), cortisol: clamp(cor), serotonin: clamp(ser), bias, neglect, accent, history: c.history || [] }
  }

  // 落盘衰减结果（60s 心跳用，让状态文件保持最新）。
  // 读必须在锁内：锁外读、锁内整块写回会把别人刚写的事件增量抹掉（和 event/spend 同一类 bug）。
  function tick(now = Date.now()) {
    return life.update((st) => {
      const next = compute(normalizeChemistry(st.chemistry), now)
      st.chemistry = next
      return next
    })
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
      // 累积项：事件增量的一小部分沉到长期基线上（多巴胺偏正、皮质醇/血清素按方向各自累积），
      // 半衰期按天算，所以「最近过得怎么样」会留痕，不是每次都弹回中位。
      const bias = normalizeBias(c.bias)
      bias.dopamine = Math.max(-20, Math.min(20, bias.dopamine + dd2 * 0.12))
      bias.cortisol = Math.max(-20, Math.min(20, bias.cortisol + dc2 * 0.12))
      bias.serotonin = Math.max(-20, Math.min(20, bias.serotonin + ds2 * 0.12))
      // #50/#10 累积项：多巴胺/血清素只吸收正增量（好事会攒着）；
      // 皮质醇双向吸收——被安慰/被哄能抵消掉一点长期应激，否则天天在一起又常被凶会钉在上限。
      const accent = normalizeAccent(c.accent)
      accent.dopamine = Math.min(ACCENT_CAP, accent.dopamine + Math.max(0, dd2) * ACCENT_EVENT_RATE)
      accent.cortisol = Math.max(-ACCENT_CAP, Math.min(ACCENT_CAP, accent.cortisol + dc2 * ACCENT_EVENT_RATE))
      accent.serotonin = Math.min(ACCENT_CAP, accent.serotonin + Math.max(0, ds2) * ACCENT_EVENT_RATE)
      const next = {
        version: 1,
        at: now,
        dopamine: clamp(c.dopamine + dd2),
        cortisol: clamp(c.cortisol + dc2),
        serotonin: clamp(c.serotonin + ds2),
        bias,
        // neglect 是 compute 里朝目标缓慢逼近的存量值，事件不该把它重置。
        neglect: normalizeNeglect(c.neglect),
        accent,
        history: [
          {
            at: now,
            reason: String(reason || '').slice(0, 60),
            dopamine: Math.round(dd2 * 10) / 10,
            cortisol: Math.round(dc2 * 10) / 10,
            serotonin: Math.round(ds2 * 10) / 10,
            // 面板排查「为什么最近一直丧/一直绷着」：把事件后的累积偏移也记下来（复查 #16）。
            bias: {
              dopamine: Math.round(bias.dopamine * 10) / 10,
              cortisol: Math.round(bias.cortisol * 10) / 10,
              serotonin: Math.round(bias.serotonin * 10) / 10,
            },
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
    // 累积偏置会让她「这段时间」底色不一样：最近攒了太多闷/太多兴奋，哪怕当下数值正常也该透出来。
    const bias = normalizeBias(c.bias)
    if (bias.serotonin <= -8) parts.push('这段时间心里一直有点空，说话不太提得起劲')
    if (bias.cortisol >= 8) parts.push('这段时间一直绷着，放松不下来')
    if (bias.dopamine >= 8) parts.push('这段时间一直挺开心，整个人松快')
    // #50 只涨不落累积项：攒下来的长期底色，哪怕当下数值平了也该透出来。
    const accent = normalizeAccent(c.accent)
    if (accent.dopamine >= 12) parts.push('这段时间的开心攒下来了，整个人比平时松')
    if (accent.serotonin >= 12) parts.push('这段日子过得踏实，心里有底')
    if (accent.cortisol >= 12) parts.push('这段时间攒下的紧绷还在，没那么容易放下')
    if (!parts.length) return ''
    return '[身体状态] 你此刻' + parts.join('；') + '。这些不用说出来，让它从语气里自然透出来。'
  }

  return { load, tick, peek, event, history, state: () => { const c = peek(); return { ...c, history: history() } }, contextLine }
}
