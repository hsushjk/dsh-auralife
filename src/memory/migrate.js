// memory/migrate.js — memories.json → mem/ 的一次性迁移（幂等，可重复跑）。
//
// 策略：
//   - items（旧事实表）→ mem/facts/（版本链 + 来源监控），保留旧 id，
//     已迁过（id 已在 store）的就跳过，所以重复跑只补增量、不重复。
//   - profiles / insights / styles → mem/archive.json（硬档：人物小档案 + 相处经验 + 说话方式）。
//   - 不删 memories.json（旧 memory.js 还在跑，Slice 3/4 切完后才退休改名 .bak）。
import { dataDir, readJson, writeJson, withFileLock } from '../core/store.js'
import { isHardFact } from './similar.js'

const SRC_MAP = {
  tool: 'manual', panel: 'manual', manual: 'manual', import: 'manual',
  auto: 'inferred', event: 'self_did', diary: 'self_did',
}

export function migrateLegacy({ store, log = console } = {}) {
  // 多进程下每个进程启动都会跑迁移，进锁防重复写（幂等本可兜底，锁让首次迁移不并发）。
  return withFileLock('mem-migrate', () => {
  const legacy = readJson(dataDir('memories.json'), null)
  if (!legacy || !Array.isArray(legacy.items)) return { migrated: 0, archive: [] }

  const existing = new Set(store.facts().map((f) => f.id))
  let migrated = 0
  for (const it of legacy.items || []) {
    if (existing.has(it.id)) continue
    const src = SRC_MAP[it.source] || 'inferred'
    const conf = Math.max(0, Math.min(1, Number(it.importance) ?? 0.5))
    const text = String(it.text || '').trim()
    if (!text) continue
    store.addFact({
      id: it.id,
      t0: it.at || Date.now(), // 旧 at 可能已被 dup.at 刷过，无法还原，照迁
      text,
      subj: String(it.about || ''),
      aboutName: String(it.aboutName || ''),
      src,
      conf,
      chatId: String(it.chatId || ''),
      hits: it.hits, hitDays: it.hitDays, lastHit: it.lastHit,
      archived: isHardFact({ text, src, conf }),
    })
    migrated++
  }

  const archive = readJson(dataDir('mem', 'archive.json'), () => ({}))
  for (const key of ['profiles', 'insights', 'styles', 'insightNames']) {
    if (legacy[key] != null) archive[key] = { ...(archive[key] || {}), ...legacy[key] }
  }
  writeJson(dataDir('mem', 'archive.json'), archive)

  if (migrated) log.info(`迁移旧记忆：${migrated} 条事实 → mem/facts，硬档并入 mem/archive.json`)
  return { migrated, archive: Object.keys(archive) }
  }, { staleMs: 30000, timeoutMs: 20000 })
}
