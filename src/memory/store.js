// memory/store.js — 记忆 v2 的落盘层。
//
// 原则（DESIGN-life.md §5.1）：
//   - 原文永不复制、记录永不改写、索引可重建。
//   - facts / episodes / edges 按「月」分片 append-only 写 JSONL；
//     每条一行，写坏一行不影响其余行，且文件可被人类直接读懂。
//   - 事实版本链：更新/纠错 = 追加新行 + `supersedes` 指向旧 id，
//     旧行永不改。查「当前事实」= 排除被任何 `supersedes` 指向的行。
//
// 体量（DESIGN §5.2）：episode 200-400B/条、fact ~300B/条，一年 <5MB，
// 启动时全量载入内存，append 只碰当月分片。
import { randomUUID } from 'node:crypto'
import { appendFileSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir, ensureDir, numOr, lockAndRun } from '../core/store.js'
import { inferKind } from './similar.js'

export const monthKey = (t = Date.now()) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export function newId() {
  return randomUUID().slice(0, 8)
}

export function createMemStore({ log = console } = {}) {
  const root = () => dataDir('mem')
  const dirOf = (kind) => join(root(), kind)

  let cache = null // { facts, episodes, edges }

  function loadLines(dir) {
    const out = []
    let names = []
    try { names = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort() } catch { return out }
    for (const f of names) {
      let txt = ''
      try { txt = readFileSync(join(dir, f), 'utf8') } catch { continue }
      for (const line of txt.split('\n')) {
        const s = line.trim()
        if (!s) continue
        try { out.push(JSON.parse(s)) } catch { /* 跳过坏行 */ }
      }
    }
    return out
  }

  // 缓存戳：facts/episodes/edges 分片文件的「名字+大小+mtime」。
  // 别的进程往盘里追加时戳会变，本进程读到新数据（#20：以前只有本进程 append 才失效，
  // 读路径永远拿旧缓存，别的进程刚记的事实看不见，命中计数还会被旧行覆盖回去）。
  function stampOf(kind) {
    const dir = dirOf(kind)
    let names = []
    try { names = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort() } catch { return '' }
    let out = ''
    for (const n of names) {
      try { const st = statSync(join(dir, n)); out += `${n}:${st.size}:${st.mtimeMs}|` } catch { /* 文件刚好被删就跳过 */ }
    }
    return out
  }

  function all() {
    const stamp = `${stampOf('facts')}#${stampOf('episodes')}#${stampOf('edges')}`
    if (cache && cache.stamp === stamp) return cache
    // 事实按 id 取「最后一行」：bumpHit 会追加同一 id 的新行（只改命中计数），
    // 后面的行是更新的状态；内容字段（t0/text/supersedes）从不改写，所以 last-wins 安全。
    const factsById = new Map()
    for (const f of loadLines(dirOf('facts'))) factsById.set(f.id, f)
    cache = {
      stamp,
      facts: [...factsById.values()],
      factsById,
      episodes: loadLines(dirOf('episodes')),
      edges: loadLines(dirOf('edges')),
    }
    return cache
  }

  const invalidate = () => { cache = null }

  function append(kind, obj) {
    ensureDir(dirOf(kind))
    appendFileSync(join(dirOf(kind), `${monthKey()}.jsonl`), JSON.stringify(obj) + '\n', 'utf8')
    invalidate()
    return obj
  }

  // ---- 事实 ----
  function addFact(f) {
    const fact = {
      id: f.id || newId(),
      t0: f.t0 ?? Date.now(),
      text: String(f.text || '').trim().slice(0, 200),
      subj: String(f.subj ?? f.about ?? ''),
      aboutName: String(f.aboutName || ''),
      src: f.src || 'inferred',
      conf: Math.max(0, Math.min(1, numOr(f.conf, 0.5))),
      ev: Array.isArray(f.ev) ? f.ev : [],
      supersedes: f.supersedes || null,
      archived: Boolean(f.archived),
      tags: Array.isArray(f.tags) ? f.tags.slice(0, 8) : [],
      chatId: String(f.chatId || ''),
      // 事实类型：状态型（bug 在不在/版本多少）和偏好型（爱吃白米饭）不该用同一种存储语义——
      // 状态型会被现实事件推翻、必须能复审；偏好型更稳定、按硬档处理。
      // kind 优先用抽取模型给的（#2），没给才走正则兜底；kindSrc 留痕，方便以后纠正。
      kind: f.kind || inferKind(f.text, f.src),
      kindSrc: f.kindSrc || (f.kind ? 'llm' : 'heuristic'),
      ...(f.hits != null ? { hits: Number(f.hits) || 0, hitDays: Number(f.hitDays) || 0, lastHit: f.lastHit || 0 } : {}),
    }
    return append('facts', fact)
  }

  function facts() { return all().facts }

  // 被任何 `supersedes` 指向的 id = 已被取代（死行）
  function supersededIds() {
    const s = new Set()
    for (const f of facts()) if (f.supersedes) s.add(f.supersedes)
    return s
  }

  function isCurrent(f, dead = supersededIds()) {
    return !f.invalidAt && !dead.has(f.id)
  }

  // 当前（未失效且未被取代）的事实，按 t0 升序
  function currentFacts() {
    const dead = supersededIds()
    return facts().filter((f) => isCurrent(f, dead)).sort((a, b) => a.t0 - b.t0)
  }

  function findFact(id) {
    return all().factsById.get(String(id)) || null
  }

  // 沿 supersedes 链取未失效的「头」（最新版本）
  function headOf(id) {
    const byId = all().factsById
    let cur = byId.get(String(id))
    if (!cur) return null
    const seen = new Set()
    while (!seen.has(cur.id)) {
      seen.add(cur.id)
      const next = facts().filter((f) => f.supersedes === cur.id).sort((a, b) => b.t0 - a.t0)[0]
      if (!next) return cur
      cur = next
    }
    return cur
  }

  // 某人（subj）的当前事实
  function factsBySubj(subj) {
    const dead = supersededIds()
    return facts().filter((f) => f.subj === String(subj) && isCurrent(f, dead)).sort((a, b) => a.t0 - b.t0)
  }

  // 命中仅更新 hits/lastSeen，不动 t0（修 memory.js:160 的 bug）
  // 多进程下 find→append 的读-改-写进锁（审计：无锁 RMW）。
  function bumpHit(id, now = Date.now()) {
    return lockAndRun('mem-facts', () => {
      // 锁内读之前先丢掉进程缓存：all() 的 cache 只有本进程 append 时才失效，
      // 别的进程刚写的新事实/新计数会被旧缓存整份覆盖回去（#14）。
      invalidate()
      const f = findFact(id)
      if (!f) return false
      if (!f.lastHit || new Date(f.lastHit).toDateString() !== new Date(now).toDateString()) f.hitDays = (f.hitDays || 0) + 1
      f.hits = (f.hits || 0) + 1
      f.lastHit = now
      append('facts', { ...f })
      return true
    }, { staleMs: 10000, timeoutMs: 5000 })
  }

  // 遗忘：append 一行 invalidAt 墓碑（旧行不改，last-wins 后 isCurrent 判失效）。
  // 只在重放（replay.js）发生；硬档（archived）永不遗忘。
  function forget(id, now = Date.now()) {
    return lockAndRun('mem-facts', () => {
      invalidate()
      const f = findFact(id)
      if (!f || f.invalidAt) return false
      append('facts', { ...f, invalidAt: now })
      return true
    }, { staleMs: 10000, timeoutMs: 5000 })
  }

  // 追加新事实并让 `supersedes` 指向旧 id（旧行不改，天然版本链）
  function supersede(oldId, patch) {
    return lockAndRun('mem-facts', () => {
      invalidate()
      const old = findFact(oldId)
      const fact = addFact({
        ...patch,
        supersedes: oldId,
        t0: patch.t0 ?? (old ? old.t0 : Date.now()), // t0 保持第一次发生的时间
        subj: patch.subj ?? old?.subj ?? '',
        aboutName: patch.aboutName ?? old?.aboutName ?? '',
      })
      return fact
    }, { staleMs: 10000, timeoutMs: 5000 })
  }

  // 把某条事实挂到一个 episode 上（证据链：这条记忆来自哪段经历）。
  // append 一行带新 ev 的同一 id（last-wins），旧行不改；幂等（去重）。
  function linkEvidence(factId, episodeId) {
    return lockAndRun('mem-facts', () => {
      invalidate()
      const f = findFact(factId)
      if (!f) return false
      const ev = Array.isArray(f.ev) ? f.ev : []
      if (ev.includes(episodeId)) return false
      append('facts', { ...f, ev: [...ev, episodeId] })
      return true
    }, { staleMs: 10000, timeoutMs: 5000 })
  }

  // 纠正事实类型（#2）：抽取时模型给了明确 kind、旧记忆却是正则兜底猜出来的，
  // 就在同一 id 上追加一行修正记录（last-wins，审计留痕）。
  function setFactKind(id, kind) {
    return lockAndRun('mem-facts', () => {
      invalidate()
      const f = findFact(id)
      if (!f) return false
      const next = String(kind || '')
      if (!['state', 'preference', 'knowledge', 'memory'].includes(next)) return false
      // 同一类型也要留痕：模型确认过的 kind 值得标成 llm，否则会被当成「猜的」反复送去纠正。
      if (f.kind === next && f.kindSrc === 'llm') return false
      append('facts', { ...f, kind: next, kindSrc: 'llm' })
      return true
    }, { staleMs: 10000, timeoutMs: 5000 })
  }

  // 标记「这条事实最近被主动想起/说过」（防同一句反复被忽然想起）。
  function markSpoken(id, now = Date.now()) {
    return lockAndRun('mem-facts', () => {
      invalidate()
      const f = findFact(id)
      if (!f) return false
      append('facts', { ...f, lastSpokenAt: now })
      return true
    }, { staleMs: 10000, timeoutMs: 5000 })
  }

  // 标记「这条事实刚被审计过」（防状态型事实每天都被复审、天天烧模型）。
  function markAudited(id, now = Date.now()) {
    return lockAndRun('mem-facts', () => {
      invalidate()
      const f = findFact(id)
      if (!f) return false
      append('facts', { ...f, lastAuditAt: now })
      return true
    }, { staleMs: 10000, timeoutMs: 5000 })
  }

  // ---- 事件 ----
  function addEpisode(e) {
    const ep = {
      id: e.id || newId(),
      t0: e.t0 ?? Date.now(),
      t1: e.t1 ?? e.t0 ?? Date.now(),
      chatId: String(e.chatId || ''),
      people: Array.isArray(e.people) ? e.people : [],
      moodIn: e.moodIn ?? null,
      moodOut: e.moodOut ?? null,
      raw: e.raw || null, // { segId, from, to } 只存原文区间指针
      summary: String(e.summary || ''),
      tags: Array.isArray(e.tags) ? e.tags.slice(0, 8) : [],
      salience: Math.max(0, Math.min(1, numOr(e.salience, 0.5))),
      d: e.d ?? null, // 区分度，Slice 4 填
      S: e.S ?? null, // 记忆强度，Slice 4 用
      recallCount: Number(e.recallCount) || 0,
      lastRecall: e.lastRecall || 0,
      // 梦（#24）：梦不是事实，只落 episode；kind/title/mood/materials 让以后能召回「我梦见过这件事」。
      kind: String(e.kind || 'event').slice(0, 20),
      title: String(e.title || '').slice(0, 40),
      mood: String(e.mood || '').slice(0, 20),
      materials: Array.isArray(e.materials) ? e.materials.filter((x) => typeof x === 'string' && x).slice(0, 8) : [],
      stage: String(e.stage || '').slice(0, 10),
    }
    return append('episodes', ep)
  }

  function episodes() { return all().episodes }

  // ---- 联想边（Slice 4 建，这里先提供写入口）----
  function addEdge(e) {
    const edge = {
      id: e.id || newId(),
      a: String(e.a || ''),
      b: String(e.b || ''),
      kind: e.kind || 'assoc', // evidence | assoc
      w: Math.max(0, numOr(e.w, 1)),
      why: String(e.why || ''),
      at: e.at ?? Date.now(),
    }
    return append('edges', edge)
  }

  function edges() { return all().edges }

  function stats() {
    const dead = supersededIds()
    const fs = facts()
    const live = fs.filter((f) => isCurrent(f, dead))
    return {
      facts: fs.length,
      currentFacts: live.length,
      superseded: fs.length - live.length,
      archived: live.filter((f) => f.archived).length,
      episodes: episodes().length,
      edges: edges().length,
    }
  }

  // 按 chatId 清理一个会话的全部记忆（删客人时用）：重写分片、丢掉该会话的事实/事件
  // 以及连着这些事实的联想边。返回各 kind 删掉的条数。
  // A1：整份重写月度分片必须和 append/patch 共用 mem-facts 锁；
  // 写盘失败直接抛给调用方（别再 try{}catch{} 静默），否则删客人时记忆静默残留。
  function purgeChat(chatId) {
    const id = String(chatId || '')
    if (!id) return Promise.resolve({ facts: 0, episodes: 0, edges: 0 })
    return lockAndRun('mem-facts', () => {
    const removed = new Set()
    const filterKind = (kind, keepFn) => {
      const dir = dirOf(kind)
      let names = []
      try { names = readdirSync(dir).filter((f) => f.endsWith('.jsonl')) } catch { return 0 }
      let dropped = 0
      for (const name of names) {
        const p = join(dir, name)
        let txt = ''
        try { txt = readFileSync(p, 'utf8') } catch { continue }
        const keep = []
        for (const line of txt.split('\n')) {
          const s = line.trim()
          if (!s) continue
          let rec = null
          try { rec = JSON.parse(s) } catch { continue }
          if (keepFn(rec)) keep.push(s)
          else {
            dropped++
            if (kind === 'facts' && rec.id) removed.add(rec.id)
          }
        }
        if (dropped) writeFileSync(p, keep.length ? keep.join('\n') + '\n' : '')
      }
      return dropped
    }
    const facts = filterKind('facts', (r) => r.chatId !== id && r.subj !== id)
    const eps = filterKind('episodes', (r) => r.chatId !== id)
    const edges = filterKind('edges', (r) => !removed.has(r.a) && !removed.has(r.b))
    invalidate()
    return { facts, episodes: eps, edges }
    }, { staleMs: 10000, timeoutMs: 15000 })
  }

  // 破坏性清空（仅 debug 用，见 web/routes/debug.js）：删掉该 kind 的全部 jsonl。
  function clear(kind) {
    const dir = dirOf(kind)
    let n = 0
    try {
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.jsonl')) continue
        unlinkSync(join(dir, f))
        n++
      }
    } catch { /* 目录不存在 = 已空 */ }
    invalidate()
    return n
  }

  return {
    addFact, addEpisode, addEdge,
    facts, episodes, edges,
    currentFacts, findFact, headOf, factsBySubj,
    bumpHit, supersede, forget, linkEvidence,
    markSpoken, markAudited, setFactKind,
    stats, newId, monthKey, clear, purgeChat,
  }
}
