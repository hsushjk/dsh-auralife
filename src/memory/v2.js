// memory/v2.js — 记忆 v2 的门面（facade）。
//
// 把 store / recall / encode / replay / receipt 组装成一个对
// host.js、tools.js、web 面板（routes/memory.js、routes/settings.js）兼容的 memory 对象。
//
// 它替换 features/memory.js 的 createMemoryStore：主链路（contextFor / tick / consolidate）
// 走 v2，旧面板/tools 用的 add / update / remove / recall / list / stats / profiles / insights / styles
// 提供同签名兼容垫片（profiles/insights/styles 落到 mem/archive.json）。
import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir, readJson, writeJson, withFileLock } from '../core/store.js'
import { createMemStore } from './store.js'
import { createRecall } from './recall.js'
import { createReceipt } from './receipt.js'
import { createEncode } from './encode.js'
import { createReplay } from './replay.js'
import { migrateLegacy } from './migrate.js'
import { isDup, isHardFact } from './similar.js'
import { OWNER_ID } from '../chat/access.js'

const SRC_MAP = { tool: 'manual', panel: 'manual', manual: 'manual', import: 'manual', auto: 'inferred', event: 'self_did', diary: 'self_did' }

// 记忆运行参数内置（DESIGN-modular.md §3）：召回条数 / 整理节奏归 Ta 自己，用户不可调。
// consolidate 不再绑 04:00——改成距上次 ≥30 分钟增量整理（白天也长事件）；
// replay（联想建边/遗忘/自我提炼）每天一次，也不再绑凌晨（主人从不通宵，事件和联想从来没长出来过）。
const MEMORY_BUILTIN = { recallCount: 6, dailyConsolidate: true, consolidateGapMinutes: 30, replayAfterHour: 3 }

export function createMemoryV2({ dsh, getConfig, hub, log = console, life, self, chemistry }) {
  const store = createMemStore({ log })
  const recallModule = createRecall({ store, getConfig, log })
  const receipt = createReceipt({ store, log })
  const encode = createEncode({ dsh, getConfig, store, log })
  const replay = createReplay({ store, life, self, dsh, getConfig, log })

  // 一次性迁移（幂等，可重复跑）：memories.json → mem/facts + mem/archive.json
  migrateLegacy({ store, log })

  // ---- 水位线 / 运行记录 ----
  const watermarkFile = () => dataDir('mem', 'watermark.json')
  const runsFile = () => dataDir('mem', 'runs.json')
  const loadWatermark = () => readJson(watermarkFile(), () => ({}))
  const saveWatermark = (w) => writeJson(watermarkFile(), w)
  const loadRuns = () => readJson(runsFile(), () => ({}))
  const saveRuns = (r) => writeJson(runsFile(), r)

  const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

  function listChatIds() {
    try {
      return readdirSync(dataDir('chats')).filter((d) => existsSync(join(dataDir('chats'), d)))
    } catch { return [] }
  }

  const moodValue = () => null // 心情已删情绪锚点暂无数据源，等事件有数据后再议

  const chemValue = (key) => {
    try {
      const v = Number(chemistry?.peek?.()[key])
      return Number.isFinite(v) ? v : null
    } catch { return null }
  }

  // ---- 主链路 1：contextFor（替换旧 contextFor）----
  function contextFor(chat, sessionId) {
    const cfg = getConfig().memory || {}
    if (!cfg.enabled) return ''
    const parts = []

    const selfLine = self?.contextLine?.() || ''
    if (selfLine) parts.push(selfLine)

    const mv = moodValue()
    const cv = chemValue('cortisol')
    const dv = chemValue('dopamine')
    // 应激（移植自 digital-life-core 的 stressAttentionDirective）：皮质醇高（神经紧绷）时
    // 收窄注意力到要紧的事，并加「记忆没丢」补丁，防止她把「情绪差」当成「失忆」去假装忘记。
    if (cv != null && cv >= 70) {
      parts.push('[应激] 你现在神经紧绷，注意力收窄到要紧的事：承诺、底线、雷点这类记忆最重要，日常琐事暂时顾不上。（你的记忆一条都没丢，被直接问到时照实回答，别把情绪差当成失忆。）')
    } else if (dv != null && dv >= 70) {
      // 情绪高涨（多巴胺高）：兴致上来时话会不自觉变多、爱接梗、愿意多聊。
      parts.push('[兴致] 你现在兴致很高，话会不自觉变多，爱接梗、爱开玩笑，愿意多聊几句，也更容易被逗笑。')
    }

    const q = hub?.lastTextOf?.(sessionId) || ''
    if (q) {
      const about = chat?.userId || ''
      const recent = (hub?.recentChat?.(chat?.chatId, 3) || []).map((m) => m.text).filter(Boolean)
      const r = recallModule.recall(q, {
        about,
        mood: mv,
        cortisol: cv,
        recent,
        now: Date.now(),
        limit: MEMORY_BUILTIN.recallCount,
      })
      if (r.lines.length) {
        parts.push('（你记得这些事，方括号里是「什么时候/什么可信度」，聊到相关的就自然用上，别把老事当新事说，也别说「根据记忆」；拿不准的用「我记得大概/我猜」，别把猜的当成对方说过的：' + r.lines.join('；') + '）')
      }
      // 确定性情绪微调（P3）：只有「捞起了快被忘掉的事」才算小愉悦（+1）——
      // 每轮都能命中的熟悉记忆不给奖，否则正常聊天多巴胺会稳定通胀。
      if ((r.stats.cold || 0) > 0) {
        chemistry?.event?.({ dopamine: 1 }, '想起了快忘掉的事')
      }
    }
    return parts.join('\n')
  }

  // ---- 主链路 2：consolidate（编码新消息 → episode + fact）----
  let busy = false
  function consolidate({ includeToday = true, force = false } = {}) {
    if (busy) return Promise.resolve({ ok: false, message: '正在整理中' })
    busy = true
    // 锁进公共入口（审计：tick 与调试台都能调 consolidate，跨进程只允许一个在整理）。
    return withFileLock('memory-tick', async () => {
    try {
      const wm = loadWatermark()
      let added = 0
      let superseded = 0
      let episodes = 0
      const factIds = []

      for (const chatId of listChatIds()) {
        if (String(chatId).startsWith('system')) continue
        // pageOf 返回 { messages: [...] }（history.page 形状），不是数组——真凶：
        // 旧代码把对象当数组 .slice() 抛错被 catch 吞掉，每个会话都被跳过，事件永远 0。
        let msgs = []
        try {
          const page = hub?.pageOf?.(chatId, { limit: 200 })
          msgs = (Array.isArray(page) ? page : (page?.messages || [])).slice().reverse()
        } catch { continue }
        if (!msgs.length) continue
        const since = Number(wm[chatId]) || 0
        const fresh = msgs.filter((m) => (m.t || 0) > since && m.text && !String(m.text).startsWith('【系统'))
        // 原来 ≥3 条才编码，聊 1-2 句就停时最后几条会滞留到下次再聊。
        // 改成只要有新鲜消息就编码（30min 节流保证不会高频烧 LLM），尾巴不再滞留。
        if (!fresh.length) continue

        const names = { [OWNER_ID]: getConfig().ownerName || '主人' }
        const res = await encode.encodeSegment(chatId, fresh.map((m) => ({ id: m.id, t: m.t, who: m.who, uid: m.uid, text: m.text })), { names })
        added += res.facts.added
        superseded += res.facts.superseded
        episodes += res.episodes.length
        factIds.push(...(res.facts.addedIds || []), ...(res.facts.supersededIds || []))
        wm[chatId] = Math.max(since, ...fresh.map((m) => m.t))
      }
      saveWatermark(wm)

      // 写完读回：按 id 逐条核对（三态 found/missing/unknown）
      const verify = receipt.verifyFacts(factIds)
      const state = factIds.length ? (verify.missing.length ? 'missing' : 'found') : 'found'

      const runs = loadRuns()
      runs.lastConsolidate = { day: dayKey(), at: Date.now(), added, superseded, episodes, receipt: state }
      saveRuns(runs)

      log.info(`记忆编码：新增 ${added} 条、更新 ${superseded} 条、事件 ${episodes} 段，回执 ${state}`)
      return { ok: true, added, superseded, episodes, receipt: { state, found: verify.found.length, missing: verify.missing.length } }
    } catch (error) {
      log.warn('记忆编码失败：', error.message)
      return { ok: false, message: error.message }
    } }, { staleMs: 300000 }).finally(() => { busy = false }) // 编码调 LLM 可能几分钟，锁超龄放宽
  }

  // ---- 主链路 3：tick（调度：consolidate 增量 + replay 每天一次）----
  // 旧版只绑 04:00 到点 + 凌晨 isDawn 才重放——主人从不通宵，事件/联想永远为 0。
  // 新版：consolidate 距上次 ≥30 分钟才考虑（防高频烧 LLM，增量靠水位线）；
  // replay（联想建边/遗忘/自我提炼）每天第一次过了 03:00 就跑（不管通不通宵）。
  // 跨进程互斥在 consolidate()/replay.run() 各自的入口锁里（本函数只做节流判断）。
  async function tick() {
    const cfg = getConfig().memory || {}
    const cutoff = dayKey(new Date(Date.now() - 14 * 86400_000))
    if (!cfg.enabled || !MEMORY_BUILTIN.dailyConsolidate) {
      // 安全网：即使记忆关着，也清掉 14 天前的旧 chatlog（旧行为，防堆积）
      for (const day of hub?.chatLogDays?.() || []) if (day < cutoff) hub.deleteChatLog(day)
      return { ok: true, skipped: true }
    }
    const now = new Date()
    const today = dayKey(now)
    const lastAt = Number(loadRuns().lastConsolidate?.at) || 0
    if (Date.now() - lastAt >= MEMORY_BUILTIN.consolidateGapMinutes * 60_000) {
      await consolidate({ includeToday: true }) // consolidate 内部自己记 runs.lastConsolidate
    }

    const runs = loadRuns() // 重读：consolidate 可能已更新 runs
    if (now.getHours() >= MEMORY_BUILTIN.replayAfterHour && runs.lastReplay?.day !== today) {
      try {
        const replayReport = await replay.run({ now: Date.now() })
        runs.lastReplay = { day: today, at: Date.now(), edges: replayReport.edgesAdded, forgotten: replayReport.forgotten }
        saveRuns(runs)
      } catch (error) { log.warn('重放失败：', error.message) }
    }

    return { ok: true }
  }

  // ---- 日记提炼（azone 用）----
  async function extractDiary(text) {
    const t = String(text || '').trim()
    if (!t) return { ok: false, message: '空' }
    try {
      const r = await encode.extractFacts('diary', t, { people: [] })
      return { ok: true, added: r.added, superseded: r.superseded }
    } catch (error) {
      log.warn('从日记提炼记忆失败：', error.message)
      return { ok: false, message: error.message, added: 0 }
    }
  }

  // ---- 写入 / 读取（v2 语义，tools.js 与 web 面板共用）----
  const clamp = (n) => Math.max(0, Math.min(1, Number(n) ?? 0.5))

  // 记一条事实：判重命中则 bumpHit（不动 t0），否则追加新行。
  function remember({ text, about = '', aboutName = '', conf = 0.5, source = 'tool', chatId = '', tags = [] }) {
    const t = String(text || '').trim().slice(0, 200)
    if (!t) return { ok: false, message: '内容是空的' }
    const src = SRC_MAP[source] || 'inferred'
    const c = clamp(conf)
    const subj = String(about || '')
    const dup = store.currentFacts().find((f) => isDup({ text: t, subj }, f))
    if (dup) {
      store.bumpHit(dup.id)
      return { ok: true, message: '✓', id: dup.id, updated: true, fact: store.findFact(dup.id) }
    }
    const f = store.addFact({ text: t, subj, aboutName: String(aboutName || ''), src, conf: c, chatId: String(chatId || ''), tags: (tags || []).slice(0, 5), archived: isHardFact({ text: t, src, conf: c }) })
    return { ok: true, message: '✓', id: f.id, fact: f }
  }

  // 修正一条事实：追加新行 + supersedes 链，旧行不变（t0 继承旧版）。
  function revise(id, patch = {}) {
    const f = store.findFact(id)
    if (!f) return { ok: false, message: '没找到这条' }
    const text = patch.text !== undefined ? String(patch.text).trim().slice(0, 200) : f.text
    if (!text) return { ok: false, message: '内容是空的' }
    const conf = patch.conf !== undefined ? clamp(patch.conf) : f.conf
    const nf = store.supersede(f.id, { text, subj: f.subj, aboutName: patch.aboutName ?? f.aboutName, src: f.src, conf, chatId: f.chatId, tags: Array.isArray(patch.tags) ? patch.tags.slice(0, 5) : f.tags, archived: f.archived })
    return { ok: true, message: '改好了', id: nf.id, fact: nf }
  }

  // 遗忘一条事实：记墓碑（invalidAt），旧行不改。
  function forget(id) {
    const f = store.findFact(id)
    if (!f) return { ok: false, message: '没找到这条' }
    store.forget(id)
    return { ok: true }
  }

  // 召回：直接返回 v2 结果（lines 已格式化，candidates 是原始命中）。
  function recall(query, { about = '', limit, mood, recent } = {}) {
    return recallModule.recall(String(query || ''), { about, mood: mood ?? null, recent: recent || [], now: Date.now(), limit })
  }

  function facts() { return store.facts() }
  function episodes() { return store.episodes() }
  function edges() { return store.edges() }
  function stats() { return store.stats() }
  function lastConsolidate() { return loadRuns().lastConsolidate || null }

  return {
    contextFor, tick, consolidate, extractDiary,
    remember, revise, forget, recall, facts, episodes, edges, stats, lastConsolidate,
    // 内部（host.js 装配用 / 面板自证用）
    store, recallModule, encode, replay, receipt,
    migrate: () => migrateLegacy({ store, log }),
  }
}
