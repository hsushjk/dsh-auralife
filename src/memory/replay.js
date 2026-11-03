// memory/replay.js — 重放（对应 digital-life-core 的「梦境」）。
//
// DESIGN-life.md §5.3：只发生在凌晨 consolidate 时段。做的事：
//   1. 建联想边（evidence：fact←episode；assoc：同主体 fact←fact，相似度做权重）；
//   2. 遗忘只在此发生：间隔重复 recallability 掉到阈值以下且非硬档 → 记墓碑失效；
//   3. 提炼 self：从「她做过/答应过/被推测」的事实提炼自我认知（life/self.js）。
//
// 与旧 memory.js 的「摘要的摘要」彻底分手：不再把旧 profile 喂回去生成新 profile。
import { recallability } from './recall.js'
import { similarity } from './similar.js'
import { createAssess } from './assess.js'
import { withFileLock } from '../core/store.js'

// 遗忘阈值：recallability 低于此值且非硬档 → 忘掉。
// recallability = exp(-days / tau)，tau = 20×strength×(0.5+conf)。
// conf=0.4、从未被回忆的事实约 60 天后跌到 0.05；conf=0.9 的硬档用烙印曲线（见下）。
export const FORGET_RECALLABILITY = 0.05

// 烙印（需求 7）：硬档不是「永不遗忘」，而是「极难磨灭」——
// tau 365 天、阈值 0.001 → 约 7 年才磨灭；仍可被 supersede 立刻推翻（版本链照常）。
export const BRAND_TAU_DAYS = 365
export const BRAND_FORGET_RECALLABILITY = 0.001

export function createReplay({ store, life, self, dsh, getConfig, log = console }) {
  const assess = createAssess({ dsh, getConfig, store, log })
  // 1) 建联想边（幂等：已存在的 (a,b,kind) 不重复写）
  function buildEdges(now = Date.now()) {
    const fs = store.currentFacts()
    const eps = store.episodes()
    const existing = new Set(store.edges().map((e) => `${e.a}|${e.b}|${e.kind}`))
    const added = []
    const push = (a, b, kind, w, why) => {
      if (!a || !b || a === b) return
      const key = `${a}|${b}|${kind}`
      if (existing.has(key)) return
      existing.add(key)
      added.push(store.addEdge({ a, b, kind, w, why, at: now }))
    }

    // evidence：fact.ev 指向的 episode 与 fact 之间
    const epById = new Map(eps.map((e) => [e.id, e]))
    for (const f of fs) {
      for (const eid of f.ev || []) if (epById.has(eid)) push(f.id, eid, 'evidence', 1, 'episode')
    }

    // assoc：同主体（subj 或 aboutName）两两，Jaccard 相似度做权重（>0.15 才连）
    const bySubj = new Map()
    for (const f of fs) {
      const k = (f.subj || f.aboutName || '').trim()
      if (!k) continue
      if (!bySubj.has(k)) bySubj.set(k, [])
      bySubj.get(k).push(f)
    }
    for (const [, group] of bySubj) {
      if (group.length < 2) continue
      for (let i = 0; i < group.length; i++)
        for (let j = i + 1; j < group.length; j++) {
          const w = similarity(group[i].text, group[j].text)
          if (w > 0.15) push(group[i].id, group[j].id, 'assoc', Number(w.toFixed(3)), 'same-subject')
        }
    }
    return added
  }

  // 2) 遗忘：非硬档按 recallability、硬档按烙印曲线（极难磨灭但可磨灭）
  function forget(now = Date.now()) {
    const gone = []
    for (const f of store.currentFacts()) {
      if (f.archived) {
        // 烙印：tau 365 天、阈值 0.001（约 7 年）。不是不磨灭，是磨得极慢。
        const days = Math.max(0, (now - (f.t0 || now)) / 86400_000)
        const r = Math.exp(-days / BRAND_TAU_DAYS)
        if (r < BRAND_FORGET_RECALLABILITY && store.forget(f.id, now)) {
          gone.push({ id: f.id, text: f.text, recallability: Number(r.toFixed(4)), brand: true })
          log.info(`烙印磨灭：「${f.text.slice(0, 40)}」(recallability=${r.toFixed(4)})`)
        }
        continue
      }
      const r = recallability(f, now)
      if (r < FORGET_RECALLABILITY && store.forget(f.id, now)) {
        gone.push({ id: f.id, text: f.text, recallability: Number(r.toFixed(4)) })
        log.info(`遗忘：「${f.text.slice(0, 40)}」(recallability=${r.toFixed(4)})`)
      }
    }
    return gone
  }

  // 3) 提炼自我：只挑「她做过/答应过/被推测」且高可信的事实
  async function extractSelf(now = Date.now()) {
    const candidates = store.currentFacts().filter(
      (f) => (f.src === 'self_did' || f.src === 'inferred') && (Number(f.conf) ?? 0) >= 0.5,
    )
    if (!candidates.length) return { extracted: null, merged: false, version: null }
    const extracted = await self.extract(candidates, { now })
    const merged = self.merge(extracted, { now })
    return { extracted, merged: !!merged, version: merged ? merged.version : null }
  }

  // 主入口：重放一轮 = 建边 + 遗忘 + 认知审计 + 提炼 self + 读回自证。
  // 锁进公共入口：tick 与 debug 面板都能直接调 run，跨进程同一时刻只允许一个在重放。
  function run({ now = Date.now() } = {}) {
    return withFileLock('memory-tick', async () => {
      const before = store.stats()
      const edges = buildEdges(now)
      const forgotten = forget(now)
      const audited = await assess.auditFacts(now)
      const selfOut = await extractSelf(now)
      const after = store.stats()

      // 写完读回：边数涨了吗？self 版本升了吗？
      const selfVersion = (life.load().self || {}).version ?? 0
      return {
        edgesAdded: edges.length,
        forgotten: forgotten.length,
        audited: audited.audited,
        auditedOutdated: audited.outdated.length,
        selfVersion,
        receipt: { edgesWritten: after.edges >= before.edges + edges.length, selfMerged: selfOut.merged },
        stats: { before, after },
      }
    }, { staleMs: 300000 }) // 提炼 self 调 LLM，锁超龄放宽到 5 分钟
  }

  return { run, buildEdges, forget, extractSelf, assess }
}
