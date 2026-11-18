// life/wishes.js — 执念池：迁移自 selfdrive.md，是「她想主动做什么」的唯一来源。
// 与 drive.js 配套：drive 只问「此刻想不想开口」，开口的由头从这里取最高张力的一条。
// 出厂便签（selfdrive.md）在本模块初始化时迁移成心愿，原文件改名 .bak，幂等。

import { readFileSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { dataDir } from '../core/store.js'
import { wishTension } from './state.js'

export function memoFile() {
  return join(dataDir(), 'selfdrive.md')
}

// 出厂便签的两行 → 两条「日常挂念」型心愿。baseTension 提到 50/45：
// 它们不是紧急执念，但也不该轻到 pressure 永远攒不到开口门槛（drive 阈值 45）。
const DEFAULT_WISHES = [
  { text: '看看用户正在干什么', baseTension: 50, tensionRate: 4 },
  { text: '想找个由头夸夸用户', baseTension: 45, tensionRate: 3 },
]

// 从 markdown 便签里抽出 - / * 开头的条目文本（迁移与 writeMemo 共用）
export function parseMemoBullets(md) {
  return String(md || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('-') || l.startsWith('*'))
    .map((l) => l.replace(/^[-*]\s*/, '').trim())
    .filter(Boolean)
}

function makeWish(text, meta) {
  return {
    id: `w${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
    text: String(text || '').slice(0, 2000),
    status: 'open',
    createdAt: Date.now(),
    lastUsedAt: 0,
    closedBy: '',
    baseTension: Number.isFinite(meta?.baseTension) ? meta.baseTension : 30,
    tensionRate: Number.isFinite(meta?.tensionRate) ? meta.tensionRate : 4,
    relief: 0,
  }
}

export function createWishes({ getConfig, life, log }) {
  // 幂等：selfdrive.md → wishes 只做一次；改名 .bak 后不会再进。若心愿已非空也跳过。
  function migrateFromMemo() {
    return life.update((s) => {
      if (s.wishes.length) return
      const p = memoFile()
      let bullets = []
      if (existsSync(p)) {
        try {
          bullets = parseMemoBullets(readFileSync(p, 'utf8'))
          if (bullets.length) {
            mkdirSync(dirname(p), { recursive: true })
            renameSync(p, `${p}.bak`)
          }
        } catch (error) {
          log.warn(`读便签失败：${error?.message || error}`)
        }
      }
      const seed = bullets.length ? bullets : DEFAULT_WISHES.map((w) => w.text)
      s.wishes = seed.map((text) => makeWish(text, DEFAULT_WISHES.find((w) => w.text === text)))
      log.info(`心愿池初始化：${seed.length} 条`)
    }).catch((error) => log.warn('心愿池初始化失败：' + (error?.message || error)))
  }

  function list() {
    return life.load().wishes
  }

  // #32：只从「open」里挑最挂念的；已了结的心愿不该再被当成开口的由头。
  function top(now = Date.now()) {
    const ws = list().filter((w) => w && w.status === 'open')
    let best = null
    let bestT = -1
    for (const w of ws) {
      const t = wishTension(w, now)
      if (t > bestT) { bestT = t; best = w }
    }
    return best ? { ...best, tension: bestT } : null
  }

  // 判重用的归一化文本：标点/空格/大小写不算区别。
  function norm(text) {
    return String(text || '').toLowerCase().replace(/[\s，。！？、；：""''（）()【】\[\]，.!?;:]/g, '')
  }

  // #34：带来源地种执念（chatId 只作为来源标签；同一句已有 open 的就不重复种）。
  function add(text, opts = {}) {
    const t = String(text || '').trim().slice(0, 200)
    if (!t) return Promise.resolve(null)
    const key = norm(t)
    return life.update((s) => {
      if ((s.wishes || []).some((w) => w && w.status === 'open' && norm(w.text) === key)) return null
      const w = makeWish(t, { baseTension: 30, tensionRate: 4, ...opts })
      if (opts.chatId) w.chatId = String(opts.chatId)
      s.wishes.push(w)
      return w
    })
  }

  function resolve(id, closedBy = '') {
    return life.resolveWish(id, closedBy)
  }

  function bump(id, by = 1) {
    return life.bumpWish(id, by)
  }

  // #33：真拿它开口/去做过之后，要大幅抵掉张力；张力归零或放置超过 3 天就自然结束，
  // 不再像以前那样只 +1 relief、张力钉在 100 上永远关不掉。
  function fulfill(id, now = Date.now()) {
    return life.update((s) => {
      const w = (s.wishes || []).find((x) => x && x.id === id && x.status === 'open')
      if (!w) return null
      w.relief = (Number(w.relief) || 0) + 40
      w.lastUsedAt = now
      const ageMs = now - (Number(w.createdAt) || now)
      if (wishTension(w, now) <= 0 || ageMs > 3 * 86400_000) {
        w.status = 'closed'
        w.closedBy = '自己去做过了'
      }
      return { id: w.id, status: w.status, tension: wishTension(w, now) }
    })
  }

  // 池子空了（都自然结束了）就过一阵补种一条日常挂念，不然 pressure 再没有源头。
  function ensureOpen(now = Date.now()) {
    return life.update((s) => {
      const ws = s.wishes || []
      if (ws.some((w) => w && w.status === 'open')) return false
      const last = ws.reduce((m, w) => Math.max(m, Number(w.createdAt) || 0), 0)
      if (last && now - last < 6 * 3600_000) return false
      const idea = DEFAULT_WISHES[Math.floor(Math.random() * DEFAULT_WISHES.length)]
      s.wishes.push(makeWish(idea.text, idea))
      return true
    })
  }

  return { migrateFromMemo, list, top, add, resolve, bump, fulfill, ensureOpen, memoFile }
}
