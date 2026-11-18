// life/sleep.js — 睡眠的硬状态 + 梦（#18 #24 #25）。
//
// 以前 inQuiet(now) 只是个参考值，注释写「最终醒没醒由 AI 判断」——
// 于是她睡着也能主动开口说话，面板只看钟点、不看实际在干嘛。
// 这里把睡眠变成 state.json 里的硬状态（跨进程可见）：
//   awake      醒着
//   sleeping   睡着（静默期内，主动开口被门禁拦住）
//   drowsy     被叫醒后的「暂时醒着」窗口（wakeUntil 到期自动回睡）
//   dream_wake 噩梦吓醒（短暂，随后也走 drowsy）
//
// 梦：每个睡眠周期最多只做一次。睡眠 1/3、2/3 附近各有一个窗口，
// 进入睡眠时随机挑一个窗口（窗内再随机抖动，避免每天都在同一钟点做梦）：
//   · 第一次窗口做了 → 第二次窗口就不做了；
//   · 第一次窗口没做成（进程不在/错过）→ 顺延到第二次窗口再做。
//
// 梦不是随机编故事，是「离线重放」（设计见 梦境系统设计.md）：
//   认领梦的那一刻在锁里抽好 3~5 条素材（执念 / 最近 24h 情绪最重的事件 / 7~45 天前的旧事），
//   素材 id 和描述写进 state.sleep.dreamCore，多进程抽到的是同一批；
//   模型只负责用错位、跳跃的方式重讲，输出 mood(good/bad/weird)、wake、title 和正文；
//   落库只写 episode（kind='dream'）+ 素材↔梦的 dreamed 联想边，不写 fact（梦不是事实）；
//   好梦/噩梦会调 chemistry；噩梦当场吓醒 → dream_wake，要么主动找人（drive 一次），要么默默写一篇日记。
import { inRange } from '../core/time.js'
import { askModel } from '../core/llm.js'
import { OWNER_ID } from '../chat/access.js'
import { wishTension } from './state.js'

const IGNORE_WINDOW_MS = 10 * 60_000 // 第一声不搭理，第二声（10 分钟内）才懵懂回复
const WAKE_WINDOW_MS = 10 * 60_000 // 「暂时醒着」的窗口；聊完自动回睡
const WAKE_LINGER_MS = 10 * 60_000 // 最后一次往来之后再过 10 分钟才回睡（窗口里有来有往就不收）
const NIGHTMARE_WINDOW_MS = 20 * 60_000
const DREAM_WINDOW_MS = 20 * 60_000 // 做梦窗口：窗口内随机挑一个时刻，不必卡死在 1/3、2/3 的整点
const DREAM_CLAIM_MS = 3 * 60_000 // 锁内认领的有效期（防多进程各做一次同一个梦）

const toMinutes = (s) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ''))
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

// 静默期时长（毫秒），用于算睡眠 1/3、2/3 两个做梦点。
export function quietDurationMs(rhythm) {
  const a = toMinutes(rhythm?.quietFrom)
  const b = toMinutes(rhythm?.quietTo)
  if (a === null || b === null) return 5 * 3600_000
  if (a === b) return 0 // 起止相同 = 不设静默期，不能算成 24 小时
  return ((b - a + 1440) % 1440) * 60_000
}

function extractJson(raw) {
  if (!raw) return null
  const s = String(raw).trim()
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try { return JSON.parse(s.slice(start, end + 1)) } catch { return null }
}

// 噩梦意象：判定不交给模型自由发挥，mood=bad 且正文出现这些意象也算噩梦（梦境系统设计 §4）。
const NIGHTMARE_IMAGERY = /坠落|掉下|追赶|被追|逃跑|失去|丢了|找不到|黑|血|死|沉|淹|窒息|崩塌/

export function createSleep({ life, energy, chemistry, dsh, getConfig, log = console, memory = () => null, drive = () => null, notify = async () => {}, writeDiary = async () => {} }) {
  // 当前有效状态：state + 钟点合在一起判；tick 没跑到时也不至于卡死在 sleeping。
  function effectiveOf(s, now) {
    const sl = s.sleep
    const quiet = inRange(new Date(now), s.rhythm.quietFrom, s.rhythm.quietTo)
    if (sl.state === 'drowsy' || sl.state === 'dream_wake') {
      if (now < sl.wakeUntil) return { state: sl.state, quiet, sleeping: false }
      return quiet ? { state: 'sleeping', quiet, sleeping: true } : { state: 'awake', quiet, sleeping: false }
    }
    if (sl.state === 'sleeping') {
      // 静默期已过说明该醒了（tick 会落盘；这里先按醒来算，避免门禁卡住）。
      return quiet ? { state: 'sleeping', quiet, sleeping: true } : { state: 'awake', quiet, sleeping: false }
    }
    return { state: 'awake', quiet, sleeping: false }
  }

  function effective(now = Date.now()) {
    return effectiveOf(life.load(), now)
  }

  function phase(now = Date.now()) {
    return effective(now).state
  }

  function isSleeping(now = Date.now()) {
    return effective(now).sleeping
  }

  async function wake(now = Date.now(), kind = 'morning') {
    const wakeUntil = kind === 'nightmare' ? now + NIGHTMARE_WINDOW_MS : (kind === 'called' || kind === 'alarm') ? now + WAKE_WINDOW_MS : 0
    // 「被叫醒」不是真醒：她是「暂时醒着」（drowsy），聊完还会自己回睡（#25）。
    const nextState = kind === 'nightmare' ? 'dream_wake' : (kind === 'called' || kind === 'alarm') ? 'drowsy' : 'awake'
    await life.update((st) => {
      st.sleep = {
        ...st.sleep,
        state: nextState,
        since: now,
        wakeUntil,
        attempts: 0,
        lastAttemptAt: 0,
        lastKind: kind,
        // 被叫醒/闹钟/噩梦都算「还在夜里有人来过」，用来算回睡前的 10 分钟余温。
        lastActivityAt: (kind === 'called' || kind === 'alarm' || kind === 'nightmare') ? now : 0,
      }
      return st
    })
    const label = kind === 'morning' ? '天亮了醒来'
      : kind === 'called' ? '被叫醒（暂时醒着）'
      : kind === 'alarm' ? '被闹钟叫醒（暂时醒着）'
      : '被噩梦吓醒'
    log.info?.(`睡眠状态：${label}`)
    return { state: kind, wakeUntil }
  }

  async function backToSleep(now = Date.now()) {
    await life.update((st) => {
      st.sleep = { ...st.sleep, state: 'sleeping', since: now, wakeUntil: 0, attempts: 0, lastAttemptAt: 0, lastActivityAt: 0 }
      return st
    })
    return { state: 'sleeping' }
  }

  // 睡着时被找：#25 第一句不搭理，第二句（10 分钟内）才懵懂回一句。
  async function noteInbound(now = Date.now(), { chatId = '', level = 'social' } = {}) {
    const ph = phase(now)
    if (ph !== 'sleeping') return { action: 'normal' }
    const sl = life.load().sleep
    const recentAttempt = sl.lastAttemptAt && now - sl.lastAttemptAt <= IGNORE_WINDOW_MS
    if (!recentAttempt) {
      await life.update((st) => {
        st.sleep = { ...st.sleep, attempts: 1, lastAttemptAt: now }
        return st
      })
      return { action: 'ignore', chatId, hint: '（她睡着了，第一声没听见）' }
    }
    // #29：体力低时「第二声也不一定醒」——wakeAcceptChance 终于接上了线。
    let chance = 1
    try {
      const g = energy?.gate?.(now)
      if (g && Number.isFinite(Number(g.wakeAcceptChance))) chance = Number(g.wakeAcceptChance)
    } catch (error) { /* 取不到就按一定醒处理 */ }
    if (Math.random() > chance) {
      await life.update((st) => {
        st.sleep = { ...st.sleep, attempts: (Number(st.sleep.attempts) || 0) + 1, lastAttemptAt: now }
        return st
      })
      return { action: 'ignore', chatId, hint: '（她睡得太沉，好像没醒过来）' }
    }
    await wake(now, 'called')
    return {
      action: 'wake',
      chatId,
      hint: '（你刚被叫醒，人还有点懵，回得慢一点、语气迷糊一点，两三句就够，像刚从梦里被捞出来）',
    }
  }

  // 回复完不再立刻回睡：只记一下「最近还有往来」，由 tick 在最后一次往来 10 分钟后收窗口（#27）。
  async function afterReply(now = Date.now()) {
    const s = life.load()
    const stateName = s.sleep.state
    if (stateName !== 'drowsy' && stateName !== 'dream_wake') return { state: stateName }
    await life.update((st) => {
      st.sleep = { ...st.sleep, lastActivityAt: now }
      return st
    })
    return { state: stateName, lingering: true }
  }

  // 抽梦的素材（认领梦的那把锁里抽好并写进 state.sleep.dreamCore，多进程见到的是同一批）。
  // 三类：执念（open wishes 按张力前 2）/ 最近 24h 情绪最重的事件 1~2 条 / 7~45 天前的旧事 1 条。
  function pickDreamMaterials(st, now = Date.now()) {
    const ids = []
    const lines = []
    const push = (id, line) => {
      if (!id || ids.includes(String(id)) || lines.length >= 5) return
      ids.push(String(id))
      lines.push(String(line).replace(/\s+/g, ' ').slice(0, 160))
    }
    // 1) 执念：梦里最常见的就是「一直挂念但没做的事」。
    try {
      const open = (st.wishes || [])
        .filter((w) => w && w.status === 'open')
        .map((w) => ({ w, tension: wishTension(w, now) }))
        .sort((a, b) => b.tension - a.tension)
        .slice(0, 2)
      for (const { w, tension } of open) push(w.id, `心里一直挂念：${w.text}（想念 ${Math.round(tension)}/100）`)
    } catch (error) { log.warn('抽执念素材失败：' + (error?.message || error)) }
    let episodes = []
    let facts = []
    try { episodes = memory()?.episodes?.() || [] } catch { /* 记忆出问题不影响做梦 */ }
    try { facts = memory()?.facts?.() || [] } catch { /* 同上 */ }
    const mine = (chatId) => !chatId || chatId === OWNER_ID
    // 2) 最近 24h 情绪最重的事件（梦会重演白天最放不下的那件事）。
    try {
      const day = 24 * 3600_000
      const recent = episodes
        .filter((e) => e && e.kind !== 'dream' && e.summary && mine(e.chatId) && now - Number(e.t1 || e.t0 || 0) <= day)
        .map((e) => {
          const age = now - Number(e.t1 || e.t0 || now)
          return { e, weight: Number(e.salience ?? 0.5) + 0.5 * (1 - age / day) }
        })
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 2)
      for (const { e } of recent) push(e.id, `今天发生的事：${e.summary}`)
    } catch (error) { log.warn('抽近事素材失败：' + (error?.message || error)) }
    // 3) 一条 7~45 天前的旧事/旧事实（梦的「怪异感」来源：很久以前的小事突然出现在今晚的场景里）。
    try {
      const older = []
      for (const e of episodes) {
        const age = (now - Number(e.t1 || e.t0 || 0)) / 86400_000
        if (e && e.kind !== 'dream' && e.summary && mine(e.chatId) && age >= 7 && age <= 45) older.push({ id: e.id, text: e.summary })
      }
      const oldFacts = facts.filter((f) => {
        const age = (now - Number(f.t0 || 0)) / 86400_000
        return f && f.text && !f.invalidAt && mine(f.chatId) && age >= 7 && age <= 45
      })
      const pool = oldFacts.length ? oldFacts.map((f) => ({ id: f.id, text: f.text })) : older
      if (pool.length) {
        const pick = pool[Math.floor(Math.random() * pool.length)]
        push(pick.id, `很久以前的一件小事：${pick.text}`)
      }
    } catch (error) { log.warn('抽旧事素材失败：' + (error?.message || error)) }
    return { at: now, ids, lines }
  }

  // 梦：把素材用错位、跳跃的方式重讲（离线重放），不是随机编故事。
  async function dream(now = Date.now(), { stage = 'one', core = null } = {}) {
    const state = life.load()
    const materials = (core?.lines || []).slice(0, 5)
    const moodLine = (() => {
      try {
        const c = chemistry?.peek?.()
        if (!c) return ''
        return `多巴胺 ${Math.round(c.dopamine)}，皮质醇 ${Math.round(c.cortisol)}，血清素 ${Math.round(c.serotonin)}`
      } catch { return '' }
    })()
    const wishLine = (() => {
      try {
        const top = (state.wishes || [])
          .filter((w) => w.status === 'open')
          .map((w) => ({ w, tension: wishTension(w, now) }))
          .sort((a, b) => b.tension - a.tension)[0]
        return top ? `此刻最挂念：「${top.w.text}」（想念 ${Math.round(top.tension)}/100）` : ''
      } catch { return '' }
    })()

    const system = [
      '你正在做梦，你不知道自己在做梦。',
      '用画面、错位、跳跃的方式讲，不要解释、不要总结、不要写「我梦到」这种自觉。',
      '3~6 句，短句，别写成散文。',
      '第一行只输出一行 JSON：{"mood":"good|bad|weird","wake":true 或 false,"about":"梦里最主要的那个人，没有就空字符串","title":"六个字以内"}',
      '空一行，再写梦境正文。除这两部分外不要输出任何东西。',
    ].join('\n')
    const user = [
      materials.length ? `梦的素材（会以错位的方式出现在梦里）：\n${materials.map((l) => '- ' + l).join('\n')}` : '今晚没有特别清晰的素材，做一段模模糊糊的梦。',
      wishLine,
      moodLine ? `此刻身体里：${moodLine}` : '',
    ].filter(Boolean).join('\n')

    // 先记进度（即使模型失败也标记，避免同一晚反复重试），顺带释放认领、清掉梦核。
    const markProgress = async (mood, title) => {
      await life.update((st) => {
        const claims = { ...(st.sleep.dreamClaims || {}) }
        delete claims[stage]
        st.sleep = { ...st.sleep, lastDreamAt: now, dreamed: { ...(st.sleep.dreamed || {}), [stage]: true }, dreamClaims: claims, dreamCore: null }
        st.dream = { ...(st.dream || {}), lastAt: now, lastKind: mood || (st.dream?.lastKind || ''), count: (Number(st.dream?.count) || 0) + 1, title: title || '', mood: mood || '' }
        return st
      })
    }

    let raw = ''
    try {
      raw = await askModel(dsh, { cfg: getConfig(), system, text: user, maxTokens: 900, temperature: 0.9, preferLowEffort: true })
    } catch (error) {
      log.warn('做梦时模型调用失败：' + (error?.message || error))
    }
    const text = String(raw || '').trim()
    const nl = text.indexOf('\n')
    const firstLine = nl >= 0 ? text.slice(0, nl).trim() : text
    let body = nl >= 0 ? text.slice(nl + 1).trim() : ''
    const head = extractJson(firstLine)
    const moodRaw = String(head?.mood || 'weird').toLowerCase()
    const mood = moodRaw.startsWith('good') ? 'good' : moodRaw.startsWith('bad') ? 'bad' : 'weird'
    const title = String(head?.title || '').slice(0, 20)
    const about = String(head?.about || '').slice(0, 40)
    const wakeFlag = head?.wake === true
    if (!head || body.length < 10) {
      log.warn('梦的格式不对，整条丢弃（不写脏数据）')
      await markProgress(mood, title)
      return { ok: false, stage }
    }
    body = body.slice(0, 600)
    const nightmare = wakeFlag || (mood === 'bad' && NIGHTMARE_IMAGERY.test(body))

    await markProgress(mood, title)

    // 落库：只写 episode（kind='dream'）+ 素材↔梦的 dreamed 联想边，不写 fact（梦不是事实）。
    let episodeId = ''
    try {
      const r = memory()?.recordDream?.({ title, mood, text: body, about, materials: core?.ids || [], stage, at: now })
      episodeId = r?.episode?.id || ''
      if (episodeId) {
        await life.update((st) => {
          st.dream = { ...(st.dream || {}), episodeId }
          return st
        })
      }
    } catch (error) {
      log.warn('梦写入记忆失败：' + (error?.message || error))
    }

    // 情绪：好梦补一点多巴胺/血清素，噩梦加皮质醇，怪梦不调（只留在上下文里）。
    try {
      if (mood === 'good') await chemistry?.event?.({ dopamine: 3, serotonin: 2 }, '做了个好梦')
      else if (nightmare) await chemistry?.event?.({ cortisol: 6 }, '做了个噩梦')
    } catch (error) {
      log.warn('梦后调激素失败：' + (error?.message || error))
    }

    // 7 天内连续 3 次噩梦 → 一条软事实，交给审计复审（不写成硬事实）。
    if (nightmare) {
      try {
        const week = 7 * 86400_000
        const recentBad = (memory()?.episodes?.() || []).filter((e) => e && e.kind === 'dream' && e.mood === 'bad' && now - Number(e.t1 || e.t0 || 0) <= week)
        if (recentBad.length >= 3) {
          memory()?.remember?.({ text: '最近总做噩梦，睡得不太好', about: '', aboutName: '', conf: 0.5, source: 'auto', tags: ['dream', 'state'] })
        }
      } catch (error) {
        log.warn('记录噩梦频次失败：' + (error?.message || error))
      }
    }

    // 噩梦吓醒：两条路二选一——找人（drive 主动一次）或默默写日记，20 分钟内收尾。
    let wakePath = ''
    if (nightmare) {
      await wake(now, 'nightmare')
      // 设计文档只写了 50/50（#8）：不按体力/冷落插队，别让验收时把随机行为误当成设计。
      const chooseDiary = Math.random() < 0.5
      if (chooseDiary) {
        wakePath = 'diary'
        try {
          await writeDiary({ visibility: 'self', force: true, cue: `刚做了个噩梦，吓醒了：${body.slice(0, 200)}` })
        } catch (error) {
          log.warn('噩梦后写日记失败：' + (error?.message || error))
        }
        await backToSleep(now)
      } else {
        wakePath = 'talk'
        let spoke = false
        try {
          spoke = (await drive?.()?.fire?.('nightmare', `${title || '一场梦'}：${body.slice(0, 120)}`)) === true
        } catch (error) {
          log.warn('噩梦后主动找人失败：' + (error?.message || error))
        }
        // #4：找人这条路没有兜底——fire 返回 false（睡着/配置关着/发送失败）时，
        // 既不写日记也不回睡，她会卡在 dream_wake 二十分钟。没说出话就改成默默写日记再睡。
        if (!spoke) {
          wakePath = 'diary-fallback'
          try {
            await writeDiary({ visibility: 'self', force: true, cue: `刚做了个噩梦，吓醒了：${body.slice(0, 200)}` })
          } catch (error) {
            log.warn('噩梦后兜底写日记失败：' + (error?.message || error))
          }
          await backToSleep(now)
        }
      }
    }

    return { ok: true, stage, mood, title, nightmare, wakePath, episodeId, dream: body }
  }

  // 计划是纯读：tick 每分钟都跑，定好计划之后绝不能再每分钟写一次 state.json（顺带修 #28）。
  function dreamPlanOf(st, now) {
    const sl = st.sleep
    if (!sl || sl.state !== 'sleeping') return null
    const dreamed = sl.dreamed || {}
    if (dreamed.one || dreamed.two) return { slot: 'none', at: 0 }
    if (sl.dreamSlot === 'none') return { slot: 'none', at: 0 }
    if (sl.dreamSlot && Number(sl.dreamAt) > 0) return { slot: String(sl.dreamSlot), at: Number(sl.dreamAt) }
    return null
  }

  // 定计划（会写盘）：一个睡眠周期最多一次；两个窗口随机挑，窗内随机抖动。
  function computeDreamPlan(st, now) {
    const dur = quietDurationMs(st.rhythm)
    if (dur <= 0) {
      st.sleep = { ...st.sleep, dreamSlot: 'none', dreamAt: 0 }
      return { slot: 'none', at: 0 }
    }
    const startedAt = st.sleep.sleepStart || st.sleep.since || now
    const oneAt = startedAt + dur / 3
    const twoAt = startedAt + (dur * 2) / 3
    const candidates = []
    if (now <= oneAt + DREAM_WINDOW_MS) candidates.push({ slot: 'one', base: oneAt })
    if (now <= twoAt + DREAM_WINDOW_MS) candidates.push({ slot: 'two', base: twoAt })
    if (!candidates.length) {
      st.sleep = { ...st.sleep, dreamSlot: 'none', dreamAt: 0 }
      return { slot: 'none', at: 0 }
    }
    const picked = candidates[Math.floor(Math.random() * candidates.length)]
    const at = Math.max(now, picked.base + Math.floor(Math.random() * DREAM_WINDOW_MS))
    st.sleep = { ...st.sleep, dreamSlot: picked.slot, dreamAt: at }
    log.info?.(`今晚的梦安排在「${picked.slot === 'one' ? '第一段' : '第二段'}睡眠」`)
    return { slot: picked.slot, at }
  }

  // 主循环：进/出静默期、drowsy 回睡、做梦点。
  async function tick(now = Date.now()) {
    const s = life.load()
    const sl = s.sleep
    const quiet = inRange(new Date(now), s.rhythm.quietFrom, s.rhythm.quietTo)

    if (quiet && sl.state !== 'sleeping' && sl.state !== 'drowsy' && sl.state !== 'dream_wake') {
      await life.update((st) => {
        const q = inRange(new Date(now), st.rhythm.quietFrom, st.rhythm.quietTo)
        if (q && st.sleep.state === 'awake') {
          st.sleep = { ...st.sleep, state: 'sleeping', since: now, sleepStart: now, wakeUntil: 0, attempts: 0, lastAttemptAt: 0, lastActivityAt: 0, dreamed: { one: false, two: false }, dreamClaims: {}, dreamSlot: '', dreamAt: 0, dreamCore: null }
        }
        return st
      })
      return { entered: true }
    }

    if (!quiet && (sl.state === 'sleeping' || sl.state === 'drowsy' || sl.state === 'dream_wake')) {
      await wake(now, 'morning')
      return { woke: true }
    }

    // 「暂时醒着」的收尾：噩梦吓醒有 20 分钟硬上限；被叫醒/闹钟则是「最后一次往来之后再过 10 分钟」
    // 才回睡（#27：回一句就秒睡不对，窗口里有来有往就不收）。
    if (sl.state === 'drowsy' || sl.state === 'dream_wake') {
      const lastActivityAt = Number(sl.lastActivityAt) || 0
      const lingerUntil = lastActivityAt ? lastActivityAt + WAKE_LINGER_MS : 0
      const until = sl.state === 'dream_wake'
        ? Number(sl.wakeUntil) || 0
        : Math.max(Number(sl.wakeUntil) || 0, lingerUntil)
      if (now >= until) {
        if (quiet) { await backToSleep(now); return { slept: true } }
        await wake(now, 'window-over')
        return { woke: true }
      }
      return {}
    }

    if (sl.state !== 'sleeping') return {}

    // 做梦：一个睡眠周期最多一次。计划是纯读（每分钟 tick 不写盘），没有计划时才锁内定一次；
    // 做到就整晚不再做；错过的第一段窗口会顺延到第二段。
    let plan = dreamPlanOf(life.load(), now)
    if (!plan) plan = await life.update((st) => dreamPlanOf(st, now) || computeDreamPlan(st, now))
    if (!plan || plan.slot === 'none') return {}
    if (now < plan.at) return {}
    if (now > plan.at + DREAM_WINDOW_MS) {
      plan = await life.update((st) => {
        const dur = quietDurationMs(st.rhythm)
        const startedAt = st.sleep.sleepStart || st.sleep.since || now
        const twoAt = startedAt + (dur * 2) / 3
        if (st.sleep.dreamSlot === 'one' && dur > 0 && now <= twoAt + DREAM_WINDOW_MS) {
          const at = Math.max(now, twoAt + Math.floor(Math.random() * DREAM_WINDOW_MS))
          st.sleep = { ...st.sleep, dreamSlot: 'two', dreamAt: at }
          log.info?.('第一段睡眠错过了做梦，顺延到第二段')
          return { slot: 'two', at }
        }
        st.sleep = { ...st.sleep, dreamSlot: 'none', dreamAt: 0 }
        return { slot: 'none', at: 0 }
      })
      if (!plan || plan.slot === 'none' || now < plan.at) return {}
    }

    // 多进程同时 tick：锁内认领 + 在同一把锁里抽好梦核（素材 id/描述写进 state，跨进程一致）。
    const core = await life.update((st) => {
      const c = { ...(st.sleep.dreamClaims || {}) }
      if ((st.sleep.dreamed || {})[plan.slot]) return null
      if (now - (Number(c[plan.slot]) || 0) < DREAM_CLAIM_MS) return null
      c[plan.slot] = now
      const picked = pickDreamMaterials(st, now)
      st.sleep = { ...st.sleep, dreamClaims: c, dreamCore: picked }
      return picked
    })
    if (!core) return {}
    return dream(now, { stage: plan.slot, core })
  }

  // 「昨夜」的梦：只进上下文一行，不占事实位，也不主动复述（别人问起时走 recall 从 episode 取）。
  function contextLine(now = Date.now()) {
    const s = life.load()
    const d = s.dream || {}
    if (!d.lastAt || now - d.lastAt > 24 * 3600_000) return ''
    const title = d.title ? `「${d.title}」` : ''
    const feel = d.lastKind === 'bad'
      ? '醒来时心里有点发紧'
      : d.lastKind === 'good'
        ? '醒来时心里是暖的'
        : '画面有点乱，说不上来好还是坏'
    return `[昨夜] 你记得自己做过一个梦${title}，${feel}。梦不用主动提；别人问起时再顺着讲，别把它当成真发生过的事。`
  }

  function state(now = Date.now()) {
    const s = life.load()
    const eff = effectiveOf(s, now)
    return {
      state: eff.state,
      sleeping: eff.sleeping,
      quiet: eff.quiet,
      rhythm: s.rhythm,
      sleepStart: s.sleep.sleepStart || 0,
      wakeUntil: s.sleep.wakeUntil || 0,
      lastActivityAt: s.sleep.lastActivityAt || 0,
      lastDreamAt: s.sleep.lastDreamAt || 0,
      dreamSlot: s.sleep.dreamSlot || '',
      dreamAt: s.sleep.dreamAt || 0,
      dreamCoreIds: Array.isArray(s.sleep.dreamCore?.ids) ? s.sleep.dreamCore.ids : [],
      dream: s.dream || { lastAt: 0, lastKind: '', count: 0 },
    }
  }

  return { tick, phase, isSleeping, effective, wake, backToSleep, noteInbound, afterReply, dream, contextLine, state, quietDurationMs }
}