import { dataDir, readJson, writeJson, lockAndRun, numOr } from '../core/store.js'

const toMin = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number)
  return h * 60 + m
}
const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

const newId = (p = 'd') => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

// 空间日记节奏内置（/ 改）：没有篇数上限、没有强制间隔、没有「计划」。
// 触发器三种
//   1. 想写就写：Ta 自己有 web_write_diary 工具，任何时候都能写；
//   2. 闲着：距最后一条主人消息 ≥ 3 小时（醒着时段 08:00-23:30），每天最多 2 篇；
//   3. 有必要：当天有激素大波动（单次事件的激素增量绝对值 ≥5），每天最多 2 篇。
const DIARY_BUILTIN = { minChars: 60, maxChars: 140, idleAfterMinutes: 180, idleDailyMax: 2, eventDailyMax: 2, quietFrom: '08:00', quietTo: '23:30' }
// chemistry.history 存的是「这次事件涨跌了多少」（±几），不是 0-100 的绝对水平；
// 情绪事件的实际量级在 1-8（debug 手动可到 ±50），所以 5 才算「大波动」。
const SPIKE_DELTA = 5

export function createAzone({ getConfig, hub, log, onDiary, life }) {
  const file = () => dataDir('diary.json')
  const state = () => readJson(file(), () => ({ triggers: { day: '', idle: [], event: [] }, history: [] }))
  const save = (s) => writeJson(file(), s)
  // 多进程锁：多进程心跳会同时判「闲着该写日记」→ 重复写。RMW 走锁（异步，不阻塞事件循环）。
  const update = async (fn) => lockAndRun('diary', async () => {
    const s = state()
    const out = await fn(s)
    save(s)
    return out
  })
  let busy = false
  let lastFailAt = 0
  // #6：「有感而发」的由头要能跨进程/跨重启活下来，而且要有时效——
  // 14:00「聊得难受」的由头不该被 22:00 的闲着日记拿去用；进程重启也不该丢。
  // 存在 state.json 里（单槽，新事件覆盖旧事件），超过 6 小时自动作废。
  const CUE_TTL_MS = 6 * 3600_000
  function noteEvent(cue) {
    const text = String(cue || '').trim().slice(0, 200)
    if (!text) return
    update((s) => { s.cue = { text, at: Date.now() }; return s.cue }).catch(() => {})
  }
  function freshCue(s) {
    const c = s && s.cue
    if (!c || !c.text) return ''
    if (Date.now() - (Number(c.at) || 0) > CUE_TTL_MS) return ''
    return String(c.text)
  }

  // #6：写日记的公共流程：认领过的「due」时间戳失败时要按 at 精确回滚，
  // 不能用 pop()——那会删掉另一个进程刚认领的那条，把当天名额漏回去。
  async function runDiary(trigger, at) {
    let cue = ''
    try { cue = freshCue(state()) } catch {}
    let r = null
    try {
      r = await writeDiary({ cue })
    } catch (error) {
      log.warn('写日记抛错：' + (error?.message || error))
      r = { ok: false }
    }
    if (r && r.ok) {
      if (cue) { try { await update((s) => { s.cue = null }) } catch {} }
      return true
    }
    lastFailAt = Date.now()
    try {
      await update((s) => {
        const list = s.triggers && s.triggers[trigger]
        if (Array.isArray(list)) s.triggers[trigger] = list.filter((t) => Number(t) !== Number(at))
      })
    } catch {}
    return false
  }

  async function post(content, { visibility } = {}) {
    const cfg = getConfig()
    const text = String(content || '').trim()
    if (!text) return { ok: false, message: '记录是空的' }
    if (!cfg.enabled) return { ok: false, message: '总开关关着' }
    return update((s) => {
      const entry = {
        id: newId(),
        at: Date.now(),
        text,
        visibility: visibility || cfg.diary.visibility,
        comments: [],
      }
      s.history.unshift(entry)
      s.history = s.history.slice(0, 200)
      log.info(`写了一条记录（id ${entry.id}）`)
      return { ok: true, id: entry.id }
    })
  }

  async function remove(id) {
    return update((s) => {
      const before = s.history.length
      s.history = s.history.filter((e) => e.id !== id)
      return { ok: s.history.length < before }
    })
  }

  function todayExcerpt(maxLines = 60) {
    const cfg = getConfig()
    const owner = cfg.ownerName || '主人'
    const lines = hub.chatLogOf(dayKey())
      .filter((l) => !String(l.chatId).startsWith('system:'))
      .slice(-maxLines)
      .map((l) => {
        const time = new Date(l.t).toTimeString().slice(0, 5)
        if (l.who === 'bot') return `${time} 我：${l.text}`
        const who = l.uid === 'owner' ? owner : (l.uid ? `客人${String(l.uid).replace(/^guest-/, '')}` : '对方')
        return `${time} ${who}：${l.text}`
      })
    return lines.join('\n')
  }

  async function writeDiary({ visibility, force = false, cue = '' } = {}) {
    if (busy && !force) return { ok: false, message: '上一篇还在写' }
    busy = true
    // #6：cue 可以由调用方显式传入（噩梦），没传就用 state 里存的那条（6 小时内有效）。
    if (!cue) { try { cue = freshCue(state()) } catch {} }
    try {
      const now = new Date()
      const excerpt = todayExcerpt()
      // cue = 「有感而发」的由头（比如刚做的噩梦、忽然想起的一件小事），有它就不用等定时器。
      const cueLine = String(cue || '').trim() ? `刚才发生的事（写这篇的由头，别照抄、用自己的话写）：\n${String(cue).trim().slice(0, 600)}` : ''
      const prompt = [
        `【写空间日记】现在是 ${now.getMonth() + 1} 月 ${now.getDate()} 日 ${now.toTimeString().slice(0, 5)}。`,
        cueLine,
        excerpt ? `今天你在网页上的聊天片段（「我」是你自己）：\n${excerpt}` : '今天还没怎么聊天。',
        `请用你自己的口吻写一条记录（空间日记），第一人称，${DIARY_BUILTIN.minChars}~${DIARY_BUILTIN.maxChars} 个字，像真人随手写的记录：写今天真实发生的小事、此刻的心情或想法。`,
        '不要分条、不要 |||、不要 <voice>/<sticker> 标记、不要 Markdown、不要加引号，只输出记录正文本身。',
      ].filter(Boolean).join('\n\n')
      let text = await hub.runSystemTurn('diary', '空间日记', prompt)
      text = String(text || '').replace(/\|\|\|/g, ' ').replace(/<[^>]+>/g, '').replace(/^["「“]|["」”]$/g, '').trim()
      if (text.length > DIARY_BUILTIN.maxChars + 20) text = text.slice(0, DIARY_BUILTIN.maxChars + 20)
      if (!text || text === '[沉默]') return { ok: false, message: 'Ta 这次没写出来' }
      const r = await post(text, { visibility })
      if (r.ok) {
        try { onDiary?.(text) } catch (error) {}
      }
      return { ...r, text }
    } catch (error) {
      log.warn('写日记失败：', error.message)
      return { ok: false, message: error.message }
    } finally {
      busy = false
    }
  }

  async function tick() {
    const cfg = getConfig()
    if (!cfg.enabled || !cfg.diary.enabled) return
    if (Date.now() - lastFailAt < 5 * 60_000) return
    const today = dayKey()
    const now = new Date()
    const nowMin = now.getHours() * 60 + now.getMinutes()
    const inWindow = nowMin >= toMin(DIARY_BUILTIN.quietFrom) && nowMin <= toMin(DIARY_BUILTIN.quietTo)

    // #36：双进程抢写——不能「先看再写」（两边都看到 due、锁外各写一篇）。
    // 锁内先认领：通过就把时间戳推进 triggers（占住这次名额），写失败再回滚。
    let spikeAt = 0
    const gates = await update((s) => {
      if (!s.triggers || s.triggers.day !== today) s.triggers = { day: today, idle: [], event: [], eventAt: 0 }
      let dueIdle = false
      if (inWindow) {
        // #37：hub.lastOwnerChatAt 是进程内存，重启归零；用 life.lastSeenAt（落盘）兜底，
        // 不然「主人 3 小时没说话」这个条件重启后永远不成立，日记触发器废掉。
        const lastChat = Math.max(
          Number(hub.lastOwnerChatAt) || 0,
          Number(life?.load?.().life?.lastSeenAt) || 0,
        )
        if (lastChat && Date.now() - lastChat >= DIARY_BUILTIN.idleAfterMinutes * 60_000 && s.triggers.idle.length < DIARY_BUILTIN.idleDailyMax) dueIdle = true
      }
      let dueEvent = false
      if (!dueIdle) {
        // chemistry.history 每条只存「这次事件涨跌了多少」（dopamine/cortisol/serotonin 都是增量），
        // 不是 0-100 的绝对水平。以前拿增量去比「偏离基线 20 / 皮质醇 65」，只要当天有一条
        // 记录（哪怕全是 0）就恒真 → 10 分钟防重窗口一过必然再写一篇，天天两篇。
        // 现在按增量阈值找「最近一次真正的大波动」，并用 eventAt 记下已被哪篇日记消费过。
        let latest = null
        try {
          const hist = (life && life.load && life.load().chemistry && life.load().chemistry.history) || []
          for (const h of hist) {
            if (!h || !h.at) continue
            if (dayKey(new Date(h.at)) !== today) continue
            const delta = Math.max(Math.abs(numOr(h.dopamine, 0)), Math.abs(numOr(h.cortisol, 0)), Math.abs(numOr(h.serotonin, 0)))
            if (delta < SPIKE_DELTA) continue
            if (!latest || h.at > latest.at) latest = h
          }
        } catch {}
        const consumed = numOr(s.triggers.eventAt, 0)
        if (latest && latest.at > consumed && s.triggers.event.length < DIARY_BUILTIN.eventDailyMax) {
          dueEvent = true
          spikeAt = latest.at
        }
      }
      // 另一个进程刚认领过（10 分钟内）→ 让位，避免双进程同一波各写一篇。
      const recent = [...(s.triggers.idle || []), ...(s.triggers.event || [])].some((t) => Number.isFinite(Number(t)) && Date.now() - Number(t) < 10 * 60_000)
      if (recent) return {}
      if (dueIdle) { const at = Date.now(); s.triggers.idle.push(at); return { due: 'idle', at } }
      if (dueEvent) { const at = Date.now(); s.triggers.event.push(at); s.triggers.eventAt = spikeAt || at; return { due: 'event', at } }
      return {}
    })

    // 触发器 2「闲着」：距最后一条主人消息 ≥3 小时（醒着时段内），每天最多 2 篇
    if (gates.due === 'idle') {
      log.info('闲着有一阵了，写一篇空间日记')
      await runDiary('idle', gates.at)
      return
    }
    // 触发器 3「有必要」：当天激素有大波动（情绪值得记），每天最多 2 篇
    if (gates.due === 'event') {
      log.info('今天情绪有大波动，写一篇空间日记')
      await runDiary('event', gates.at)
    }
  }

  function visibleEntries(role) {
    const s = state()
    return s.history.filter((e) => role === 'owner' || e.visibility === 'all')
  }

  function entryById(id) {
    return state().history.find((e) => e.id === id)
  }

  function addComment(entryId, { from, name, text }) {
    return update((s) => {
      const e = s.history.find((x) => x.id === entryId)
      if (!e) return { ok: false, message: '这条记录没了' }
      const c = { id: newId('c'), from, name, text: String(text || '').trim(), at: Date.now(), replies: [] }
      e.comments.push(c)
      return { ok: true, id: c.id, at: c.at }
    })
  }

  function addReply(entryId, commentId, { from, name, text }) {
    return update((s) => {
      const e = s.history.find((x) => x.id === entryId)
      const c = e?.comments.find((x) => x.id === commentId)
      if (!c) return { ok: false, message: '这条留言没了' }
      const r = { id: newId('r'), from, name, text: String(text || '').trim(), at: Date.now() }
      c.replies.push(r)
      return { ok: true, id: r.id, at: r.at }
    })
  }

  function deleteComment(entryId, commentId) {
    return update((s) => {
      const e = s.history.find((x) => x.id === entryId)
      if (!e) return { ok: false, message: '这条记录没了' }
      const before = e.comments.length
      e.comments = e.comments.filter((c) => c.id !== commentId)
      return { ok: e.comments.length < before }
    })
  }

  function deleteReply(entryId, commentId, replyId) {
    return update((s) => {
      const e = s.history.find((x) => x.id === entryId)
      const c = e?.comments.find((x) => x.id === commentId)
      if (!c) return { ok: false, message: '这条留言没了' }
      const before = c.replies.length
      c.replies = c.replies.filter((r) => r.id !== replyId)
      return { ok: c.replies.length < before }
    })
  }

  function stats() {
    const s = state()
    const today = dayKey()
    const startOfToday = new Date()
    startOfToday.setHours(0, 0, 0, 0)
    const todayCount = s.history.filter((e) => e.at >= startOfToday.getTime()).length
    // 删「计划 N 篇」——没有计划，想写就写；触发器见 tick()（闲着/有必要）
    const idleLeft = Math.max(0, DIARY_BUILTIN.idleDailyMax - ((s.triggers && s.triggers.idle) || []).length)
    const eventLeft = Math.max(0, DIARY_BUILTIN.eventDailyMax - ((s.triggers && s.triggers.event) || []).length)
    return { today: todayCount, total: s.history.length, idleLeft, eventLeft }
  }

  // 删客人：按登录 subject 清掉他在空间里的留言/回复（addComment/addReply 的 from 就是 me.subject）。
  // 日记 body 里如果提到过这个客人属于聊天内容，不在这里动——只清结构化留言，避免误伤她的创作。
  function purgeSubject(subject) {
    const subj = String(subject || '')
    if (!subj) return Promise.resolve({ ok: false, removed: 0 })
    return update((s) => {
      let removed = 0
      for (const e of s.history || []) {
        if (!Array.isArray(e.comments)) continue
        const keep = []
        for (const c of e.comments) {
          if (c.from === subj) {
            // 整条留言都删掉（含下面所有回复）；计数只算他本人的那些记录。
            removed++
            if (Array.isArray(c.replies)) removed += c.replies.filter((r) => r.from === subj).length
            continue
          }
          if (Array.isArray(c.replies)) {
            const keptReplies = c.replies.filter((r) => r.from !== subj)
            removed += c.replies.length - keptReplies.length
            c.replies = keptReplies
          }
          keep.push(c)
        }
        e.comments = keep
      }
      return { ok: true, removed }
    })
  }

  return {
    post,
    remove,
    writeDiary,
    noteEvent,
    tick,
    history: () => state().history,
    visibleEntries,
    entryById,
    addComment,
    addReply,
    deleteComment,
    deleteReply,
    purgeSubject,
    stats,
    state,
  }
}
