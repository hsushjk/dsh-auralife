// web/routes/debug.js — 每模块破坏性 debug 接口（DESIGN-modular.md §8）。
//
// 需求 9：虽然用户不能干预生命和记忆，但每个模块要留破坏性测试 API（可改聊天记录/记忆/生命状态），
// 用于测试、验收、开发调试。全部 requireOwner，全部记日志（log.warn），响应带 ok + 做了什么。
//
// 协议：POST /api/debug  body: { module, action, ...args }
//   memory: clear（清空全部）/ seed（注入事实）/ forget（id 打墓碑）/ consolidate（调模型）/ replay（调模型）/ list
//   chemistry: set（dopamine/cortisol/serotonin 绝对值）/ reset / event（delta 增量）
//   energy: set（level 绝对值）/ reset / spend
//   wishes: add / resolve（id 或 text 模糊）/ clear
//   self: reset（清自我认知）/ set（field+entries）
//   identity: set（name/ownerName/body，模拟 Ta 改人格）/ reset（清空覆盖回出厂种子）
//   alarm: set（at+reason）/ clear
//   chat: prune（清聊天历史+重置会话）/ inject（注入假消息）
import { dataDir } from '../../core/store.js'
import { join } from 'node:path'
import { readdirSync, unlinkSync, rmSync } from 'node:fs'
import { OWNER_ID } from '../../chat/access.js'

const num = (v, fallback, min, max) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

export function register(router, ctx) {
  const { json, readBody, requireOwner, log } = ctx

  router.add('POST', 'api/debug', async (req, res) => {
    const me = requireOwner(req, res); if (!me) return
    const b = await readBody(req)
    const mod = String(b.module || '')
    const action = String(b.action || '')
    const { hub, chemistry, energy, wishes, life, self, memory, alarm } = ctx.deps || {}
    const done = (extra = {}) => json(res, { ok: true, module: mod, action, ...extra })
    const bad = (reason) => json(res, { ok: false, reason: String(reason) })
    // 直改 state 的通用工具（chemistry/energy 都落盘 state.json）； 走锁内 RMW
    const patchState = (fn) => {
      life.update((s) => { fn(s) })
    }

    try {
      // ——— memory ———
      if (mod === 'memory') {
        if (action === 'clear') {
          const before = memory.stats()
          const files = memory.store.clear('facts') + memory.store.clear('episodes') + memory.store.clear('edges')
          log.warn(`[debug] memory.clear：${JSON.stringify(before)} → 0（删 ${files} 个 jsonl）`)
          return done({ before, after: memory.stats() })
        }
        if (action === 'seed') {
          const seeds = Array.isArray(b.facts) && b.facts.length ? b.facts : [{ text: '测试事实：主人最近喜欢喝热水', conf: 0.7, tags: ['debug'] }]
          const added = seeds.map((f) => memory.remember({
            text: String(f.text || ''),
            about: f.about || '',
            aboutName: f.aboutName || '',
            conf: num(f.conf, 0.6, 0, 1),
            source: 'manual',
            chatId: f.chatId || '',
            tags: [...(Array.isArray(f.tags) ? f.tags : []), 'debug'].slice(0, 8),
          }))
          log.warn(`[debug] memory.seed：注入 ${added.length} 条`)
          return done({ added: added.length, ids: added.map((x) => x.id) })
        }
        if (action === 'forget') {
          if (!b.id) return bad('要忘哪条，给 id')
          const r = memory.forget(String(b.id))
          log.warn(`[debug] memory.forget：${b.id}`)
          return done(r)
        }
        if (action === 'list') {
          // 调试台显示用：当前生效事实全量（不带召回，纯枚举）。
          let facts = []
          try { facts = memory.facts().filter((f) => !f.invalidAt) } catch {}
          return done({ facts: facts.slice(0, 200).map((f) => ({ id: f.id, text: f.text, src: f.src, conf: f.conf, archived: !!f.archived, hits: f.hits || 0, lastHit: f.lastHit || 0, invalidAt: f.invalidAt || null })), total: facts.length, stats: memory.stats() })
        }
        if (action === 'consolidate') {
          const r = await memory.consolidate({ force: true, includeToday: true })
          log.warn(`[debug] memory.consolidate：${JSON.stringify(r)}`)
          return done(r)
        }
        if (action === 'replay') {
          const r = await memory.replay.run({ now: Date.now() })
          log.warn(`[debug] memory.replay：${JSON.stringify(r)}`)
          return done(r)
        }
      }

      // ——— chemistry ———
      if (mod === 'chemistry') {
        if (action === 'set') {
          patchState((s) => {
            if (Number.isFinite(Number(b.dopamine))) s.chemistry.dopamine = num(b.dopamine, 50, 0, 100)
            if (Number.isFinite(Number(b.cortisol))) s.chemistry.cortisol = num(b.cortisol, 20, 0, 100)
            if (Number.isFinite(Number(b.serotonin))) s.chemistry.serotonin = num(b.serotonin, 50, 0, 100)
            s.chemistry.at = Date.now()
          })
          log.warn(`[debug] chemistry.set：${JSON.stringify(chemistry.peek())}`)
          return done({ chemistry: chemistry.peek() })
        }
        if (action === 'reset') {
          patchState((s) => { s.chemistry = { version: 1, at: Date.now(), dopamine: 50, cortisol: 20, serotonin: 50 } })
          log.warn('[debug] chemistry.reset')
          return done({ chemistry: chemistry.peek() })
        }
        if (action === 'event') {
          chemistry.event(b.delta && typeof b.delta === 'object' ? b.delta : { dopamine: num(b.dopamine, 0, -50, 50), cortisol: num(b.cortisol, 0, -50, 50), serotonin: num(b.serotonin, 0, -50, 50) })
          log.warn(`[debug] chemistry.event：${JSON.stringify(b.delta || {})}`)
          return done({ chemistry: chemistry.peek() })
        }
      }

      // ——— energy ———
      if (mod === 'energy') {
        if (action === 'set') {
          patchState((s) => {
            if (Number.isFinite(Number(b.level))) s.energy.level = num(b.level, 100, 0, 100)
            s.energy.at = Date.now()
          })
          log.warn(`[debug] energy.set：${JSON.stringify(energy.peek())}`)
          return done({ energy: energy.peek() })
        }
        if (action === 'reset') {
          patchState((s) => { s.energy = { version: 1, at: Date.now(), level: 100 } })
          log.warn('[debug] energy.reset')
          return done({ energy: energy.peek() })
        }
        if (action === 'spend') {
          const r = energy.spend()
          log.warn('[debug] energy.spend')
          return done({ energy: r })
        }
      }

      // ——— wishes ———
      if (mod === 'wishes') {
        if (action === 'list') {
          // 调试台补列举（前端展示 id/tension，配合 resolve/clear 用）
          return done({ wishes: wishes.list() })
        }
        if (action === 'add') {
          const w = wishes.add(String(b.text || 'debug 执念'), { baseTension: num(b.baseTension, 80, 0, 100), tensionRate: num(b.tensionRate, 5, 0, 50) })
          log.warn(`[debug] wishes.add：${w.text}`)
          return done({ wish: w })
        }
        if (action === 'resolve') {
          let target = null
          if (b.id) target = wishes.list().find((w) => w.id === String(b.id))
          else target = wishes.list().find((w) => w.status === 'open' && (w.text.includes(String(b.text || '')) || String(b.text || '').includes(w.text)))
          if (!target) return bad('没找到这条执念')
          const w = wishes.resolve(target.id, String(b.closedBy || 'debug 了结'))
          log.warn(`[debug] wishes.resolve：${target.text}`)
          return done({ wish: w })
        }
        if (action === 'clear') {
          const n = wishes.list().length
          patchState((s) => { s.wishes = [] })
          log.warn(`[debug] wishes.clear：${n} 条`)
          return done({ cleared: n })
        }
      }

      // ——— self ———
      if (mod === 'self') {
        if (action === 'list') {
          // 调试台补列举（三层现状 + 更新时间，配合 remove 用）
          const st = life.load()
          const s = st.self || {}
          return done({ self: { version: s.version || 0, updatedAt: s.updatedAt || 0, traits: s.traits || [], values: s.values || [], boundaries: s.boundaries || [] } })
        }
        if (action === 'remove') {
          // 调试台补删除（按 field+label 匹配删一条，版本 +1 与 merge 语义一致）
          const field = String(b.field || 'traits')
          if (!['traits', 'values', 'boundaries'].includes(field)) return bad('field 只能是 traits/values/boundaries')
          const label = String(b.label || '').trim()
          if (!label) return bad('要删哪条，给 label')
          const out = life.update((st) => {
            const arr = (st.self && st.self[field]) || []
            const next = arr.filter((x) => String(x.label || '') !== label)
            if (next.length === arr.length) return { notFound: true }
            st.self[field] = next
            st.self.version = Number(st.self.version || 0) + 1
            st.self.updatedAt = Date.now()
            return { self: st.self }
          })
          if (out.notFound) return bad('没找到这条')
          log.warn(`[debug] self.remove：${field}/${label}`)
          return done({ self: out.self })
        }
        if (action === 'reset') {
          const r = self ? self.reset() : life.resetSelf()
          log.warn('[debug] self.reset')
          return done({ self: r })
        }
        if (action === 'set') {
          const field = String(b.field || 'traits')
          const entries = Array.isArray(b.entries) ? b.entries.map((e) => ({ label: String(e.label || '').slice(0, 40), conf: num(e.conf, 0.6, 0, 1), src: String(e.src || 'manual'), ev: Array.isArray(e.ev) ? e.ev.slice(0, 12) : [] })) : []
          const r = life.setSelfField(field, entries)
          log.warn(`[debug] self.set：${field} ${entries.length} 条`)
          return done({ self: r })
        }
      }

      // ——— identity（模拟 Ta 改人格）———
      if (mod === 'identity') {
        if (action === 'set') {
          const id = life.setIdentity({ name: b.name, ownerName: b.ownerName, body: b.body })
          log.warn(`[debug] identity.set：${JSON.stringify(id)}`)
          return done({ identity: id })
        }
        if (action === 'reset') {
          const id = life.setIdentity({ name: '', ownerName: '', body: '' })
          log.warn('[debug] identity.reset（回出厂种子）')
          return done({ identity: id })
        }
      }

      // ——— alarm ———
      if (mod === 'alarm') {
        if (action === 'list') {
          // 调试台补列举（含已响过的，配合 cancel/clear 用）
          const s = life.load()
          return done({ alarms: (s.alarms || []).slice().sort((a, b) => a.at - b.at) })
        }
        if (action === 'cancel') {
          if (!b.id) return bad('取消哪个闹钟，给 id')
          const r = alarm.cancel(String(b.id))
          log.warn(`[debug] alarm.cancel：${b.id}`)
          return done({ ok: r })
        }
        if (action === 'set') {
          const at = Number(b.at) || Date.parse(String(b.at || '')) || (Date.now() + num(b.in_minutes, 5, 0, 100000) * 60000)
          const a = alarm.setAlarm(at, String(b.reason || 'debug 闹钟'), b.payload)
          log.warn(`[debug] alarm.set：${a?.id}`)
          return done({ alarm: a })
        }
        if (action === 'clear') {
          const n = alarm.list().length
          patchState((s) => { s.alarms = [] })
          log.warn(`[debug] alarm.clear：${n} 个`)
          return done({ cleared: n })
        }
      }

      // ——— chat ———
      if (mod === 'chat') {
        const chatId = String(b.chatId || OWNER_ID)
        if (action === 'prune') {
          const statsBefore = hub.historyStats ? hub.historyStats(chatId) : null
          try {
            for (const f of readdirSync(dataDir('chats', chatId))) {
              if (f.startsWith('seg-') || f.endsWith('.jsonl')) unlinkSync(join(dataDir('chats', chatId), f))
              // 上下文轮换留下的 archive-* 归档目录一并清掉（debug 语义 = 该聊天彻底归零）
              if (f.startsWith('archive-')) { try { rmSync(join(dataDir('chats', chatId), f), { recursive: true, force: true }) } catch {} }
            }
          } catch { /* 目录不存在 */ }
          try { await hub.resetChat(chatId) } catch {}
          log.warn(`[debug] chat.prune：${chatId}（${JSON.stringify(statsBefore)} → 空）`)
          return done({ chatId, before: statsBefore })
        }
        if (action === 'inject') {
          const msg = hub.appendMessage(chatId, {
            t: Number(b.t) || Date.now(),
            who: String(b.who || 'user') === 'bot' ? 'bot' : 'user',
            uid: String(b.who || 'user') === 'bot' ? undefined : (b.uid || OWNER_ID),
            text: String(b.text || 'debug 假消息'),
            kind: String(b.kind || 'text'),
          })
          log.warn(`[debug] chat.inject：${chatId} ${msg.who}「${String(msg.text).slice(0, 30)}」`)
          return done({ message: msg })
        }
      }

      return bad(`不认识这个组合：module=${mod || '?'} action=${action || '?'}`)
    } catch (error) {
      log.warn(`[debug] ${mod}/${action} 失败：${error.message}`)
      return bad(error.message)
    }
  })
}
