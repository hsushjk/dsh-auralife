import { dataDir, readJson, writeJson, lockAndRun } from '../core/store.js'
import { isSilence, stripMarkdown } from '../chat/reply.js'

const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const SELF = 'bot'

// 逛空间没有每日上限来一条新留言就回一条（每条只回一次，s.replied 去重）。
// 每轮最多回 3 条是批次控制（一次系统轮不写太多条），不是上限——剩下的下个心跳继续。

export function cleanComment(text, max = 60) {
  const t = stripMarkdown(String(text || '')).replace(/\|\|\|/g, ' ').replace(/<[^>]+>/g, '').trim()
  if (!t || isSilence(t)) return ''
  const first = t.split(/\n+/).map((s) => s.trim()).filter(Boolean).slice(0, 2).join(' ')
  return first.length > max ? first.slice(0, max) : first
}

export function createAzoneSocial({ getConfig, hub, log, memory, azone, botName, emit, isSleeping }) {
  // botName 可以是 getter（host.js 传 identity 优先的动态取值）。
  // 睡觉时不逛空间、不回评论：睡着的数字生命不该在别人的留言下面说话。
  // isSleeping 也允许是 getter（host 里 sleep 器官创建得比这里晚，见 host.js 装配顺序）。
  const asleep = () => { try { return Boolean(isSleeping?.()) } catch { return false } }
  const herName = () => (typeof botName === 'function' ? botName() : botName) || 'AuraLife'
  const file = () => dataDir('azone-social.json')
  const load = () => readJson(file(), () => ({ day: '', count: 0, lastRun: 0, replied: {}, history: [] }))
  const save = (s) => writeJson(file(), s)
  let busy = false

  async function write(prompt) {
    const out = await hub.runSystemTurn('azone-social', '空间互动', `【空间互动，不是聊天，这一轮不会发到聊天里】\n${prompt}\n\n只输出回复正文本身，一两句、口语、不超过 40 个字，别加引号和前缀；不想评就只回 [沉默]。`, { timeoutMs: 120000 })
    return cleanComment(out)
  }

  function record(s, item) {
    s.history.unshift({ at: Date.now(), ...item })
    s.history = s.history.slice(0, 30)
    s.count++
  }

  // 把「这轮该回哪些留言」在锁内认领好：写 s.replied 的同时生成任务，立刻放锁。
  // 认领和生成分开——模型调用可能几分钟，绝不能放在锁里（#40/#41）。
  function collectTasks(s, budget) {
    const tasks = []
    const entries = azone.state().history
    for (const e of entries) {
      if (tasks.length >= budget) break
      for (const c of e.comments || []) {
        if (tasks.length >= budget) break
        const thread = [c, ...(c.replies || [])].sort((a, b) => Number(a.at || 0) - Number(b.at || 0))
        let lastMine = -1
        thread.forEach((x, i) => { if (String(x.from) === SELF) lastMine = i })
        const pending = thread.slice(lastMine + 1).filter((x) => String(x.from) !== SELF)
        if (!pending.length) continue
        const key = `${e.id}/${c.id}`
        const handled = new Set(s.replied[key] || [])
        const unhandled = pending.filter((x) => !handled.has(x.id))
        if (!unhandled.length) continue
        for (const x of unhandled) handled.add(x.id)
        s.replied[key] = [...handled].slice(-100)
        const last = unhandled[unhandled.length - 1]
        const threadText = thread.map((x) => `${x.name || '某人'}：${String(x.text).slice(0, 120)}`).join('\n')
        tasks.push({
          key,
          ids: unhandled.map((x) => x.id),
          entryId: e.id,
          commentId: c.id,
          postText: String(e.text || ''),
          last,
          prompt:
            `你在空间写过一条记录：「${String(e.text).slice(0, 200)}」\n` +
            `这条记录下面大家的留言：\n${threadText}\n\n` +
            `${last.name || '某人'} 刚刚说了新的话，结合记录内容和上面的留言，用你的口气接着回 TA 一句。`,
        })
      }
    }
    // 清理已经不存在（被删）的留言的认领记录，避免 replied 无限膨胀。
    const keep = new Set()
    for (const e of entries) for (const c of e.comments || []) keep.add(`${e.id}/${c.id}`)
    for (const k of Object.keys(s.replied)) if (!keep.has(k)) delete s.replied[k]
    return tasks
  }

  // 生成失败/空回复：把认领的 id 退回去，下一轮还会再试（#40）。
  async function releaseClaims(task) {
    try {
      await lockAndRun('azone-social', () => {
        const s = load()
        const cur = new Set(s.replied[task.key] || [])
        for (const id of task.ids) cur.delete(id)
        if (cur.size) s.replied[task.key] = [...cur].slice(-100)
        else delete s.replied[task.key]
        save(s)
      }, { staleMs: 30000, timeoutMs: 10000 })
    } catch (error) {
      log.warn('退回空间认领失败：', error.message)
    }
  }

  async function commitTask(task, text, s) {
    // 以前这里没 await：addReply 返回 Promise，写回失败/这条留言被删了也照记「已回复」。
    const r = await azone.addReply(task.entryId, task.commentId, { from: SELF, name: herName(), text })
    if (!r || r.ok === false) return false
    // 旧 memory.addEvent 已随记忆 v2 退役（v2 只有 remember/revise/forget），改走 remember。
    try {
      memory?.remember?.({
        text: `在空间回复了${task.last.name || '某人'}的留言：${String(text).slice(0, 80)}`,
        about: String(task.last.from),
        aboutName: String(task.last.name || ''),
        conf: 0.35,
        source: 'self_did',
        tags: ['空间'],
      })
    } catch {}
    record(s, { kind: 'reply', who: task.last.name, post: task.postText.slice(0, 30), text })
    emit?.('azone', { reason: 'reply', entryId: task.entryId })
    return true
  }

  async function run({ force = false } = {}) {
    const cfg = getConfig()
    const c = cfg.azoneSocial
    if (busy) return { ok: false, message: '正在逛空间' }
    if (!force && (!cfg.enabled || !c.enabled)) return { ok: false, message: '没打开' }
    // force 也不放行：睡着就是睡着，留言等她醒了自己会看到（下个心跳会补）。
    if (asleep()) return { ok: false, message: '她睡着了' }
    busy = true
    try {
      // 第一段（锁内）：只认领，不算模型。第二段（锁外）：逐条调模型。
      // 第三段（锁内）：写回记录；失败/空回复退回认领（#40/#41）。
      let tasks = []
      try {
        tasks = await lockAndRun('azone-social', () => {
          const s = load()
          if (s.day !== dayKey()) Object.assign(s, { day: dayKey(), count: 0 })
          s.lastRun = Date.now()
          const claimed = c.replyOwn === false ? [] : collectTasks(s, 3)
          save(s)
          return claimed
        }, { staleMs: 30000, timeoutMs: 10000 })
      } catch (error) {
        log.warn('逛空间认领失败：', error.message)
        return { ok: false, message: error.message }
      }

      let replies = 0
      for (let ti = 0; ti < tasks.length; ti++) {
        const task = tasks[ti]
        // 生成一条要几分钟；中途睡着了就把还没轮到的认领全退回去，别把留言占着。
        if (asleep()) {
          for (let j = ti; j < tasks.length; j++) await releaseClaims(tasks[j])
          break
        }
        let text = ''
        try {
          text = await write(task.prompt)
        } catch (error) {
          log.warn('逛空间生成失败：', error.message)
          await releaseClaims(task)
          continue
        }
        if (!text) {
          await releaseClaims(task)
          continue
        }
        try {
          const done = await lockAndRun('azone-social', async () => {
            const s = load()
            if (s.day !== dayKey()) Object.assign(s, { day: dayKey(), count: 0 })
            const ok = await commitTask(task, text, s)
            if (ok) save(s)
            return ok
          }, { staleMs: 30000, timeoutMs: 10000 })
          if (!done) { await releaseClaims(task); continue }
          replies++
        } catch (error) {
          log.warn('逛空间写回失败：', error.message)
          await releaseClaims(task)
        }
      }
      return { ok: true, message: `回了 ${replies} 条留言`, replies }
    } finally {
      busy = false
    }
  }

  async function tick() {
    const cfg = getConfig()
    const c = cfg.azoneSocial
    if (!cfg.enabled || !c.enabled) return
    await run()
  }

  return { run, tick, state: () => { const s = load(); return { count: s.day === dayKey() ? s.count : 0, lastRun: s.lastRun, history: s.history.slice(0, 15) } } }
}
