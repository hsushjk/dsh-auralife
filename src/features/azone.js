import { dataDir, readJson, writeJson, withFileLock } from '../core/store.js'

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
//   3. 有必要：当天有激素大波动（多巴胺偏离基线 ≥20 或皮质醇 ≥65），每天最多 2 篇。
const DIARY_BUILTIN = { minChars: 60, maxChars: 140, idleAfterMinutes: 180, idleDailyMax: 2, eventDailyMax: 2, quietFrom: '08:00', quietTo: '23:30' }

export function createAzone({ getConfig, hub, log, onDiary, life }) {
  const file = () => dataDir('diary.json')
  const state = () => readJson(file(), () => ({ triggers: { day: '', idle: [], event: [] }, history: [] }))
  const save = (s) => writeJson(file(), s)
  // 多进程锁：多进程心跳会同时判「闲着该写日记」→ 重复写。RMW 走锁。
  const update = (fn) => withFileLock('diary', () => {
    const s = state()
    const out = fn(s)
    save(s)
    return out
  })
  let busy = false
  let lastFailAt = 0

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

  async function writeDiary({ visibility, force = false } = {}) {
    if (busy && !force) return { ok: false, message: '上一篇还在写' }
    busy = true
    try {
      const now = new Date()
      const excerpt = todayExcerpt()
      const prompt = [
        `【写空间日记】现在是 ${now.getMonth() + 1} 月 ${now.getDate()} 日 ${now.toTimeString().slice(0, 5)}。`,
        excerpt ? `今天你在网页上的聊天片段（「我」是你自己）：\n${excerpt}` : '今天还没怎么聊天。',
        `请用你自己的口吻写一条记录（空间日记），第一人称，${DIARY_BUILTIN.minChars}~${DIARY_BUILTIN.maxChars} 个字，像真人随手写的记录：写今天真实发生的小事、此刻的心情或想法。`,
        '不要分条、不要 |||、不要 <voice>/<sticker> 标记、不要 Markdown、不要加引号，只输出记录正文本身。',
      ].join('\n\n')
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

    // 先锁内看今天的触发器计数（顺带重置跨天），再决定要不要写——双进程不会同时开写。
    const gates = update((s) => {
      if (!s.triggers || s.triggers.day !== today) s.triggers = { day: today, idle: [], event: [] }
      let dueIdle = false
      if (inWindow) {
        const lastChat = Number(hub.lastOwnerChatAt) || 0
        if (lastChat && Date.now() - lastChat >= DIARY_BUILTIN.idleAfterMinutes * 60_000 && s.triggers.idle.length < DIARY_BUILTIN.idleDailyMax) dueIdle = true
      }
      let dueEvent = false
      if (!dueIdle) {
        let spike = false
        try {
          const hist = (life && life.load && life.load().chemistry && life.load().chemistry.history) || []
          spike = hist.some((h) => {
            const d = h.at ? new Date(h.at) : null
            if (!d || dayKey(d) !== today) return false
            const maxAbs = Math.max(Math.abs(h.dopamine - 50), Math.abs(h.serotonin - 50))
            return maxAbs >= 20 || h.cortisol >= 65
          })
        } catch {}
        if (spike && s.triggers.event.length < DIARY_BUILTIN.eventDailyMax) dueEvent = true
      }
      return { dueIdle, dueEvent }
    })

    // 触发器 2「闲着」：距最后一条主人消息 ≥3 小时（醒着时段内），每天最多 2 篇
    if (gates.dueIdle) {
      log.info('闲着有一阵了，写一篇空间日记')
      const r = await writeDiary()
      if (r?.ok) update((s) => { s.triggers.idle.push(Date.now()) }) 
      else lastFailAt = Date.now()
      return
    }
    // 触发器 3「有必要」：当天激素有大波动（情绪值得记），每天最多 2 篇
    if (gates.dueEvent) {
      log.info('今天情绪有大波动，写一篇空间日记')
      const r = await writeDiary()
      if (r?.ok) update((s) => { s.triggers.event.push(Date.now()) })
      else lastFailAt = Date.now()
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

  return {
    post,
    remove,
    writeDiary,
    tick,
    history: () => state().history,
    visibleEntries,
    entryById,
    addComment,
    addReply,
    deleteComment,
    deleteReply,
    stats,
    state,
  }
}
