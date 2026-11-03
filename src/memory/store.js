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
import { appendFileSync, readdirSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir, ensureDir, withFileLock } from '../core/store.js'

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

  function all() {
    if (cache) return cache
    // 事实按 id 取「最后一行」：bumpHit 会追加同一 id 的新行（只改命中计数），
    // 后面的行是更新的状态；内容字段（t0/text/supersedes）从不改写，所以 last-wins 安全。
    const factsById = new Map()
    for (const f of loadLines(dirOf('facts'))) factsById.set(f.id, f)
    cache = {
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
      conf: Math.max(0, Math.min(1, Number(f.conf) ?? 0.5)),
      ev: Array.isArray(f.ev) ? f.ev : [],
      supersedes: f.supersedes || null,
      archived: Boolean(f.archived),
      tags: Array.isArray(f.tags) ? f.tags.slice(0, 8) : [],
      chatId: String(f.chatId || ''),
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
    return withFileLock('mem-facts', () => {
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
    return withFileLock('mem-facts', () => {
      const f = findFact(id)
      if (!f || f.invalidAt) return false
      append('facts', { ...f, invalidAt: now })
      return true
    }, { staleMs: 10000, timeoutMs: 5000 })
  }

  // 追加新事实并让 `supersedes` 指向旧 id（旧行不改，天然版本链）
  function supersede(oldId, patch) {
    return withFileLock('mem-facts', () => {
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
    return withFileLock('mem-facts', () => {
      const f = findFact(factId)
      if (!f) return false
      const ev = Array.isArray(f.ev) ? f.ev : []
      if (ev.includes(episodeId)) return false
      append('facts', { ...f, ev: [...ev, episodeId] })
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
      salience: Math.max(0, Math.min(1, Number(e.salience) ?? 0.5)),
      d: e.d ?? null, // 区分度，Slice 4 填
      S: e.S ?? null, // 记忆强度，Slice 4 用
      recallCount: Number(e.recallCount) || 0,
      lastRecall: e.lastRecall || 0,
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
      w: Math.max(0, Number(e.w) ?? 1),
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
    stats, newId, monthKey, clear,
  }
}
