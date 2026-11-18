import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, appendFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { readFile, writeFile, readdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { dataDir, readJson, writeJson, lockAndRun } from '../core/store.js'
import { parseReply, bubbleDelay } from './reply.js'
import { levelFor, presetForChat, isOwner, OWNER_ID } from './access.js'
import { fetchImage } from '../core/net.js'
import { mimeOf } from '../core/image.js'
import { createHistory, SEGMENT_LIMIT, DEFAULT_KEEP_DAYS } from './history.js'

const WORKSPACE_DIR = process.env.AURALIFE_WORKSPACE || join(homedir(), 'AuraLife', 'chats')
const WORKSPACE_TITLE = 'AuraLife · Web'
const SOURCE_KIND = 'auralife'
const BUSY_MAX_MS = 5 * 60 * 1000
const MAX_TYPING_HOLD_MS = 60 * 1000
const MERGE_MAX_SEC = 8 // 连发合并的最长窗口（内置，用户不可调）
const ROTATE_RATIO = 0.85 // 估算用量超过窗口 85% 就归档旧会话、开新会话
const ROTATE_FIXED_TOKENS = 2000 // 平台固定开销估算（系统提示+工具定义+注入上下文）
const MODEL_WINDOW_FALLBACK = { 'deepseek-chat': 64000, 'deepseek-reasoner': 64000, 'deepseek-flash': 128000, 'deepseek-v3': 128000 }
const DEFAULT_WINDOW = 64000

const delay = (ms) => new Promise((r) => setTimeout(r, ms))
const sessionKey = (id) => String(id || '').replace(/^session-/, '')

export function createHub({
  dsh, getConfig, log, stickers, tts, buildTools, contextProviders, dynamicContext,
  onActivity, isMuted, moodEffects, emit, getModelPreference, sleepStage, energy,
}) {
  // sleepStage/energy 在 host 里创建顺序靠后：用 getter 延迟取，避免循环依赖。
  // 注意：注入的是「睡眠器官」的 getter，名字不能叫 sleep——会遮蔽模块级的 delay 语义（B）。
  const sleepOf = () => (typeof sleepStage === 'function' ? sleepStage() : sleepStage)
  const energyOf = () => (typeof energy === 'function' ? energy() : energy)
  const chatlogDir = () => dataDir('chatlog')
  const sessionsFile = () => dataDir('sessions.json')
  const history = createHistory({
    log,
    emit: (type, payload) => emit?.(type, payload),
    getKeepDays: () => {
      // 聊天记录原文保留天数：用户可改，默认 30 天；记忆事实在 mem/ 里永久留，不受这个影响。
      const n = Number(getConfig().history?.keepDays)
      return Number.isFinite(n) && n > 0 ? n : DEFAULT_KEEP_DAYS
    },
  })

  const mounted = new WeakMap()
  const sessionToChat = new Map()
  const turnState = new Map()
  const pending = new Map()
  // #19：低体力时「看到了先缓几秒再回」。缓的时间挂在 chat 上、消息照常入队，
  // flush 到点时按队列顺序回——不能用 setTimeout 重新 enqueue（后一句会插到前一句前面），
  // 也不能丢掉原消息的 wantVoice（语音请求要跟着一起保留）。
  const replyHoldUntil = new Map() // chatId -> 最早可回复的时间戳
  const typingUntil = new Map()
  const busy = new Set()
  const busyTimers = new Map()
  const waiting = new Set()
  const usageCache = new Map() // chatId -> { t, tokens, window, ratio }
  const usageReal = new Map() // chatId -> { t, used }（平台 assistant/message.usage 报的真实 token）
  const rotatedChats = new Map() // chatId -> { at, n }（本进程内：该 chat 已经归档转生过的次数）
  let liveWindow = 0 // DSH 平台真实窗口：session/event 里 request/context 事件带 contextWindow（如 1M）
  let liveModel = ''

  // #17：stats 要落盘，不然面板的 turns/messages/voice 一重启就归零。写盘做 2 秒防抖。
  const statsFile = () => dataDir('stats.json')
  let stats = (() => {
    try {
      const saved = readJson(statsFile(), () => null)
      if (saved && typeof saved === 'object') {
        return { turns: 0, messages: 0, voice: 0, stickers: 0, images: 0, files: 0, errors: 0, ...saved }
      }
    } catch {}
    return { turns: 0, messages: 0, voice: 0, stickers: 0, images: 0, files: 0, errors: 0 }
  })()
  let statsTimer = null
  // stats.json 是跨进程共享文件：「整份读、整份写」会谁后写谁赢（面板数字回退/丢数）。
  // 内存里只记「本进程自上次落盘以来的增量」，落盘时进锁读盘、把增量加上去，失败就把增量放回去。
  const statsPending = {}
  function flushStats() {
    const pending = { ...statsPending }
    const keys = Object.keys(pending)
    if (!keys.length) return Promise.resolve()
    for (const k of keys) {
      if (statsPending[k] === pending[k]) delete statsPending[k]
      else statsPending[k] -= pending[k]
    }
    return lockAndRun('stats', async () => {
      const saved = readJson(statsFile(), () => null)
      const base = { turns: 0, messages: 0, voice: 0, stickers: 0, images: 0, files: 0, errors: 0 }
      if (saved && typeof saved === 'object') for (const k of Object.keys(base)) base[k] = Number(saved[k]) || 0
      for (const k of keys) base[k] = (Number(base[k]) || 0) + pending[k]
      await writeJson(statsFile(), base)
      stats = base
    }, { staleMs: 10000, timeoutMs: 5000 }).catch((error) => {
      // 拿不到锁就把增量放回去，下一轮再试，绝不丢数。
      for (const k of keys) statsPending[k] = (statsPending[k] || 0) + pending[k]
      log.warn('统计落盘失败：' + (error?.message || error))
    })
  }
  function persistStatsSoon() {
    if (statsTimer) return
    statsTimer = setTimeout(() => {
      statsTimer = null
      flushStats()
    }, 2000)
    statsTimer.unref?.()
  }
  let lastChatAt = 0
  let lastOwnerChatAt = 0
  let lastBotToOwner = null
  // 已读不回（#19）：看到但此刻不想/不能回的消息先记着；drive 过几分钟来补一句。
  // #47：以前只活在这个进程的内存里——drive 跑在另一个进程/重启后就再也补不上。
  // 现在落盘到 data/pending-reply.json，跨进程读；认领时用锁 + claimedAt 防两个进程各补一遍。
  let pendingReply = null
  const pendingFile = () => dataDir('pending-reply.json')
  function persistPendingReply(p) {
    pendingReply = p || null
    try {
      writeJson(pendingFile(), p || null)?.catch?.((error) => log.warn('未回消息落盘失败：' + (error?.message || error)))
    } catch (error) {
      log.warn('未回消息落盘失败：' + (error?.message || error))
    }
  }

  const bump = (k) => {
    stats[k] = (stats[k] || 0) + 1
    statsPending[k] = (statsPending[k] || 0) + 1
    persistStatsSoon()
  }
  const mood = () => (typeof moodEffects === 'function' ? moodEffects() : null) || { sticker: 1, voice: 1, delay: 1, chatty: 1 }

  // 多进程下每个进程都跑一份插件，sessions.json 的读写要进锁，防互相覆盖丢会话映射。
  // 读路径不再进锁：writeJson 走「暂存文件 + rename」原子替换，读到的永远是完整 JSON；
  // 锁只串行化写，避免异步锁把同步读接口（sessions()）也拖成 Promise。
  function map() { return readJson(sessionsFile(), () => ({ chats: {} })) }
  // 读-改-写必须在同一把锁里完成：先读盘 → 改一条 → 整份写回。
  // 以前是「锁外读快照、只锁写」，两个进程同时开新会话时后写的那个会用旧快照覆盖掉前一个，
  // 映射一丢就落到重建会话。所有写入口都必须 await 这个函数。
  function updateMap(mutator, opts = {}) {
    return lockAndRun('sessions', () => {
      const m = readJson(sessionsFile(), () => ({ chats: {} }))
      if (!m || typeof m !== 'object') throw new Error('sessions.json 内容异常')
      if (!m.chats || typeof m.chats !== 'object') m.chats = {}
      const out = mutator(m)
      writeJson(sessionsFile(), m)
      return out
    }, { staleMs: 5000, timeoutMs: Number(opts.timeoutMs) || 8000 })
  }
  // 兼容旧调用：整体替换 chats（确认场景用；正常路径用 updateMap）
  async function saveMap(m) { await updateMap((disk) => { disk.chats = (m && m.chats) || {} }) }

  // —— 上下文兜底估算用量，接近上限就把旧会话归档、开新会话 ——
  // 窗口优先级手动配置 chat.contextWindow > DSH 平台事件带出的 liveWindow
  // （request/context 事件的 contextWindow，dsh-context 面板显示的真实窗口如 1M）
  // > agentDefaultModel.currentSelection().contextWindow > 模型名查表 > 64K。
  function contextWindow() {
    const cfgWin = Number(getConfig().chat?.contextWindow)
    if (Number.isFinite(cfgWin) && cfgWin > 0) return cfgWin
    if (liveWindow > 0) return liveWindow
    try {
      const svc = dsh.get('agentDefaultModel')
      const sel = svc && typeof svc.currentSelection === 'function' ? svc.currentSelection() : null
      if (sel && Number.isFinite(sel.contextWindow) && sel.contextWindow > 0) return sel.contextWindow
      const m = String(modelSel().model || liveModel || '').toLowerCase()
      for (const k of Object.keys(MODEL_WINDOW_FALLBACK)) if (m.includes(k)) return MODEL_WINDOW_FALLBACK[k]
    } catch {}
    return DEFAULT_WINDOW
  }

  // host.js 在 session/event 里捕获 request/context 事件后调这个：记下平台真实窗口。
  function setLiveWindow(contextWindow, model) {
    if (Number.isFinite(contextWindow) && contextWindow > 0) liveWindow = contextWindow
    if (typeof model === 'string' && model) liveModel = model
  }

  function contextUsage(chatId, force) {
    const c = usageCache.get(chatId)
    const now = Date.now()
    if (!force && c && now - c.t < 10000) return c
    const win = contextWindow()
    const real = usageReal.get(chatId)
    const fresh = real && now - real.t < 30 * 60_000 ? real : null
    const tokens = fresh ? real.used : Math.round(history.stats(chatId).textBytes * 0.4) + ROTATE_FIXED_TOKENS
    const u = { t: now, tokens, window: win, ratio: Math.round((tokens / win) * 1000) / 10, source: fresh ? 'platform' : 'estimate' }
    usageCache.set(chatId, u)
    return u
  }

  // C：上下文轮换只换 session，不动聊天记录。
  // （旧实现还会 archiveChat 把 chats/<chatId> 的 seg/index rename 走——「查看更早的记录」从此断档，
  //  等于在 DSH 自己的截断之外又造了一套窗口管理。archive-* 只留给「手动清空历史」。）
  async function rotateIfNeeded(chat) {
    if (chat.system) return false
    const u = contextUsage(chat.chatId, true)
    if (u.tokens < u.window * ROTATE_RATIO) return false
    const prior = map().chats[chat.chatId]
    const rec = {
      at: Date.now(),
      chatId: chat.chatId,
      tokens: u.tokens,
      window: u.window,
      ratio: u.ratio,
      source: u.source,
      priorSessionId: (prior && prior.sessionId) || null,
      priorSessionTitle: (prior && prior.title) || '',
    }
    const logFile = dataDir('mem', 'rotation-log.jsonl')
    try { appendFileSync(logFile, JSON.stringify(rec) + '\n') } catch {}
    // resetChat 只做 archiveSession(prior.sessionId) + 删会话映射，聊天分片原地保留。
    await resetChat(chat.chatId)
    const r = rotatedChats.get(chat.chatId)
    rotatedChats.set(chat.chatId, { at: Date.now(), n: (r ? r.n : 0) + 1 })
    usageCache.delete(chat.chatId)
    usageReal.delete(chat.chatId)
    log.info(`上下文 ${u.ratio}%（${u.source === 'platform' ? '平台真实' : '估算'} ${u.tokens}/${u.window}），换新会话（${chat.chatId} 第 ${r ? r.n + 1 : 1} 转；聊天记录保留）`)
    emit?.('rotate', rec)
    return true
  }

  function logChat(chatId, who, text, uid) {
    const day = new Date().toISOString().slice(0, 10)
    const line = JSON.stringify({ t: new Date().toISOString(), chatId, who, text, ...(uid ? { uid } : {}) })
    mkdirSync(chatlogDir(), { recursive: true })
    // 和「删客人时的 chatlog 过滤重写」共用一把 lock：否则重写期间新追加的行会被整份覆盖掉。
    return lockAndRun('chatlog', () => appendFileSync(join(chatlogDir(), `${day}.jsonl`), line + '\n'), { staleMs: 10000, timeoutMs: 5000 })
      .catch((error) => log.warn('对话日志写失败：' + (error?.message || error)))
  }

  function chatLogDays() {
    try {
      return readdirSync(chatlogDir())
        .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
        .map((f) => f.slice(0, 10))
    } catch { return [] }
  }

  function chatLogOf(day) {
    try {
      const raw = readFileSync(join(chatlogDir(), `${day}.jsonl`), 'utf8')
      return raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    } catch { return [] }
  }

  function deleteChatLog(day) {
    try { unlinkSync(join(chatlogDir(), `${day}.jsonl`)) } catch {}
  }

  async function appendMessage(chatId, payload) {
    let msg = null
    try {
      msg = await history.append(chatId, payload)
    } catch (error) {
      // sweep/splitCurrent 拿着历史锁搬大目录时，append 可能等到超时——不能让消息直接丢。
      log.warn(`${chatId} 历史写入失败：` + (error?.message || error))
    }
    emit?.('message', { chatId, message: msg })
    history.touch(chatId)
    return msg
  }

  function messagesOf(chatId) {
    return history.page(chatId, { limit: SEGMENT_LIMIT }).messages
  }

  function pageOf(chatId, opts) {
    return history.page(chatId, opts)
  }

  // 「一个分片文件 = 一页」的取法，网页端翻历史用
  function pageFileOf(chatId, opts) {
    return history.pageFile(chatId, opts)
  }

  // 历史归档（只读）：上下文轮换后的旧对话，列表 + 查看，不做续聊。
  function listArchives(chatId) {
    try { return history.listArchives(chatId) } catch { return [] }
  }
  function readArchive(chatId, dir) {
    try { return history.readArchive(chatId, dir) } catch (error) { return { ok: false, reason: error?.message || '读不到归档' } }
  }

  function historyStats(chatId) {
    return history.stats(chatId)
  }

  function recentChat(chatId, n = 20) {
    return history.page(chatId, { limit: Math.max(30, n * 3) }).messages
      .filter((m) => m.kind === 'text' || m.kind === 'voice')
      .slice(-n)
      .map((m) => ({ t: m.t, who: m.who, text: m.text, uid: m.uid }))
  }

  async function ensureWorkspace() {
    const reg = dsh.workspaceRegistry || dsh.get('workspaceRegistry')
    if (!reg) throw new Error('宿主没有 workspaceRegistry')
    const norm = (p) => String(p).replace(/[\\/]+$/, '').toLowerCase()
    mkdirSync(WORKSPACE_DIR, { recursive: true })
    let ws = (reg.list() || []).find((w) => norm(w.path) === norm(WORKSPACE_DIR))
    if (!ws) ws = await reg.create(WORKSPACE_DIR, WORKSPACE_TITLE)
    return ws
  }

  function controller() {
    const c = dsh.get('sessionController')
    if (!c) throw new Error('宿主没有 sessionController（需要 DSH 桌面版 / Web 组合）')
    return c
  }

  function titleFor(chat) {
    const cfg = getConfig()
    if (isOwner(cfg, chat.userId)) return `Web · ${cfg.ownerName || '主人'}`
    return `Web · ${chat.nickname || chat.userId || chat.chatId}`
  }

  async function createSession(chat, level) {
    const ws = await ensureWorkspace()
    const preset = presetForChat(getConfig(), chat)
    const r = await controller().create({ workspaceId: ws.id, agentPreset: preset })
    const sid = String(r.sessionId)
    await controller().rename({ sessionId: sid, title: titleFor(chat) })
    return { sessionId: sid, preset, level, createdAt: Date.now(), title: titleFor(chat) }
  }

  async function resolveAgent(sid) {
    const live = dsh.agents.get(sid) || dsh.agents.get('session-' + sid)
    if (live) return live
    const r = await controller().resolveAgent(sid)
    return r.agent
  }

  // 会话还在不在宿主的 SessionStore 里。缓存的 agent/session 对已被删掉的会话依然能 resolve 出对象，
  // 直到 followup/flush 时才炸（cannot append outside a SessionStore）。所以每次用之前先验活。
  // 老宿主没有 sessions 服务时返回 true，保持原有行为。
  async function sessionAlive(sid) {
    const store = dsh.sessions || dsh.get('sessions')
    const key = sessionKey(sid)
    if (store && typeof store.get === 'function') {
      for (const id of [sid, key, 'session-' + key]) {
        try { if (store.get(id)) return true } catch { /* 试下一个写法 */ }
      }
    }
    // 内存里没挂载不算「已删」：DSH 重启后磁盘上的老会话还没 attach 到本进程。
    // 真正存在性以持久化层为准（stat 返回 undefined/抛「找不到」才算不存在）；
    // 没有这个服务时返回 true，保持原有行为，避免误判导致不停重建会话。
    const persistence = (() => { try { return dsh.get('sessionPersistence') } catch { return null } })()
    if (persistence && typeof persistence.stat === 'function') {
      try {
        const st = await persistence.stat(sid)
        return st !== undefined && st !== null
      } catch (error) {
        const msg = String(error?.message || error || '')
        if (/not.?found|不存在|ENOENT/i.test(msg)) return false
        return true // 查询本身失败：别当成「已删」去重建
      }
    }
    const query = (() => { try { return dsh.get('sessionQuery') } catch { return null } })()
    if (query && typeof query.observeSession === 'function') {
      try { await query.observeSession(sid); return true } catch (error) {
        if (/NOT_FOUND|not.?found|不存在/i.test(String(error?.code || error?.message || ''))) return false
        return true
      }
    }
    return true
  }

  // 模型选择优先级：她自己挑的（state.json.model）> 主人配的（config.model）。
  // 她想换模型就换，主人配的是「出厂默认」，她的选择是「她自己的主意」。
  function modelSel() {
    const pref = getModelPreference?.()
    if (pref && pref.provider && pref.model) return pref
    return getConfig().model || {}
  }

  function modelKey() {
    const { provider, model, reasoningEffort } = modelSel()
    return `${provider}::${model}::${reasoningEffort}`
  }

  async function applyModel(agent) {
    const { provider, model, reasoningEffort } = modelSel()

    let p = provider
    let m = model
    if (!p || !m) {
      try {
        const svc = dsh.get('agentDefaultModel')
        const sel = svc && typeof svc.currentSelection === 'function' ? svc.currentSelection() : null
        if (sel && sel.provider && sel.model) { p = sel.provider; m = sel.model }
      } catch (error) {}
    }
    if (!p || !m) return
    const sel = { provider: p, model: m }
    if (reasoningEffort && reasoningEffort !== 'low') sel.reasoningEffort = reasoningEffort
    const agents = controller().agents
    if (agents && typeof agents.selectForNextRequest === 'function') {
      try { agents.selectForNextRequest(agent, sel); return } catch (e) { log.debug('切模型失败，改用 append：' + e.message) }
    }
    if (agent.session && typeof agent.session.append === 'function') agent.session.append('model/selection', sel)
  }

  function mount(agent, chat, level) {
    const sessionId = agent.session?.id || ''
    const tools = buildTools({ chat, level, sessionId })
    const toolsKey = tools.map((t) => t.name).sort().join('|')
    const prev = mounted.get(agent)
    if (prev && prev.toolsKey === toolsKey) return
    if (prev) for (const d of prev.disposers) { try { d() } catch {} }
    const disposers = []
    for (const tool of tools) {
      try {
        const d = agent.ctx.tools.register(tool)
        if (typeof d === 'function') disposers.push(d)
      } catch (e) { log.warn('挂工具失败 ' + tool.name + '：' + e.message) }
    }
    try {
      const d = agent.ctx.systemPrompt.context({
        name: 'auralife-context',
        order: 905,
        text: () => {
          const rot = rotatedChats.get(chat.chatId)
          const note = rot ? `（这是第 ${rot.n + 1} 段会话：之前的对话原文已归档到本地，你记得的事都在记忆里，接着聊就行，不用重提归档这件事。）` : ''
          return [note, ...(contextProviders || []).map((p) => p({ chat, sessionId }))].filter(Boolean).join('\n\n')
        },
      })
      if (typeof d === 'function') disposers.push(d)
    } catch (e) { log.warn('挂上下文失败：' + e.message) }
    mounted.set(agent, { toolsKey, disposers })
  }

  async function agentFor(chat) {
    const cfg = getConfig()
    const level = chat.system ? 'social' : levelFor(cfg, chat)
    const preset = presetForChat(cfg, chat)
    const reg = dsh.workspaceRegistry || dsh.get('workspaceRegistry')
    let entry = map().chats[chat.chatId]
    // #10：改权限不该重置会话——level 只是聊天档位（工具是否给全靠 isOwner），
    // 真正影响会话的是 preset；档位变了就原地更新，不换 sessionId、不清上下文。
    if (entry && entry.level !== level) {
      entry.level = level
      try {
        await updateMap((m) => {
          if (m.chats[chat.chatId]?.sessionId === entry.sessionId) m.chats[chat.chatId] = entry
        })
      } catch {}
    }
    let needNew = !entry || !entry.sessionId || entry.preset !== preset
    if (entry && entry.sessionId && (reg?.archivedSessionIds || []).includes(entry.sessionId)) needNew = true
    // 会话被宿主删了（SessionStore/持久化层里没了）也算失效：否则会一直拿死会话重试，日记/自驱全部报错。
    if (!needNew && entry?.sessionId && !(await sessionAlive(entry.sessionId))) {
      log.warn(`会话 ${entry.sessionId} 已不存在，重建会话`)
      needNew = true
    }
    if (needNew) {
      entry = await createSession(chat, level)
      await updateMap((m) => { m.chats[chat.chatId] = entry })
    }
    let agent = null
    try {
      agent = await resolveAgent(entry.sessionId)
    } catch (e) {
      // #11：宿主抖一下（模型报错、锁超时）不等于会话没了；先确认它还活着再决定，别当场失忆。
      if (await sessionAlive(entry.sessionId).catch(() => false)) {
        try {
          await new Promise((r) => setTimeout(r, 250))
          agent = await resolveAgent(entry.sessionId)
        } catch (e2) {
          log.warn(`会话 ${entry.sessionId} 重试解析失败：${e2?.message || e2}`)
          agent = null
        }
      } else {
        agent = null
      }
    }
    if (!agent) {
      entry = await createSession(chat, level)
      await updateMap((m) => { m.chats[chat.chatId] = entry })
      agent = await resolveAgent(entry.sessionId)
    }
    // 模型选择真正做到「变了才切、切完才写」：正常每轮 0 次 sessions 锁，
    // 换模型 1 次，新建会话 2 次（创建 + 模型）。以前每轮固定 3 次整份写，锁超时会直接打断回复。
    const mk = modelKey()
    if (entry.modelKey !== mk) {
      await applyModel(agent)
      entry.modelKey = mk
      await updateMap((m) => {
        const cur = m.chats[chat.chatId]
        if (cur && cur.sessionId === entry.sessionId) m.chats[chat.chatId] = entry
        else if (!cur) m.chats[chat.chatId] = entry
      })
    }
    sessionToChat.set(sessionKey(entry.sessionId), chat.chatId)
    mount(agent, chat, level)
    return agent
  }

  async function sendText(chatId, text) {
    await appendMessage(chatId, { who: 'bot', text, kind: 'text' })
    bump('messages')
    return true
  }

  async function sendVoice(chatId, text) {
    try {
      const { file, engine } = await tts.speak(text)
      const b64 = readFileSync(file).toString('base64')
      const voiceMime = String(file).endsWith('.wav') ? 'audio/wav' : 'audio/mpeg'
      await appendMessage(chatId, { who: 'bot', text, kind: 'voice', voice: b64, voiceMime, engine })
      bump('voice')
      return true
    } catch (e) {
      log.warn('语音没发出去，改发文字：' + e.message)
      await sendText(chatId, text)
      return false
    }
  }

  async function sendSticker(chatId, query) {
    const lib = stickers.library().items
    let item = query && typeof query === 'object' ? query : stickers.match(query)

    if (!item && lib.length) item = lib[Math.floor(Math.random() * lib.length)]
    if (!item) { log.debug('表情库是空的，跳过表情'); return false }

    await appendMessage(chatId, { who: 'bot', text: '[表情]', kind: 'sticker', sticker: item.md5, name: item.name || '', caption: item.name || '', mark: 'sticker' })
    stickers.markUsed?.(item.md5)
    bump('stickers')
    return true
  }

  async function sendImage(chatId, src) {
    try {
      const buf = Buffer.isBuffer(src) ? src : await fetchImage(src, { maxBytes: 10 * 1024 * 1024 })
      const mime = mimeOf(buf)
      if (mime && mime.startsWith('image/')) {
        await appendMessage(chatId, { who: 'bot', text: '[图片]', kind: 'image', image: buf.toString('base64'), imageMime: mime, mark: 'ai-image' })
        bump('images')
        return true
      }
      // 内容不是图片（模型把文字塞进了 ![]()）：按文本文件发，别让客户端解出一张坏图
      return sendFile(chatId, buf.toString('utf8'), 'message.txt')
    } catch (e) { log.warn('图片发不出去：' + e.message); return false }
  }

  async function sendFile(chatId, content, name) {
    try {
      const text = String(content || '')
      if (!text.trim()) { log.warn('文件内容是空的，不发了'); return false }
      const fileName = String(name || 'message.txt').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || 'message.txt'
      const saved = history.saveMedia(chatId, Buffer.from(text, 'utf8').toString('base64'), 'text/plain')
      await appendMessage(chatId, { who: 'bot', text: '[文件] ' + fileName, kind: 'file', fileName, fileMime: 'text/plain', mediaId: saved.mediaId, mediaMime: saved.mediaMime, bytes: saved.bytes, mark: 'ai-file' })
      bump('files')
      return true
    } catch (e) { log.warn('文件发不出去：' + e.message); return false }
  }

  // 半醒窗口（drowsy/dream_wake）里又聊了一句 → 只记一笔「最近还有往来」，
  // 回睡交给 sleep.tick：最后一次往来之后再过 10 分钟才收窗口（#27）。
  // 沉默、空回复也算聊过（否则她只输出 [沉默] 时窗口会一直挂着）。
  async function wakeWindowDone() {
    try {
      const s = sleepOf()
      const ph = s?.phase?.()
      if (ph === 'drowsy' || ph === 'dream_wake') await s.afterReply?.()
    } catch (error) {
      log.warn('记录活跃时间失败：' + (error?.message || error))
    }
  }

  async function deliver(chatId, text, opts = {}) {
    const cfg = getConfig()
    const r = parseReply(text)
    if (r.silent) { log.info(`${chatId}：Ta 选择不说话`); await wakeWindowDone(); return }
    let items = r.items
    if (opts.wantVoice && cfg.voice.enabled && !items.some((i) => i.kind === 'voice')) {
      const spoken = items.filter((i) => i.kind === 'text').map((i) => i.value).join('，')
      if (spoken && spoken.length <= 300) items = [{ kind: 'voice', value: spoken }, ...items.filter((i) => i.kind !== 'text')]
    }
    const texts = items.filter((i) => i.kind === 'text')
    // 语音/表情不再随机Ta 想用语音就自己在回复里写 <voice>，想发表情就写 <sticker>，
    // 或用户要求语音（opts.wantVoice）。概率抽签对数字生命是机械行为，已删。
    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      if (it.kind === 'text') await sendText(chatId, it.value)
      else if (it.kind === 'voice') { if (cfg.voice.enabled) await sendVoice(chatId, it.value); else await sendText(chatId, it.value) }
      else if (it.kind === 'sticker') await sendSticker(chatId, it.value)
      else if (it.kind === 'image') await sendImage(chatId, it.value)
      else if (it.kind === 'file') await sendFile(chatId, it.value, it.name)
      if (i < items.length - 1) {
        // B：这里必须是延时函数，不是睡眠器官 getter。顺手记实际间隔，出问题能当场看到。
        const gap = bubbleDelay(items[i + 1].kind === 'text' ? items[i + 1].value : '') * mood().delay
        const startedAt = Date.now()
        await delay(gap)
        log.debug?.(`${chatId}：气泡间隔 ${Math.round(gap)}ms（实际 ${Date.now() - startedAt}ms）`)
      }
    }
    logChat(chatId, 'bot', items.map((i) => (i.kind === 'text' || i.kind === 'voice' || i.kind === 'file' ? i.value : `[${i.kind}]`)).join(' '))
    lastChatAt = Date.now()
    const ownerChat = isOwner(cfg, chatId)
    if (ownerChat) lastBotToOwner = { at: Date.now(), text: items.filter((i) => i.kind === 'text' || i.kind === 'voice').map((i) => i.value).join('\n') }
    // 附带 userId/level：宿主侧靠它区分「主人会话」和「客人会话」（器官自举只允许主人触发）。
    onActivity?.({ kind: 'out', chatId, reply: text, userText: opts.userText || '', userId: ownerChat ? OWNER_ID : chatId, level: ownerChat ? 'full' : 'social' })
    // 被叫醒后的「暂时醒着」：聊完这一轮自动回睡（#25）。
    await wakeWindowDone()
  }

  async function deliverTo(target, text) {
    const chatId = String(target).replace(/^private:/, '')
    await deliver(chatId, text, {})
    return true
  }

  function textOf(message) {
    if (!message || !Array.isArray(message.content)) return ''
    return message.content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n').trim()
  }

  function startTyping(chatId) { emit?.('typing', { chatId, on: true }) }
  function stopTyping(chatId) { emit?.('typing', { chatId, on: false }) }

  function onSessionEvent(session, event) {
    const key = sessionKey(session && session.id)
    const chatId = sessionToChat.get(key)
    if (!chatId || !event) return
    const st = turnState.get(key) || { lastTurn: -1, text: '', senders: new Set() }
    turnState.set(key, st)
    if (event.type === 'assistant/message') {
      const d = event.data || {}
      if (d.interrupted) return
      // C：平台自带本步真实 usage（inputTokens 含上下文），轮换判断用它，别再按字节数估。
      if (d.usage) {
        const used = Number(d.usage.totalTokens) || ((Number(d.usage.inputTokens) || 0) + (Number(d.usage.outputTokens) || 0))
        if (Number.isFinite(used) && used > 0) usageReal.set(chatId, { t: Date.now(), used })
      }
      const t = textOf(d.message)
      if (t) { st.lastTurn = d.turn; st.text = t }
      return
    }
    if (event.type === 'turn/end') {
      stopTyping(chatId)
      const d = event.data || {}
      const completed = d.reason && d.reason.kind === 'completed'
      const text = st.lastTurn === d.turn ? st.text : ''
      const sys = st.system
      const sysTimedOut = Boolean(st.systemTimedOut)
      const wantVoice = Boolean(st.wantVoice)
      const lastText = st.lastText || ''
      if (st.sysTimer) { clearTimeout(st.sysTimer); st.sysTimer = null }
      st.text = ''
      st.senders = new Set()
      st.system = null
      st.systemTimedOut = false
      st.wantVoice = false
      // 超时的那一轮晚到的 turn/end：system 已被超时回调清空，直接丢弃，不能走正常发货分支。
      if (sysTimedOut) { log.debug?.(`${chatId}：超时轮次晚到的 turn/end 已忽略`); return }
      if (sys) {
        if (completed) sys.resolve(text)
        else sys.reject(new Error('这一轮没正常结束：' + (d.reason?.kind || '?')))
        return
      }
      if (!completed) { log.warn(`${chatId} 这一轮没正常结束（${d.reason?.kind || '?'}），不发`); release(chatId); return }
      if (!text) { wakeWindowDone().catch(() => {}); return release(chatId) }
      deliver(chatId, text, { wantVoice, userText: lastText }).catch((e) => log.warn('发送出错：' + e.message)).finally(() => release(chatId))
    }
  }

  const fmtB = (n) => (n < 1024 ? n + ' B' : (n < 1024 * 1024 ? (n / 1024).toFixed(1) + ' KB' : (n / 1024 / 1024).toFixed(1) + ' MB'))

  async function onUserMessage({ chatId, userId, nickname, text = '', images = [], files = [], voice = null, sticker = '', level = '' }) {
    const cfg = getConfig()
    const wantVoice = Boolean(voice && voice.data)
    typingUntil.delete(chatId)
    let userSticker = null
    const chat = { chatId, userId, nickname: nickname || userId, ...(level ? { level } : {}) }
    if (voice && voice.data) {
      await appendMessage(chatId, { who: 'user', uid: userId, text: `[语音 · ${Math.round(voice.dur || 0)}秒]`, kind: 'voice', voice: voice.data, voiceMime: voice.mime || 'audio/webm', dur: Math.round(voice.dur || 0) })
      logChat(chatId, nickname || userId, '[语音]', userId)
      bump('voice')
    } else if (sticker) {
      const item = stickers.library().items.find((i) => i.md5 === sticker) || null
      userSticker = item
      await appendMessage(chatId, { who: 'user', uid: userId, text: '[表情]', kind: 'sticker', sticker, name: item?.name || '', mark: 'user-sticker' })
      logChat(chatId, nickname || userId, `[表情${item?.name ? ' ' + item.name : ''}]`, userId)
      bump('sticker')
    } else if (text) {
      await appendMessage(chatId, { who: 'user', uid: userId, text, kind: 'text' })
      logChat(chatId, nickname || userId, text, userId)
    }
    lastChatAt = Date.now()
    if (isOwner(cfg, userId)) lastOwnerChatAt = Date.now()
    onActivity?.({ kind: 'in', chatId, text: text || '[语音]', userId, nickname })
    const content = []
    if (voice && voice.data) {

      let heard = ''
      const vopt = getConfig().voice || {}
      const asrOn = vopt.asr !== 'off' // STT 三档 off/dsh/custom，非 off 即开着
      const ready = Boolean(tts?.transcribe && tts.asrReady?.(vopt, dsh))
      try {
        if (ready) {
          heard = await tts.transcribe(Buffer.from(voice.data, 'base64'), voice.mime || 'audio/wav', vopt, log, dsh)
        } else if (asrOn) {
          let info = ''
          try { info = JSON.stringify(tts?.asrInfo?.()) } catch (error) {}
          log.warn(`开了语音识别，但没拿到识别服务（这条只能当没转成文字）${info ? '：' + info : ''}`)
        }
      } catch (error) {
        log.warn('语音识别没成功：' + error.message)
      }
      if (heard) {
        content.push({ type: 'text', text: `【对方发来一条语音（约 ${Math.round(voice.dur || 0)} 秒），转成文字是：${heard}】` })

        const last = history.last(chatId)
        if (last && last.kind === 'voice' && !last.heard) {
          await history.patchLast(chatId, { heard })
          emit?.('message', { chatId, message: { ...last, heard } })
        }
        logChat(chatId, nickname || userId, `[语音] ${heard}`, userId)
      } else {

        content.push({ type: 'text', text: `[对方发来一条 ${Math.round(voice.dur || 0)} 秒的语音，这段没转成文字，只听到声音]` })
      }
    } else if (text) content.push({ type: 'text', text })
    if (userSticker) {

      content.push({ type: 'text', text: `【对方发来一张表情包${userSticker.name ? '：' + userSticker.name : ''}，看着接梗，或者也回一个 <sticker:标签>】` })
    }
    for (const img of images) {
      content.push({ type: 'image', data: img.data, mediaType: img.mediaType || 'image/png', name: img.name || 'image' })
      await appendMessage(chatId, { who: 'user', uid: userId, text: '[图片]', kind: 'image', image: img.data, imageMime: img.mediaType || 'image/png', mark: 'user-image' })
      logChat(chatId, nickname || userId, '[图片]', userId)

      if (cfg.stickers?.steal !== false && stickers?.addFromBuffer) {
        try {
          const buf = Buffer.from(String(img.data || ''), 'base64')
          if (buf.length >= 2 * 1024) {
            stickers.addFromBuffer(buf, { from: 'steal', hint: '别人发来的图' })
              .then((r) => { if (r?.ok && !r.existed) log.info('偷了一张表情，收进库了') })
              .catch(() => {})
          }
        } catch (error) {}
      }
    }
    for (const f of files) {
      const name = String(f.name || '文件')
      const mime = String(f.mediaType || 'application/octet-stream')
      const raw = Buffer.from(String(f.data || ''), 'base64')
      let saved = null
      try { saved = history.saveMedia(chatId, f.data, mime) } catch (err) { log.warn('存文件失败：' + err.message) }
      const bytes = saved ? saved.bytes : raw.length
      await appendMessage(chatId, { who: 'user', uid: userId, text: '[文件] ' + name, kind: 'file', fileName: name, fileMime: mime, ...(saved ? { mediaId: saved.mediaId, mediaMime: saved.mediaMime, bytes } : {}) })
      logChat(chatId, nickname || userId, '[文件] ' + name, userId)
      bump('files')
      // 文本类文件：读出内容给 Ta 看（cap 4000 字）；二进制：只告知收到
      let txt = null
      if (/^text\//.test(mime) || /\.(txt|md|markdown|json|csv|log|js|ts|jsx|tsx|py|sh|bat|ini|yml|yaml|xml|html|css|sql|toml|conf|java|c|cpp|h|rs|go)$/i.test(name)) {
        const s = raw.toString('utf8')
        if (s && !/[\u0000-\u0008]/.test(s.slice(0, 2000))) txt = s.slice(0, 4000)
      }
      content.push({ type: 'text', text: txt
        ? `【对方发来一个文件「${name}」（${fmtB(bytes)}），内容是：\n${txt}】`
        : `【对方发来一个文件「${name}」（${fmtB(bytes)}），我看不了里面的内容，只能先记下文件名】` })
    }
    bump('messages')
    // 睡着时被找（#25）：第一句不搭理，第二句（10 分钟内）才懵懂回一句；
    // 不想回的消息先记着，过几分钟 drive 会来补（#19）。
    try {
      const inbound = (await sleepOf()?.noteInbound?.(Date.now(), { chatId, level })) || null
      if (inbound?.action === 'ignore') {
        bump('read_no_reply')
        // #5：只有主人在睡着时被找才值得补；客人的消息没有 catchup 会认领它，
        // 落盘只会把上一条还没补的主人消息挤掉——别记，直接算了。
        if (chatId === OWNER_ID) {
          pendingReply = { chatId, at: Date.now(), text: text || (voice ? '[语音]' : sticker ? '[表情]' : '[消息]'), userId, level }
          persistPendingReply(pendingReply)
        }
        log.info(`${chatId}：她睡着了，这条先不搭理`)
        return
      }
      if (inbound?.action === 'wake' && inbound.hint) content.push({ type: 'text', text: inbound.hint })
    } catch (error) {
      log.warn('睡眠门禁出错：' + (error?.message || error))
    }
    // #19（按用户要求改）：体力低时不是「记账以后再补」，而是「看到了，先隔 3~5 秒再回」。
    // 不再用 pending-reply（单槽且会被下一句清掉），也不 setTimeout 重新 enqueue——
    // 只给这个 chat 挂一个「最早回复时间」，消息照常入队；后续消息排在它后面，
    // 保证先来的先回，语音请求的 wantVoice 也原样带下去。
    if (chatId === OWNER_ID && !pendingReply && content.length > 0) {
      try {
        const chance = Number(energyOf?.()?.gate?.()?.readIgnoreChance) || 0
        if (chance > 0 && Math.random() < chance) {
          bump('read_no_reply')
          const delay = 3000 + Math.floor(Math.random() * 2000)
          replyHoldUntil.set(chatId, Date.now() + delay)
          log.info(`这条先缓一缓（体力低），${Math.round(delay / 1000)} 秒后再回`)
        }
      } catch (error) {
        log.warn('已读不回判定出错：' + (error?.message || error))
      }
    }
    // 正常收到主人的消息 → 之前「已读不回」的那条不用补了。
    if (chatId === OWNER_ID) persistPendingReply(null)
    if (!cfg.enabled) return
    if (content.length === 0) return
    enqueue(chat, content, userId, wantVoice)
  }

  // 给 drive 用：取一条「该补一句」的未回消息（默认 5 分钟前、1 小时内，只补主人的）。
  // #30：没有最大过期会出荒唐事——凌晨被吞的消息，早上还被当成「刚才那条」补回来。
  // #47：改成异步、跨进程（落盘 + 锁内认领）；认领后写 claimedAt，5 分钟内别的进程不会再补一遍。
  async function takePendingReply(now = Date.now(), minAgeMs = 5 * 60_000, maxAgeMs = 60 * 60_000) {
    const usable = (p) => {
      if (!p || typeof p !== 'object') return null
      if (p.chatId !== OWNER_ID) return null
      if (now - (Number(p.at) || 0) < minAgeMs) return null
      return p
    }
    try {
      return await lockAndRun('pending-reply', () => {
        const disk = readJson(pendingFile(), () => null)
        const p = usable(disk) || usable(pendingReply)
        if (!p) {
          if (disk || pendingReply) persistPendingReply(null)
          return null
        }
        // 别的进程刚认领过 → 让位等它补（5 分钟 TTL，超时说明它没补成，允许重试）。
        if (p.claimedAt && now - Number(p.claimedAt) < 5 * 60_000) return null
        if (maxAgeMs > 0 && now - (Number(p.at) || 0) > maxAgeMs) {
          persistPendingReply(null)
          return null
        }
        pendingReply = null
        const claimed = { ...p, claimedAt: now }
        try {
          writeJson(pendingFile(), claimed)?.catch?.((error) => log.warn('未回消息认领落盘失败：' + (error?.message || error)))
        } catch {}
        return claimed
      }, { staleMs: 15000, timeoutMs: 5000 })
    } catch (error) {
      log.warn('未回消息认领失败：' + (error?.message || error))
      return null
    }
  }

  // 补完一句后彻底清掉这条未回消息，避免同一条被反复补。
  function clearPendingReply() {
    try { persistPendingReply(null) } catch {}
  }

  // 语音/图片过期清理：整片过期就删片删媒体，并把新的边界推给客户端。
  // （host.js 每小时调一次；每次追加消息后的空闲定时器也会扫。）
  async function cleanupVoice() {
    const changed = await history.sweepAll()
    for (const row of changed) {
      emit?.('history', { chatId: row.chatId, oldestAt: row.oldestAt, droppedBefore: row.oldestAt, hasMore: false })
    }
    return changed.length
  }

  function enqueue(chat, content, senderId, wantVoice, mode = 'normal') {
    const chatId = chat.chatId
    const cfg = getConfig()
    let p = pending.get(chatId)
    if (!p) {
      p = { chat, texts: [], images: [], senders: new Set(), wantVoice, timer: null, firstAt: Date.now(), mode, count: 0 }
      pending.set(chatId, p)
    }
    p.count++
    if (senderId) p.senders.add(senderId)
    for (const c of content) {
      if (c.type === 'text' && c.text) p.texts.push(c.text)
      else if (c.type === 'image') p.images.push(c)
    }
    p.wantVoice = p.wantVoice || wantVoice
    // 连发合并强制开多条消息合并成一条回，最多等 MERGE_MAX_SEC 秒。
    const mergeDelay = Math.min((cfg.merge?.waitSec ?? 2.5) * 1000, MERGE_MAX_SEC * 1000)

    const schedule = () => {
      if (p.timer) clearTimeout(p.timer)
      const hold = typingUntil.get(chatId) || 0
      const left = Math.max(0, hold - Date.now())

      const capped = Date.now() - p.firstAt > MAX_TYPING_HOLD_MS ? 0 : left
      p.timer = setTimeout(() => {
        if (capped && (typingUntil.get(chatId) || 0) > Date.now()) return schedule()
        flush(chatId)
      }, Math.max(mergeDelay, capped))
    }
    schedule()
  }

  function isBusy(chatId) { return busy.has(chatId) }

  function markBusy(chatId) {
    busy.add(chatId)
    const t = setTimeout(() => {
      if (busy.delete(chatId)) { log.warn(`${chatId} 一轮超过 ${BUSY_MAX_MS / 60000} 分钟，强制放开`); release(chatId) }
    }, BUSY_MAX_MS)
    busyTimers.set(chatId, t)
  }

  async function flush(chatId) {
    const p = pending.get(chatId)
    if (!p) return
    if (isBusy(chatId)) { waiting.add(chatId); return }
    pending.delete(chatId)
    if (p.timer) clearTimeout(p.timer)
    const content = [{ type: 'text', text: p.texts.join('\n') }, ...p.images]
    const firstSender = [...p.senders][0] || ''
    markBusy(chatId)
    try {
      // #19：低体力时先把这条消息在队列里按顺序等 3~5 秒再回（不重新排队，不打乱先后）。
      const hold = Math.max(0, (Number(replyHoldUntil.get(chatId)) || 0) - Date.now())
      replyHoldUntil.delete(chatId)
      if (hold > 0) await new Promise((resolve) => { const t = setTimeout(resolve, hold); t.unref?.() })
      // 体力低的时候连回复都变慢（#21）：不是装饰，能感觉到她累了。
      const delay = Number(energyOf()?.gate?.()?.replyDelayMs) || 0
      if (delay > 0) await new Promise((resolve) => { const t = setTimeout(resolve, delay); t.unref?.() })
      await pushToSession(p.chat, content, firstSender, { wantVoice: p.wantVoice, extraSenders: [...p.senders] })
    } catch (e) {
      bump('errors')
      log.warn('pushToSession 出错：' + e.message)
      release(chatId)
    }
  }

  function release(chatId) {
    busy.delete(chatId)
    const t = busyTimers.get(chatId)
    if (t) { clearTimeout(t); busyTimers.delete(chatId) }
    if (waiting.has(chatId)) { waiting.delete(chatId); flush(chatId) }
  }

  async function admit(agent, content) {
    if (!content || content.length <= 1) return content
    const att = dsh.attachments
    if (att && typeof att.admitPromptContent === 'function') {
      try { return await att.admitPromptContent(content) } catch (e) { log.warn('附件准入失败，退化成纯文本：' + e.message) }
    }
    return content.filter((c) => c.type === 'text')
  }

  async function pushToSession(chat, content, senderId, opts = {}) {
    await rotateIfNeeded(chat)
    const agent = await agentFor(chat)
    const key = sessionKey(agent.session?.id)
    let st = turnState.get(key)
    if (!st) { st = { lastTurn: -1, text: '', senders: new Set(), lastText: '', prevText: '' }; turnState.set(key, st) }
    if (senderId) st.senders.add(senderId)
    const textPart = (content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n')
    if (textPart) { st.prevText = st.lastText; st.lastText = textPart }
    if (opts.wantVoice) st.wantVoice = true
    if (opts.extraSenders) for (const u of opts.extraSenders) st.senders.add(u)
    // #7：每轮说话前把「此刻的身体状态」当场拼进去（不依赖 systemPrompt.context 的会话缓存）。
    // 用 user 角色文本包一层，模型只把它当背景，不会当成对方说的话复述出来。
    const dyn = (() => { try { return String(dynamicContext?.() || '').trim() } catch { return '' } })()
    const withState = dyn ? [{ type: 'text', text: `【你此刻的身体状态（每轮刷新，不是对方说的，也别说出来）】\n${dyn}` }, ...(content || [])] : content
    const admitted = await admit(agent, withState)
    startTyping(chat.chatId)
    try {
      await agent.followup({ id: randomUUID(), role: 'user', content: admitted, source: { kind: SOURCE_KIND } })
      await dsh.sessions.flush(agent.session)
    } catch (error) {
      // #15：followup 真抛错才收掉「正在输入…」；正常一轮要等 turn/end 再收。
      // （7cafde1 曾在这里用 finally 立即收——followup 返回时模型还没回，前端一闪就没了。）
      stopTyping(chat.chatId)
      throw error
    }
  }

  function runSystemTurn(name, title, prompt, opts = {}) {
    const chat = { chatId: 'system:' + name, system: true, title, userId: '', nickname: '' }
    const timeoutMs = opts.timeoutMs || 180000
    return new Promise(async (resolve, reject) => {
      let timer
      try {
        const agent = await agentFor(chat)
        const key = sessionKey(agent.session?.id)
        let st = turnState.get(key)
        if (!st) { st = { lastTurn: -1, text: '', senders: new Set() }; turnState.set(key, st) }
        st.system = { resolve, reject }
        timer = setTimeout(() => {
          const s = turnState.get(key)
          if (s && s.system) {
            s.system = null
            s.sysTimer = null
            // 标记超时：这一轮的 turn/end 晚到时不能再落进「正常发货」分支，
            // 否则 system:diary 这类虚拟会话会真的往会话里发气泡。
            s.systemTimedOut = true
            reject(new Error('这一轮超时了'))
          }
        }, timeoutMs)
        st.sysTimer = timer
        await agent.followup({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: prompt }], source: { kind: SOURCE_KIND } })
        await dsh.sessions.flush(agent.session)
      } catch (e) {
        if (timer) clearTimeout(timer)
        reject(e)
      }
    })
  }

  function turnHasOwner(sessionId) {
    const st = turnState.get(sessionKey(sessionId))
    return Boolean(st && [...st.senders].some((u) => isOwner(getConfig(), u)))
  }

  function turnSendersAllOwner(sessionId) {
    const st = turnState.get(sessionKey(sessionId))
    if (!st || st.senders.size === 0) return false
    return [...st.senders].every((u) => isOwner(getConfig(), u))
  }

  function chatOfSession(sid) { return sessionToChat.get(sessionKey(sid)) }

  async function resetChat(chatId) {
    const reg = dsh.workspaceRegistry || dsh.get('workspaceRegistry')
    const entry = map().chats[chatId]
    if (entry) {
      try { await Promise.resolve(reg?.archiveSession?.(entry.sessionId)) } catch (e) {}
      sessionToChat.delete(sessionKey(entry.sessionId))
      turnState.delete(sessionKey(entry.sessionId))
      await updateMap((m) => { delete m.chats[chatId] })
    }
  }

  // 删客人：按 chatId 收干净——会话映射、聊天分片+媒体、chatlog 当期行。
  // 单日 chatlog 是追加日志，按行过滤重写（只动这个 chatId 的行，别人一行不碰）。
  async function purgeChatData(chatId) {
    const id = String(chatId || '')
    if (!id) return { ok: false, reason: '没有 chatId' }
    await resetChat(id)
    // 历史分片/媒体在 hist 锁里删（history.purgeChat 内部已加锁）。
    const h = await history.purgeChat(id)
    let chatlog = 0
    try {
      // chatlog 正常写入也走这把锁；这里用 fs/promises + 临时文件 rename，避免几 MB 日志卡住事件循环。
      await lockAndRun('chatlog', async () => {
        const dir = chatlogDir()
        let names = []
        try { names = (await readdir(dir)).filter((n) => n.endsWith('.jsonl')) } catch { return }
        for (const f of names) {
          const p = join(dir, f)
          let raw = ''
          try { raw = await readFile(p, 'utf8') } catch { continue }
          const out = []
          for (const line of raw.split('\n')) {
            const t = line.trim()
            if (!t) continue
            let rec = null
            try { rec = JSON.parse(t) } catch { continue }
            if (rec && rec.chatId === id) { chatlog++; continue }
            out.push(t)
          }
          const tmp = p + '.tmp-' + process.pid
          try { await writeFile(tmp, out.length ? out.join('\n') + '\n' : '', 'utf8'); await rename(tmp, p) } catch {}
        }
      }, { staleMs: 10000, timeoutMs: 8000 })
    } catch (error) {
      log.warn('清理 chatlog 失败：' + (error?.message || error))
    }
    return { ok: true, ...(h || {}), chatlog }
  }

  async function resetSessions() {
    const m = map()
    for (const chatId of Object.keys(m.chats)) await resetChat(chatId)
  }

  function sessions() { return map().chats }

  function noteTyping(chatId, typing) {
    const hold = Math.max(0, Number(getConfig().merge?.waitTypingSec ?? 5))
    if (!typing || !hold) typingUntil.delete(chatId)
    else typingUntil.set(chatId, Date.now() + hold * 1000)
  }

  return {
    onUserMessage,
    noteTyping,
    onSessionEvent,
    deliver,
    deliverTo,
    sendText,
    sendVoice,
    sendSticker,
    sendImage,
    pushToSession,
    runSystemTurn,
    turnSendersAllOwner,
    turnHasOwner,
    resetChat,
    purgeChatData,
    chatOfSession,
    resetSessions,
    rotateIfNeeded,
    contextUsage,
    setLiveWindow,
    lastTextOf: (sid) => turnState.get(sessionKey(sid))?.lastText || '',
    prevTextOf: (sid) => turnState.get(sessionKey(sid))?.prevText || '',
    speakersOf: (sid) => [...(turnState.get(sessionKey(sid))?.senders || [])],
    logChat,
    appendMessage, // debug 用：注入假消息（web/routes/debug.js）
    ensureWorkspace,
    chatLogOf,
    chatLogDays,
    deleteChatLog,
    recentChat,
    messagesOf,
    pageOf,
    pageFileOf,
    historyStats,
    listArchives,
    readArchive,
    cleanupVoice,
    takePendingReply,
    clearPendingReply,
    sessions,
    stats: () => ({ ...stats, media: (stats.images || 0) + (stats.files || 0) }),
    get lastChatAt() { return lastChatAt },
    get lastOwnerChatAt() { return lastOwnerChatAt },
    get lastBotToOwner() { return lastBotToOwner },
  }
}
