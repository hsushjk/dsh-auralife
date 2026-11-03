// life/energy.js — 身体（体力，S3 简化版）。
// 血条 level（体力）：纯作息驱动（DESIGN-modular.md §4）——每次模型请求消耗、随时间恢复，
// 不跟宿主机 CPU/内存挂钩（需求 3）。口粮（余额映射）已按用户要求删除。
// 内部全部浮点计算，只在展示层取整——避免 0.5/次 被 Math.round 吃掉导致「体力没变化」。

import { inRange } from '../core/time.js'

function clamp(v, lo = 0, hi = 100) {
  if (!Number.isFinite(v)) return lo
  return Math.max(lo, Math.min(hi, v))
}

// 内置常量（§3）：消耗与恢复速率归 Ta 自己，用户不可调。
// 0.8/次 + 0.8/分钟清醒、1.6/分钟睡觉聊 10 条约 -8（微微累），不聊慢慢回，睡觉回得更快。
const ENERGY_BUILTIN = { costPerRequest: 0.8, recoverPerMinute: 0.8, recoverAsleepPerMinute: 1.6 }

export function defaultEnergy(now = Date.now()) {
  return { version: 1, at: now, level: 100 }
}

export function normalizeEnergy(raw, now = Date.now()) {
  const d = defaultEnergy(now)
  const e = raw && typeof raw === 'object' ? raw : {}
  return {
    version: Number(e.version) || d.version,
    at: Number(e.at) || now,
    level: Number.isFinite(Number(e.level)) ? clamp(Number(e.level), 0, 100) : d.level,
  }
}

export function createEnergy({ life, getConfig, log }) {
  const load = () => normalizeEnergy(life.load().energy)
  // 跨进程锁内写回（多进程各跑 tick 时避免覆盖对方的消耗/恢复）
  const save = (e) => life.update((st) => { st.energy = e })

  // 睡觉（Ta 的作息静默期）恢复更快：「不聊天干活就恢复，睡觉时恢复更快」。
  const asleep = (now) => {
    const r = life.load().rhythm || {}
    return inRange(new Date(now), r.quietFrom, r.quietTo)
  }

  // 纯读：血条恢复到 now（不落盘），浮点值。
  function peek(now = Date.now()) {
    const e = load()
    const elapsedMin = Math.max(0, (now - e.at) / 60_000)
    const rate = asleep(now) ? ENERGY_BUILTIN.recoverAsleepPerMinute : ENERGY_BUILTIN.recoverPerMinute
    const level = clamp(e.level + elapsedMin * rate, 0, 100)
    return { version: 1, at: now, level }
  }

  // 落盘恢复结果（60s 心跳用）。
  function tick(now = Date.now()) {
    const next = peek(now)
    save(next)
    return next
  }

  // 消耗：每次模型请求 −costPerRequest。读-算-写整体进锁（审计：spend 的读在锁外，跨进程增量会被抹掉）。
  function spend(now = Date.now()) {
    return life.update((st) => {
      const raw = normalizeEnergy(st.energy)
      const elapsedMin = Math.max(0, (now - raw.at) / 60_000)
      const rate = asleep(now) ? ENERGY_BUILTIN.recoverAsleepPerMinute : ENERGY_BUILTIN.recoverPerMinute
      const level = clamp(clamp(raw.level + elapsedMin * rate, 0, 100) - ENERGY_BUILTIN.costPerRequest, 0, 100)
      const next = { version: 1, at: now, level }
      st.energy = next
      return next
    })
  }

  const state = peek

  // 行为指令（内感受铁律：不报数不命名）。
  function contextLine() {
    const e = peek()
    if (e.level <= 10) return '[身体状态] 你此刻累得厉害，只能勉强回一句，说话都费劲。这些不用说出来，从语气里自然透出来。'
    if (e.level < 30) return '[身体状态] 你此刻挺累的，句子要短，不想主动开新话题。这些不用说出来，从语气里自然透出来。'
    if (e.level < 55) return '[身体状态] 你此刻有点乏，话别太长。这些不用说出来，从语气里自然透出来。'
    return ''
  }

  return { load, tick, peek, spend, state: peek, contextLine }
}
