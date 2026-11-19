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
import { dataDir, numOr, readJson, writeJson, lockAndRun } from '../core/store.js'
import { createMemStore } from './store.js'
import { createRecall } from './recall.js'
import { createReceipt } from './receipt.js'
import { createEncode } from './encode.js'
import { createReplay } from './replay.js'
import { migrateLegacy } from './migrate.js'
import { isDup, isHardFact, normalizeText } from './similar.js'
import { OWNER_ID } from '../chat/access.js'

const SRC_MAP = { tool: 'manual', panel: 'manual', manual: 'manual', import: 'manual', auto: 'inferred', event: 'self_did', diary: 'self_did' }

// 记忆运行参数内置（DESIGN-modular.md §3）：召回条数 / 整理节奏归 Ta 自己，用户不可调。
// consolidate 不再绑 04:00——改成距上次 ≥30 分钟增量整理（白天也长事件）；
// replay（联想建边/遗忘/自我提炼）每天一次，也不再绑凌晨（主人从不通宵，事件和联想从来没长出来过）。
// #21：不再是「整批记忆塞提示」——每轮只捞最相关的 4 条，外加偶尔一次「忽然想起」。
const MEMORY_BUILTIN = { recallCount: 4, dailyConsolidate: true, consolidateGapMinutes: 30, replayAfterHour: 3 }

export function createMemoryV2({ dsh, getConfig, hub, log = console, life, self, chemistry }) {
  const store = createMemStore({ log })
  const recallModule = createRecall({ store, getConfig, log })
  const receipt = createReceipt({ store, log })
  const encode = createEncode({ dsh, getConfig, store, log })
  const replay = createReplay({ store, life, self, dsh, getConfig, log })

  // 一次性迁移（幂等，可重复跑）：memories.json → mem/facts + mem/archive.json
  migrateLegacy({ store, log }).catch((error) => log.warn('记忆迁移失败：' + (error?.message || error)))

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
        chatId: chat?.chatId || '',
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
    // #21：偶尔（45 分钟内最多一次）在对话里「忽然想起」一件旧事——不是每轮都硬塞，
    // 也不只在主动开口那条链路（drive）里才有想起的记忆。
    if (chat?.chatId === OWNER_ID && !chat?.system) {
      try {
        const runs = loadRuns()
        const now = Date.now()
        if (now - (Number(runs.lastSpontaneousAt) || 0) > 45 * 60_000) {
          const sp = recallModule.spontaneous(now, { chatId: OWNER_ID })
          if (sp?.line) {
            parts.push('（' + sp.line + '。这件旧事别特意提，想到就顺口带一句，想不起来就放着。）')
            // #14b：这次真的注入了这一轮上下文，才算「想起来过」，再进 12 小时冷却。
            if (typeof sp.mark === 'function') sp.mark().catch(() => {})
            runs.lastSpontaneousAt = now
            saveRuns(runs)
          }
        }
      } catch {}
    }
    return parts.join('\n')
  }

  // ---- 主链路 2：consolidate（编码新消息 → episode + fact）----
  // LLM 不进锁（#46）：旧实现把 encodeSegment 放在 memory-tick 锁里，模型一挂
  // 整个记忆整理就永久卡死。现在拆三段：锁内认领 → 锁外调模型 → 锁内推进水位。
  let busy = false
  const CLAIM_TTL_MS = 10 * 60_000
  const CONSOLIDATE_LOCK = { staleMs: 15000, timeoutMs: 10000 }

  function consolidate() {
    if (busy) return Promise.resolve({ ok: false, message: '正在整理中' })
    busy = true
    return consolidateRun().finally(() => { busy = false })
  }

  async function consolidateRun() {
    let jobs = []
    try {
      jobs = await lockAndRun('memory-tick', () => {
        const runs = loadRuns()
        const claims = Object.fromEntries(
          Object.entries(runs.consolidateClaims || {})
            .filter(([, x]) => x && Date.now() - Number(x.at || 0) < CLAIM_TTL_MS),
        )
        const wm = loadWatermark()
        const out = []
        for (const chatId of listChatIds()) {
          if (String(chatId).startsWith('system')) continue
          if (claims[chatId]) continue
          let msgs = []
          try {
            const page = hub?.pageOf?.(chatId, { limit: 200 })
            msgs = (Array.isArray(page) ? page : (page?.messages || [])).slice().reverse()
          } catch { continue }
          if (!msgs.length) continue
          const since = Number(wm[chatId]) || 0
          // 语音消息的正文只有「[语音 · 2秒]」占位符，真正说的是 m.heard（转录）；
          // 以前这里只搬 text，编码侧永远读不到转录，事件摘要会写成「只收到语音，没有可转写内容」。
          const fresh = msgs.filter((m) => (m.t || 0) > since && (m.text || m.heard) && !String(m.text || '').startsWith('【系统'))
          if (!fresh.length) continue
          claims[chatId] = { at: Date.now(), upto: Math.max(since, ...fresh.map((m) => m.t)) }
          out.push({ chatId, since, fresh: fresh.map((m) => ({ id: m.id, t: m.t, who: m.who, uid: m.uid, text: m.text, heard: m.heard })) })
        }
        runs.consolidateClaims = claims
        saveRuns(runs)
        return out
      }, CONSOLIDATE_LOCK)
    } catch (error) {
      log.warn('记忆编码认领失败：', error.message)
      return { ok: false, message: error.message }
    }

    if (!jobs.length) {
      const last = loadRuns().lastConsolidate || null
      return last
        ? { ok: true, added: 0, superseded: 0, episodes: 0, receipt: last.receipt || 'found', last }
        : { ok: true, added: 0, superseded: 0, episodes: 0, receipt: 'found' }
    }

    let added = 0
    let superseded = 0
    let episodes = 0
    const factIds = []
    for (const job of jobs) {
      try {
        const names = { [OWNER_ID]: getConfig().ownerName || '主人' }
        const res = await encode.encodeSegment(job.chatId, job.fresh, { names })
        added += res.facts.added
        superseded += res.facts.superseded
        episodes += res.episodes.length
        factIds.push(...(res.facts.addedIds || []), ...(res.facts.supersededIds || []))
        await lockAndRun('memory-tick', () => {
          const wm = loadWatermark()
          wm[job.chatId] = Math.max(Number(wm[job.chatId]) || 0, ...job.fresh.map((m) => m.t))
          saveWatermark(wm)
          const runs = loadRuns()
          if (runs.consolidateClaims) delete runs.consolidateClaims[job.chatId]
          saveRuns(runs)
        }, CONSOLIDATE_LOCK)
      } catch (error) {
        log.warn(`记忆编码（${job.chatId}）失败：`, error.message)
        try {
          await lockAndRun('memory-tick', () => {
            const runs = loadRuns()
            if (runs.consolidateClaims) delete runs.consolidateClaims[job.chatId]
            saveRuns(runs)
          }, CONSOLIDATE_LOCK)
        } catch {}
      }
    }

    // #2（结构性）：历史里正则猜出来的 kind 定期交给模型批量纠正，别让「猜」一直留着。
    // 每 24 小时最多一轮，最多 20 条（模型调用在 memory-tick 锁外）。
    try {
      const runs = loadRuns()
      if (Date.now() - (Number(runs.lastKindFixAt) || 0) > 24 * 3600_000) {
        const fixed = await encode.fixKinds({ limit: 20 })
        await lockAndRun('memory-tick', () => {
          const r2 = loadRuns()
          r2.lastKindFixAt = Date.now()
          if (fixed > 0) r2.lastKindFixed = Number(r2.lastKindFixed || 0) + fixed
          saveRuns(r2)
        }, CONSOLIDATE_LOCK)
        if (fixed > 0) log.info(`记忆类型纠正：${fixed} 条`)
      }
    } catch (error) {
      log.warn('记忆类型纠正失败：' + (error?.message || error))
    }

    const verify = receipt.verifyFacts(factIds)
    const state = factIds.length ? (verify.missing.length ? 'missing' : 'found') : 'found'
    try {
      await lockAndRun('memory-tick', () => {
        const runs = loadRuns()
        runs.lastConsolidate = { day: dayKey(), at: Date.now(), added, superseded, episodes, receipt: state }
        saveRuns(runs)
      }, CONSOLIDATE_LOCK)
    } catch (error) {
      log.warn('记忆编码收尾失败：', error.message)
    }

    log.info(`记忆编码：新增 ${added} 条、更新 ${superseded} 条、事件 ${episodes} 段，回执 ${state}`)
    return { ok: true, added, superseded, episodes, receipt: { state, found: verify.found.length, missing: verify.missing.length } }
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
        // #7：replay 跑几十秒，期间别的进程可能已经改了 runs.json（consolidate 记录、claim、lastKindFixAt）。
        // 用旧快照整份 save 会把这些全盖掉——锁内重新读，只合并 lastReplay 一个字段。
        await lockAndRun('memory-tick', () => {
          const fresh = loadRuns()
          fresh.lastReplay = { day: today, at: Date.now(), edges: replayReport.edgesAdded, forgotten: replayReport.forgotten }
          saveRuns(fresh)
        }, { staleMs: 15000, timeoutMs: 10000 })
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
  const clamp = (n) => Math.max(0, Math.min(1, numOr(n, 0.5)))

  // 记一条事实：判重命中则 bumpHit（不动 t0），否则追加新行。
  function remember({ text, about = '', aboutName = '', conf = 0.5, source = 'tool', chatId = '', tags = [] }) {
    const t = String(text || '').trim().slice(0, 200)
    if (!t) return { ok: false, message: '内容是空的' }
    const src = SRC_MAP[source] || 'inferred'
    const c = clamp(conf)
    const subj = String(about || '')
    // 判重范围跟 chatId 对齐（#18）：客人的话不能并进主人的事实；chatId 为空 = 全局共享。
    const scope = String(chatId || '')
    const dup = store.currentFacts().find((f) => {
      const fc = String(f.chatId || '')
      return (fc === scope || fc === '' || scope === '') && isDup({ text: t, subj }, f)
    })
    if (dup) {
      // 新说法更具体 → supersede 合并，别只 bumpHit 把细节丢掉（复查 #9）。
      const oldText = String(dup.text || '')
      if (t.length > oldText.length + 4 && normalizeText(t) !== normalizeText(oldText)) {
        store.supersede(dup.id, { text: t, subj: subj || dup.subj, aboutName: String(aboutName || dup.aboutName || ''), src, conf: c, chatId: dup.chatId || String(chatId || ''), tags: (tags || []).slice(0, 5), archived: isHardFact({ text: t, src, conf: c }) })
          .catch((error) => log.warn('记忆合并失败：' + (error?.message || error)))
        return { ok: true, message: '✓', id: dup.id, updated: true, fact: { ...dup, text: t } }
      }
      store.bumpHit(dup.id).catch((error) => log.warn('记忆命中计数写失败：' + (error?.message || error)))
      return { ok: true, message: '✓', id: dup.id, updated: true, fact: store.findFact(dup.id) }
    }
    const f = store.addFact({ text: t, subj, aboutName: String(aboutName || ''), src, conf: c, chatId: String(chatId || ''), tags: (tags || []).slice(0, 5), archived: isHardFact({ text: t, src, conf: c }) })
    return { ok: true, message: '✓', id: f.id, fact: f }
  }

  // 修正一条事实：追加新行 + supersedes 链，旧行不变（t0 继承旧版）。
  async function revise(id, patch = {}) {
    const f = store.findFact(id)
    if (!f) return { ok: false, message: '没找到这条' }
    const text = patch.text !== undefined ? String(patch.text).trim().slice(0, 200) : f.text
    if (!text) return { ok: false, message: '内容是空的' }
    const conf = patch.conf !== undefined ? clamp(patch.conf) : f.conf
    const nf = await store.supersede(f.id, { text, subj: f.subj, aboutName: patch.aboutName ?? f.aboutName, src: f.src, conf, chatId: f.chatId, tags: Array.isArray(patch.tags) ? patch.tags.slice(0, 5) : f.tags, archived: f.archived })
    return { ok: true, message: '改好了', id: nf.id, fact: nf }
  }

  // 遗忘一条事实：记墓碑（invalidAt），旧行不改。
  async function forget(id) {
    const f = store.findFact(id)
    if (!f) return { ok: false, message: '没找到这条' }
    await store.forget(id)
    return { ok: true }
  }

  // 召回：直接返回 v2 结果（lines 已格式化，candidates 是原始命中）。
  function recall(query, { about = '', limit, mood, recent, chatId = '' } = {}) {
    return recallModule.recall(String(query || ''), { about, mood: mood ?? null, recent: recent || [], now: Date.now(), limit, chatId: String(chatId || '') })
  }

  // 落一条梦（#24 梦的落库）：梦不是事实，只写 episode（kind='dream'），
  // 再把素材 id ↔ 梦 id 连成 kind='dreamed' 的联想边——以后 recall 到那条旧事时，
  // assocExpand 会带出「我梦见过这件事」，这是梦进入人格的唯一通道。
  function recordDream({ title = '', mood = 'weird', text = '', about = '', materials = [], stage = '', at = Date.now() } = {}) {
    const body = String(text || '').trim().slice(0, 600)
    if (!body) return { ok: false }
    const ids = (Array.isArray(materials) ? materials : []).filter((x) => typeof x === 'string' && x).slice(0, 8)
    const ep = store.addEpisode({
      t0: at,
      t1: at,
      chatId: '',
      people: about ? [String(about).slice(0, 40)] : [],
      moodIn: null,
      moodOut: null,
      summary: `${String(title || '').slice(0, 40)}${title ? '：' : ''}${body}`,
      tags: ['dream', String(mood || 'weird')].filter(Boolean),
      salience: mood === 'bad' ? 0.75 : 0.65,
      kind: 'dream',
      title: String(title || '').slice(0, 40),
      mood: String(mood || 'weird').slice(0, 20),
      materials: ids,
      stage: String(stage || '').slice(0, 10),
    })
    // 建边要幂等（用 mid|ep|dreamed 做去重键）：多进程/重试都只连一次。
    const existing = new Set(store.edges().map((e) => `${e.a}|${e.b}|${e.kind}`))
    for (const mid of ids) {
      const key = `${mid}|${ep.id}|dreamed`
      if (existing.has(key)) continue
      existing.add(key)
      store.addEdge({ a: mid, b: ep.id, kind: 'dreamed', w: 1, why: 'dream', at })
    }
    return { ok: true, episode: ep }
  }

  function facts() { return store.facts() }
  function episodes() { return store.episodes() }
  function edges() { return store.edges() }
  function stats() { return store.stats() }
  function lastConsolidate() { return loadRuns().lastConsolidate || null }

  return {
    contextFor, tick, consolidate, extractDiary,
    remember, revise, forget, recall, facts, episodes, edges, stats, lastConsolidate,
    // 梦落库（#24）：episode + dreamed 边，不写 facts。
    recordDream,
    // 忽然想起（#17）：给 drive 的主动开口/梦提供素材，而不是每轮把记忆整批塞提示。
    // opts = { chatId }：单聊里不想起别的会话的事。
    spontaneous: (now = Date.now(), opts = {}) => recallModule.spontaneous(now, opts),
    // 内部（host.js 装配用 / 面板自证用）
    store, recallModule, encode, replay, receipt,
    // 启动时的一次性整理：命中计数迁到单独文件后，把 facts 分片里同 id 的重复行清掉。
    compactFacts: () => store.compactFacts(),
    migrate: () => migrateLegacy({ store, log }),
  }
}
