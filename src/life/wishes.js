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
    life.update((s) => {
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
    })
  }

  function list() {
    return life.load().wishes
  }

  function top(now = Date.now()) {
    const ws = list()
    let best = null
    let bestT = -1
    for (const w of ws) {
      const t = wishTension(w, now)
      if (t > bestT) { bestT = t; best = w }
    }
    return best ? { ...best, tension: bestT } : null
  }

  function add(text, opts = {}) {
    return life.addWish(text, { baseTension: 30, tensionRate: 4, ...opts })
  }

  function resolve(id, closedBy = '') {
    return life.resolveWish(id, closedBy)
  }

  function bump(id, by = 1) {
    return life.bumpWish(id, by)
  }

  return { migrateFromMemo, list, top, add, resolve, bump, memoFile }
}
