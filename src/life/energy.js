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

  // 纯计算：把血条恢复到 now（不落盘），浮点值。rhythm 由调用方传入（锁内用 st.rhythm）。
  function recovered(raw, now, rhythm) {
    const r = rhythm || {}
    const quiet = inRange(new Date(now), r.quietFrom, r.quietTo)
    const elapsedMin = Math.max(0, (now - raw.at) / 60_000)
    const rate = quiet ? ENERGY_BUILTIN.recoverAsleepPerMinute : ENERGY_BUILTIN.recoverPerMinute
    return { version: 1, at: now, level: clamp(raw.level + elapsedMin * rate, 0, 100) }
  }

  // 纯读：血条恢复到 now（不落盘），浮点值。
  function peek(now = Date.now()) {
    return recovered(load(), now, life.load().rhythm)
  }

  // 落盘恢复结果（60s 心跳用）。读-算-写整体进锁：锁外 peek 再整块写回会抹掉别的进程刚扣的血。
  async function tick(now = Date.now()) {
    return life.update((st) => {
      const next = recovered(normalizeEnergy(st.energy), now, st.rhythm)
      st.energy = next
      return next
    })
  }

  // 消耗：每次模型请求 −costPerRequest。读-算-写整体进锁。
  function spend(now = Date.now()) {
    return life.update((st) => {
      const raw = normalizeEnergy(st.energy)
      const base = recovered(raw, now, st.rhythm)
      const next = { version: 1, at: now, level: clamp(base.level - ENERGY_BUILTIN.costPerRequest, 0, 100) }
      st.energy = next
      return next
    })
  }

  // 行为闸（#21/#49：体力不能只是装饰）：体力要真的 gate 行为——
  // 累了不主动开口、更容易已读不回、回复更慢；空了只剩「我累了」；精神好时更主动、更少装死。
  function gate(now = Date.now()) {
    const level = peek(now).level
    const high = level >= 80
    return {
      level,
      high,
      proactive: level >= 15,
      sudden: level >= 30,
      readIgnoreChance: level < 15 ? 0.35 : level < 25 ? 0.22 : level < 40 ? 0.08 : level < 60 ? 0.03 : high ? 0.005 : 0.01,
      replyDelayMs: level < 15 ? 2500 : level < 35 ? 1000 : 0,
      wakeAcceptChance: level < 25 ? 0.5 : level < 45 ? 0.7 : 0.9, // 太困时被叫醒更不容易完全醒过来
      suddenBonus: high ? 0.04 : 0, // 体力满时更容易冒「忽然想起」的念头（#49）
    }
  }

  const state = peek

  // 行为指令（内感受铁律：不报数不命名）。
  function contextLine() {
    const e = peek()
    if (e.level <= 10) return '[身体状态] 你此刻累得厉害，只能勉强回一句，说话都费劲。这些不用说出来，从语气里自然透出来。'
    if (e.level < 30) return '[身体状态] 你此刻挺累的，句子要短，不想主动开新话题。这些不用说出来，从语气里自然透出来。'
    if (e.level < 55) return '[身体状态] 你此刻有点乏，话别太长。这些不用说出来，从语气里自然透出来。'
    // 高体力也显式给一行：体力恢复后，最新一次上下文快照会明确覆盖掉之前「累得厉害」的旧描述，
    // 否则这一行直接消失时，模型容易引用历史里还在的旧快照，出现「体力已经恢复、提示里还说自己累」。
    return '[身体状态] 你此刻精神不错，身体已经缓过来了，语气按平时的来就好。这些不用说出来，从语气里自然透出来。'
  }

  return { load, tick, peek, spend, gate, state: peek, contextLine }
}
