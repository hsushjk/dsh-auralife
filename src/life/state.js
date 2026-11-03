// life/state.js — 一条命：state.json 的单例读写 + 张力/压力推导。
// Slice 0 只落地「状态容器 + 派生」，不接线：companion.js / selfdrive.js 仍读各自旧文件，
// 迁移与接入在 Slice 1（wishes+drive）之后进行。因此本模块绝不 touch mood.json / selfdrive.md。

import { dataDir, readJson, writeJson, withFileLock } from '../core/store.js'

export function stateFile() {
  return dataDir('state.json')
}

export function defaultState(now = Date.now()) {
  return {
    version: 1,
    life: { since: now, lastInteractionAt: 0, lastSeenAt: 0 },
    chemistry: { version: 1, at: now, dopamine: 50, cortisol: 20, serotonin: 50 },
    energy: { version: 1, at: now, level: 100 },
    wishes: [],
    self: { version: 0, updatedAt: 0, traits: [], values: [], boundaries: [] },
    // 她自己挑的模型偏好（null = 用主人配的）。她可以自己改，见 tools.js web_set_my_model。
    model: null,
    // 她自己设的闹钟（到点主动来找你）。见 tools.js web_set_alarm。
    alarms: [],
    // 人格（需求 5）：出厂种子只读，她自己 100% 接管可覆盖。空字段 = 用出厂种子。
    identity: { name: '', ownerName: '', body: '' },
    // 她自己的作息（睡眠静默期）：默认 02:00-07:00，Ta 可以根据作息自己改（tools.js web_set_rhythm）。
    rhythm: { quietFrom: '02:00', quietTo: '07:00' },
  }
}

// 宽松合并：旧/缺字段回退默认，不抛错，保证 schema 向前兼容。
export function normalizeState(raw, now = Date.now()) {
  const d = defaultState(now)
  const s = raw && typeof raw === 'object' ? raw : {}
  return {
    version: Number(s.version) || d.version,
    life: { ...d.life, ...(s.life && typeof s.life === 'object' ? s.life : {}) },
    chemistry: { ...d.chemistry, ...(s.chemistry && typeof s.chemistry === 'object' ? s.chemistry : {}) },
    energy: { ...d.energy, ...(s.energy && typeof s.energy === 'object' ? s.energy : {}) },
    wishes: Array.isArray(s.wishes) ? s.wishes : d.wishes,
    self: { ...d.self, ...(s.self && typeof s.self === 'object' ? s.self : {}) },
    model: (s.model && typeof s.model === 'object' && s.model.provider && s.model.model) ? { provider: String(s.model.provider), model: String(s.model.model), reasoningEffort: s.model.reasoningEffort || 'low', at: Number(s.model.at) || now, reason: String(s.model.reason || '') } : null,
    alarms: Array.isArray(s.alarms) ? s.alarms.filter((a) => a && typeof a === 'object' && Number.isFinite(a.at)) : [],
    identity: {
      name: s.identity && typeof s.identity.name === 'string' ? s.identity.name.slice(0, 20) : '',
      ownerName: s.identity && typeof s.identity.ownerName === 'string' ? s.identity.ownerName.slice(0,20) : '',
      body: s.identity && typeof s.identity.body === 'string' ? s.identity.body : '',
      updatedAt: Number(s.identity && s.identity.updatedAt) || 0,
    },
    rhythm: (() => {
      const ok = /^([01]\d|2[0-3]):[0-5]\d$/
      const r = s.rhythm && typeof s.rhythm === 'object' ? s.rhythm : {}
      const from = ok.test(String(r.quietFrom || '')) ? r.quietFrom : d.rhythm.quietFrom
      const to = ok.test(String(r.quietTo || '')) ? r.quietTo : d.rhythm.quietTo
      return { quietFrom: from, quietTo: to }
    })(),
  }
}

// 执念张力：digital-life-core 同款公式（base + 每小时·rate − relief，clamp 到 0~100）。
// 不是累加存储，而是按 createdAt 派生，天然防「越拖越涨」之外的漂移。
export function wishTension(w, now = Date.now()) {
  if (!w || w.status !== 'open') return 0
  const ageH = Math.max(0, (now - (w.createdAt || now)) / 3600_000)
  const base = Number.isFinite(w.baseTension) ? w.baseTension : 80
  const rate = Number.isFinite(w.tensionRate) ? w.tensionRate : 5
  const relief = Number.isFinite(w.relief) ? w.relief : 0
  return Math.max(0, Math.min(100, Math.round(base + ageH * rate - relief)))
}

export function createLife({ getConfig, log }) {
  const file = stateFile
  const load = () => normalizeState(readJson(file(), null))
  const save = (s) => writeJson(file(), s)

  // 跨进程「读-改-写」：DSH 每个进程都跑一份插件（多进程各自 tick），直接 load→改→save 会互相覆盖。
  // update() 在文件锁里重新读盘、应用改动、写回——所有改 state 的入口都走它（审计发现的最高风险点）。
  function update(fn) {
    return withFileLock('state', () => {
      const s = load()
      const out = fn(s)
      save(s)
      return out
    })
  }

  // 时间感：记录「上次互动 / 上次被看见」，供压力推导与孤独提示用。
  function touch(kind, now = Date.now()) {
    return update((s) => {
      if (kind === 'interaction') s.life.lastInteractionAt = now
      if (kind === 'seen') s.life.lastSeenAt = now
      return s
    })
  }

  // 压力 = 闲置时长(12/小时,约3.5h达到可开口线) + 最高 open 执念张力。
  // 心情已删情绪归三激素管，压力里不再有「心情偏离」成分。
  function pressureParts(now = Date.now()) {
    const s = load()
    const idleH = s.life.lastInteractionAt ? (now - s.life.lastInteractionAt) / 3600_000 : 0
    const top = s.wishes.reduce((m, w) => Math.max(m, wishTension(w, now)), 0)
    const idleP = Math.min(100, Math.round(idleH * 12))
    return { idleP, moodP: 0, tensionP: Math.round(top), total: Math.max(0, Math.min(100, idleP + top)) }
  }
  function pressure(now = Date.now()) {
    return pressureParts(now).total
  }

  // —— 执念池（wishes）——
  function addWish(text, opts = {}) {
    return update((s) => {
      const w = {
        id: `w${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
        text: String(text || '').slice(0, 2000),
        status: 'open',
        createdAt: Date.now(),
        lastUsedAt: 0,
        closedBy: '',
        baseTension: Number.isFinite(opts.baseTension) ? opts.baseTension : 80,
        tensionRate: Number.isFinite(opts.tensionRate) ? opts.tensionRate : 5,
        relief: Number.isFinite(opts.relief) ? opts.relief : 0,
      }
      s.wishes.push(w)
      return w
    })
  }

  function resolveWish(id, closedBy = '') {
    return update((s) => {
      const w = s.wishes.find((x) => x.id === id)
      if (!w) return null
      w.status = 'closed'
      w.closedBy = String(closedBy || '').slice(0, 200)
      return w
    })
  }

  // relief 是「已缓解量」，每次用该执念开口/推进时 +1，抵消张力增长。
  function bumpWish(id, by = 1) {
    return update((s) => {
      const w = s.wishes.find((x) => x.id === id)
      if (!w) return null
      w.relief = (w.relief || 0) + by
      w.lastUsedAt = Date.now()
      return w
    })
  }

  // ——自我（self）：她长出来的自我认知，可审计可回滚 ——
  function resetSelf() {
    return update((s) => {
      s.self = { version: (s.self.version || 0) + 1, updatedAt: Date.now(), traits: [], values: [], boundaries: [] }
      return s.self
    })
  }

  function setSelfField(field, entries) {
    return update((s) => {
      if (!['traits', 'values', 'boundaries'].includes(field)) throw new Error(`unknown self field: ${field}`)
      s.self[field] = Array.isArray(entries) ? entries : s.self[field]
      s.self.updatedAt = Date.now()
      s.self.version = (s.self.version || 0) + 1
      return s.self
    })
  }

  // ——人格（identity）：AI 100% 接管，想怎么覆盖就怎么覆盖 ——
  function setIdentity(patch) {
    return update((s) => {
      const id = s.identity || { name: '', ownerName: '', body: '', updatedAt: 0 }
      if (typeof patch.name === 'string') id.name = patch.name.slice(0, 20)
      if (typeof patch.ownerName === 'string') id.ownerName = patch.ownerName.slice(0, 20)
      if (typeof patch.body === 'string') id.body = patch.body
      id.updatedAt = Date.now() // Ta 上次改人格的时间（面板要显示）
      s.identity = id
      return id
    })
  }

  // 她自己的作息（睡眠静默期）：她聊到自己几点睡几点起时，可以自己改。
  function setRhythm(patch) {
    return update((s) => {
      const ok = /^([01]\d|2[0-3]):[0-5]\d$/
      if (patch && typeof patch === 'object') {
        if (ok.test(String(patch.quietFrom || ''))) s.rhythm.quietFrom = patch.quietFrom
        if (ok.test(String(patch.quietTo || ''))) s.rhythm.quietTo = patch.quietTo
      }
      return s.rhythm
    })
  }

  return { load, save, touch, pressure, pressureParts, addWish, resolveWish, bumpWish, resetSelf, setSelfField, setIdentity, setRhythm, update }
}
