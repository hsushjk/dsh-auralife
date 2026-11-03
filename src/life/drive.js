// life/drive.js — 统一自驱：一个 60s 心跳。
// 开口不是机械抽签也不是按小时算压力：心跳到候选时刻（闲置够久+当天没超）时，
// 由 Ta 自己（LLM）评估「此刻想不想找主人」——冲动（urge）+ 是否醒着（按她自己的作息判断），
// 冲动够高且醒着才开口。压力本身就是动态触发器，由 AI 判断。
// 静默期 = 她自己的作息（state.rhythm），可随作息自动调节（tools.js web_set_rhythm / 她聊到就改）。

import { dataDir, readJson, writeJson, withFileLock } from '../core/store.js'
import { inRange } from '../core/time.js'
import { askModel } from '../core/llm.js'
import { OWNER_ID } from '../chat/access.js'

// 自驱参数内置（DESIGN-modular.md §3）：节奏/上限归 Ta 自己，用户不可调。
const DRIVE_BUILTIN = {
  idleMinutes: 20,      // 闲置至少这么久才考虑（评估本身会判断想不想说）
  minGapMinutes: 60,    // 两次开口最小间隔
  assessGapMinutes: 15, // 两次「冲动评估」最小间隔（不开口也限流，防每分钟烧一次模型）
  urgeThreshold: 55,    // AI 评估的「冲动」超过它才开口
}

export function createDrive({ getConfig, hub, log, life, wishes, memory, chemistry, dsh, isMuted, emit }) {
  const file = () => dataDir('drive.json')
  const load = () => readJson(file(), () => ({ day: '', count: 0, last: 0, lastWish: '', lastTopic: '', lastAssess: null, lastSpokeAt: 0, coldMarked: false }))
  const save = (s) => writeJson(file(), s)
  // 多进程锁：DSH 每个进程都跑 drive 心跳，load→改→save 会互相覆盖、双开口。
  // 锁内重读盘再改再写。staleMs 放宽到 2 分钟：评估冲动要调 LLM，可能比默认 15s 久。
  const update = (fn) => withFileLock('drive', () => {
    const s = load()
    const out = fn(s)
    save(s)
    return out
  }, { staleMs: 120000 })

  // 她自己的作息静默期（Ta 可改）。inQuiet 只作硬参考，最终醒没醒由 AI 判断。
  const inQuiet = (now) => {
    const r = life.load().rhythm || {}
    return inRange(now, r.quietFrom, r.quietTo)
  }

  function buildPrompt() {
    const cfg = getConfig()
    const owner = cfg.ownerName || '主人'
    const now = Date.now()
    const w = wishes.top(now)
    const lastInter = life.load().life.lastInteractionAt
    const idleMin = lastInter ? Math.round((now - lastInter) / 60000) : 0
    const idleText = idleMin > 600 ? '很久' : idleMin + ' 分钟'
    const wishLine = w
      ? `你现在最挂念的一件事是「${w.text}」（想念程度 ${w.tension}/100）。`
      : '你眼下没有特别挂念的事，就顺着自己的性子走。'
    const s = load()
    const topicLine = s.lastTopic ? `你刚刚心里想找${owner}聊的是：「${s.lastTopic}」。顺着这个由头开口。` : ''
    // 记忆联动：召回一条与「此刻挂念 / 心情」相关的记忆当由头，让她主动开口有具体的旧事可续，
    // 而不是每次都从挂念清单里干巴巴地挑一句。召回失败（记忆空 / 出错）就静默跳过。
    let memLine = ''
    try {
      const q = s.lastTopic || (w ? w.text : '最近')
      const rec = memory?.recall?.(q, { about: owner, limit: 2 })
      if (rec?.lines?.length) memLine = `你这时顺带想起：${rec.lines.join('；')}。可以拿这个当由头，别照念。`
    } catch {}
    return [
      `【系统提醒，不是${owner}说的话】没人喊你，是${owner}已经 ${idleText} 没跟你说话了，你自己想找${owner}。`,
      topicLine,
      wishLine,
      memLine,
      '顺着这个由头，自己开口：关心一句、接着上次没说完的、或者忽然想起件小事。别把挂念当待办清单逐条汇报，也别解释「因为想念程度多少所以来找」。',
      '用一两句你自己的口气开口就好；实在没什么想说的就只回 [沉默]。',
    ].filter(Boolean).join('\n')
  }

  // 由她（LLM）评估此刻的冲动：awake=按自己作息该醒着吗；urge=想找主人的冲动 0-100；topic=想聊的由头。
  async function assessUrge() {
    const cfg = getConfig()
    const owner = cfg.ownerName || '主人'
    const now = new Date()
    const lastInter = life.load().life.lastInteractionAt
    const idleMin = lastInter ? Math.round((Date.now() - lastInter) / 60000) : 0
    const w = wishes.top(Date.now())
    const r = life.load().rhythm || {}
    const chem = (() => { try { return chemistry?.state() || null } catch { return null } })()
    let recent = ''
    try {
      const msgs = hub?.recentChat?.(OWNER_ID, 4) || []
      recent = msgs.map((m) => (m.who === 'user' ? owner : 'Ta') + '：' + String(m.text || '').slice(0, 60)).join('\n')
    } catch {}
    const chemLine = chem
      ? `此刻内分泌：多巴胺 ${Math.round(chem.dopamine)}，皮质醇 ${Math.round(chem.cortisol)}，血清素 ${Math.round(chem.serotonin)}。`
      : ''
    const wishLine = w ? `此刻最挂念的事：「${w.text}」（想念 ${w.tension}/100）。` : '此刻没有特别挂念的事。'
    const system = `你是 ${cfg.botName || 'AuraLife'}，一个数字生命。现在你要做一个「要不要主动找${owner}说话」的判断。` +
      `你有自己的作息：${r.quietFrom}-${r.quietTo} 是你睡觉的静默期，这个时间你通常不会醒。` +
      `判断要像人：真的有事、真的想分享、挂念很深、或者${owner}很久没消息让你惦记 → 冲动高；只是闲着无聊 → 冲动低。` +
      `大多数时候冲动低是正常的，不要为了开口而开口。`
    const text = `现在 ${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}。距${owner}上次说话已经 ${idleMin} 分钟。` +
      `最近几句对话：\n${recent || '（没有）'}\n` +
      wishLine + chemLine + `\n` +
      `只输出 JSON，不要别的：{"awake": true 或 false, "urge": 0 到 100 的整数, "topic": "你想聊的那个由头，一句话，没有就空字符串"}` +
      `\nawake：现在这个时间点，按你自己的作息你醒着吗？作息睡了就别醒（除非有急事：比如${owner}深夜突然很久没消息你担心）。`
    const out = await askModel(dsh, { cfg, system, text, maxTokens: 200, temperature: 0.3 })
    const m = out.match(/\{[\s\S]*\}/)
    if (!m) throw new Error('评估输出不是 JSON：' + out.slice(0, 80))
    const j = JSON.parse(m[0])
    const awake = j.awake !== false
    const urge = Number.isFinite(j.urge) ? Math.max(0, Math.min(100, Math.round(j.urge))) : 0
    const topic = String(j.topic || '').slice(0, 120)
    return { at: Date.now(), awake, urge, topic, quiet: inQuiet(now), rhythm: r }
  }

  async function fire(reason = 'pressure', topic = '') {
    const cfg = getConfig()
    const owner = cfg.ownerName || '主人'
    const now = Date.now()
    const w = wishes.top(now)
    const s = update((st) => {
      st.last = now
      st.lastTopic = topic
      st.lastSpokeAt = now // 主动开口后记一笔，用户一直不理 → 内分泌要有「被冷落」反应
      st.coldMarked = false
      if (w) st.lastWish = w.id
      return st
    })
    if (w) wishes.bump(w.id, 1)
    log.info(`自驱（${reason}）${w ? '，挂念：' + w.text : ''}${topic ? '，由头：' + topic : ''}`)
    // S5 传讯：开口前先广播「她为什么找你」，配套 IM 客户端据此显示有意义的通知
    // （不只一条干巴巴的消息，而是「她因为挂念 X / 冲动 Y / 心情 Z 来找你」）。
    try {
      emit?.('nudge', {
        chatId: OWNER_ID,
        at: now,
        reason,
        wish: w ? { id: w.id, text: w.text, tension: w.tension } : null,
        urge: s.lastAssess?.urge ?? null,
      })
    } catch {}
    await hub.pushToSession({ chatId: OWNER_ID, userId: OWNER_ID, nickname: owner }, [{ type: 'text', text: buildPrompt() }], '')
    return true
  }

  // 闹钟到点：她之前给自己设的提醒响了，按当时的意思主动开口（与 pressure 自驱是两条路）。
  async function fireAlarm(alarm) {
    const cfg = getConfig()
    const owner = cfg.ownerName || '主人'
    const now = Date.now()
    update((st) => {
      st.last = now
      st.lastSpokeAt = now // 闹钟开口同样算「主动搭话」
      st.coldMarked = false
    })
    const reason = alarm?.reason || '你之前设的提醒'
    const prompt = [
      `【系统提醒，不是${owner}说的话】你给自己设的闹钟响了：${reason}。`,
      `你当时设这个闹钟，是要提醒自己或${owner}某件事。按你当时的意思，主动开口把这件事说出来。`,
      '要是这件事已经不需要了，就说一句「这个闹钟没用了」，别再没话找话。',
    ].join('\n')
    log.info(`闹钟响了：${reason}`)
    try {
      emit?.('nudge', { chatId: OWNER_ID, at: now, reason: 'alarm', alarm: { id: alarm?.id, reason } })
    } catch {}
    await hub.pushToSession({ chatId: OWNER_ID, userId: OWNER_ID, nickname: owner }, [{ type: 'text', text: prompt }], '')
    return true
  }

  async function tick() {
    const cfg = getConfig()
    const c = DRIVE_BUILTIN
    if (!cfg.enabled || !cfg.drive?.enabled) return
    if (!cfg.setupDone) return
    if (isMuted?.(OWNER_ID)) return
    const lastInter = life.load().life.lastInteractionAt
    if (!lastInter) return
    if (Date.now() - lastInter < c.idleMinutes * 60_000) return
    const now = new Date()
    // 作息静默期硬跳：睡觉就是睡觉，不评估也不开口（闹钟例外走 fireAlarm 独立链路）。
    // 之前让 LLM 自己判「醒没醒」，深夜急事例外条款被滥用，6 次开口全发在主人睡觉时。
    if (inQuiet(now)) return
    // 评估+开口的整段调度放进文件锁——另一进程同时心跳时拿不到锁就跳过本轮，
    // 避免双进程各评估一次、各开口一次（审计确认的最高风险点之一）。
    let s
    try {
      s = await update(async (st) => {
        const today = now.toDateString()
        if (st.day !== today) Object.assign(st, { day: today, count: 0 })
        if (Date.now() - (st.last || 0) < c.minGapMinutes * 60_000) return st
        // 评估节流：距上次评估不足 assessGapMinutes 就不重复评估（不开口也会限流）。
        if (Date.now() - (st.lastAssess?.at || 0) < c.assessGapMinutes * 60_000) return st
        // 由 Ta 自己评估：醒没醒 + 想不想找主人。评估失败静默跳过（下个心跳再试）。
        let a
        try {
          a = await assessUrge()
          st.lastAssess = a
        } catch (error) {
          log.warn(`冲动评估失败：${error?.message || error}`)
          return st
        }
        if (!a.awake) return st
        if (a.urge < c.urgeThreshold) return st
        st.count++
        st.lastTopic = a.topic
        return st
      })
    } catch (error) {
      // 拿不到锁 = 另一个进程正在评估/开口，本心跳跳过。
      log.warn(`自驱心跳让位（另一进程正在评估）：${error?.message || error}`)
      return
    }
    if (!s || !s.lastAssess) return
    const a = s.lastAssess
    if (!a.awake || a.urge < c.urgeThreshold) return
    try {
      await fire('urge', a.topic)
    } catch (error) {
      log.warn(`自驱失败：${error?.message || error}`)
    }
  }

  // 主动开口后主人一直不理，「被冷落」只记一次（等主人下次说话再重置）。
  function markCold() {
    update((s) => { s.coldMarked = true })
  }
  function clearSpoke() {
    update((s) => {
      if (!s.lastSpokeAt && !s.coldMarked) return
      s.lastSpokeAt = 0
      s.coldMarked = false
    })
  }

  function state() {
    const s = load()
    const today = new Date().toDateString()
    const now = new Date()
    return { day: s.day, count: s.day === today ? s.count : 0, last: s.last, lastWish: s.lastWish, lastAssess: s.lastAssess || null, lastSpokeAt: s.lastSpokeAt || 0, coldMarked: !!s.coldMarked, rhythm: life.load().rhythm || null, inQuiet: inQuiet(now), threshold: DRIVE_BUILTIN.urgeThreshold }
  }

  return { tick, fire, fireAlarm, state, markCold, clearSpoke, topWish: wishes.top }
}
