// 聊天记录分片存储：
//   聊天记录（纯文字/表情引用）按 100 条一片落在 chats/<chatId>/ 下，
//   图片和语音的二进制单独落在 media/<chatId>/，消息里只留 mediaId。
// 写入永远只碰「当前片」：当前片写满 100 条就滚动到新的一片再写，
// 所以任何一次 append 的读/写都是常数级（≤100 条），不会随聊天变长而变慢。
// 空闲 2 分钟的 finalize() 只负责兜底（清过期片、清孤儿媒体、整理历史遗留的超长片）。
// 「查看更早的记录」每次只取上一片，翻页边界和文件边界完全一致。
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir, readJson, writeJson, withFileLock } from '../core/store.js'
import { mimeOf } from '../core/image.js'

export const SEGMENT_LIMIT = 100
export const IDLE_MS = 2 * 60 * 1000
// 聊天记录保留天数内置（DESIGN-modular.md §3）：记忆编码要读原文，30 天更稳妥。
export const DEFAULT_KEEP_DAYS = 30
// 孤儿媒体（没有任何消息引用）至少放这么久再删，避免和"写文件→写消息"之间的窗口打架
export const ORPHAN_GRACE_MS = 60 * 60 * 1000

const EXT_BY_MIME = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp',
  'image/gif': 'gif', 'image/bmp': 'bmp', 'image/svg+xml': 'svg',
  'audio/wav': 'wav', 'audio/wave': 'wav', 'audio/x-wav': 'wav',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/webm': 'webm', 'audio/ogg': 'ogg',
  'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/flac': 'flac',
  // 任意后缀文件上传常见文本/文档类型按内容给扩展名，方便下载后直接打开
  'text/plain': 'txt', 'text/markdown': 'md', 'text/html': 'html', 'text/css': 'css',
  'text/csv': 'csv', 'text/xml': 'xml', 'application/json': 'json', 'application/xml': 'xml',
  'application/javascript': 'js', 'application/pdf': 'pdf', 'application/zip': 'zip',
  'application/x-zip-compressed': 'zip', 'application/gzip': 'gz', 'application/x-7z-compressed': '7z',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/msword': 'doc', 'application/vnd.ms-excel': 'xls',
}

const MIME_BY_EXT = {}
for (const [mime, ext] of Object.entries(EXT_BY_MIME)) if (!MIME_BY_EXT[ext]) MIME_BY_EXT[ext] = mime
MIME_BY_EXT.bin = 'application/octet-stream'

function extOfMime(mime) {
  const key = String(mime || '').split(';')[0].trim().toLowerCase()
  return EXT_BY_MIME[key] || 'bin'
}

export function mimeOfExt(ext) {
  return MIME_BY_EXT[String(ext || '').toLowerCase()] || 'application/octet-stream'
}

const safeName = (s) => String(s || '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'x'

// 媒体文件路径：media/<chatId>/<mediaId>，纯函数，路由也能直接用
export function mediaPath(chatId, mediaId) {
  const id = safeName(mediaId)
  if (!id || id.includes('..')) return ''
  return join(dataDir('media'), safeName(chatId), id)
}

export function createHistory({ log = console, emit = () => {}, getKeepDays = () => DEFAULT_KEEP_DAYS } = {}) {
  const chatsRoot = () => dataDir('chats')
  const chatDir = (chatId) => join(chatsRoot(), safeName(chatId))
  const mediaRoot = () => dataDir('media')
  const mediaDir = (chatId) => join(mediaRoot(), safeName(chatId))
  const indexFile = (chatId) => join(chatDir(chatId), 'index.json')
  const segFile = (chatId, id) => join(chatDir(chatId), safeName(id) + '.json')
  const timers = new Map()

  function keepDays() {
    const n = Number(getKeepDays())
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_KEEP_DAYS
  }

  function emptyIndex(chatId) {
    return { chatId, segments: [], updatedAt: 0 }
  }

  function readIndex(chatId) {
    const idx = readJson(indexFile(chatId), null)
    if (idx && Array.isArray(idx.segments)) return ensureSeq(chatId, idx)
    return ensureSeq(chatId, rebuildIndex(chatId))
  }

  // 分片文件名带上序号（seg-001-…、seg-002-…），目录按文件名排序就是时间顺序，
  // 不用打开 index.json 也知道哪片最新。老数据在这里一次性改名。
  function ensureSeq(chatId, idx) {
    let dirty = false
    idx.segments.forEach((seg, i) => {
      if (/^seg-\d{3,}-/.test(seg.id)) return
      const n = String(i + 1).padStart(3, '0')
      const next = 'seg-' + n + '-' + String(seg.id).replace(/^seg-/, '')
      if (next === seg.id) return
      try {
        if (existsSync(segFile(chatId, next))) return
        renameSync(segFile(chatId, seg.id), segFile(chatId, next))
      } catch { return }
      seg.id = next
      dirty = true
    })
    if (dirty) writeIndex(chatId, idx)
    return idx
  }

  // index.json 丢了就扫目录重建（顺手修掉被手动删过片的索引）
  function rebuildIndex(chatId) {
    const idx = emptyIndex(chatId)
    let files = []
    try {
      files = readdirSync(chatDir(chatId)).filter((f) => f.endsWith('.json') && f !== 'index.json')
    } catch { return idx }
    const segs = []
    for (const f of files) {
      const data = readJson(join(chatDir(chatId), f), null)
      if (!data || !Array.isArray(data.messages) || !data.messages.length) continue
      segs.push({
        id: String(data.id || f.replace(/\.json$/, '')),
        from: Number(data.from || data.messages[0].t || 0),
        to: Number(data.to || data.messages[data.messages.length - 1].t || 0),
        count: data.messages.length,
      })
    }
    segs.sort((a, b) => a.from - b.from)
    idx.segments = segs
    idx.updatedAt = Date.now()
    if (segs.length) writeJson(indexFile(chatId), idx)
    return idx
  }

  function writeIndex(chatId, idx) {
    idx.chatId = chatId
    idx.updatedAt = Date.now()
    writeJson(indexFile(chatId), idx)
  }

  function newSegmentId(seq) {
    const n = String(Number(seq) || 1).padStart(3, '0')
    return 'seg-' + n + '-' + Date.now().toString(36) + '-' + randomUUID().slice(0, 6)
  }

  function saveMedia(chatId, base64, mimeHint) {
    let buf
    try { buf = Buffer.from(String(base64 || ''), 'base64') } catch { return null }
    if (!buf || !buf.length) return null
    const mime = String(mimeHint || mimeOf(buf) || 'application/octet-stream').split(';')[0].trim().toLowerCase()
    const mediaId = randomUUID() + '.' + extOfMime(mime)
    const dir = mediaDir(chatId)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, mediaId), buf)
    return { mediaId, mediaMime: mime, bytes: buf.length }
  }

  function mediaFile(chatId, mediaId) {
    return mediaPath(chatId, mediaId)
  }

  function dropMedia(chatId, mediaId) {
    const p = mediaFile(chatId, mediaId)
    if (!p) return
    try { unlinkSync(p) } catch {}
  }

  // 把 base64 媒体落到 media/ 目录，消息里只留 mediaId
  function extractMedia(chatId, msg) {
    if (msg.image) {
      const saved = saveMedia(chatId, msg.image, msg.imageMime)
      delete msg.image
      msg.imageMime = ''
      if (saved) Object.assign(msg, saved)
      else msg.mediaExpired = true
    }
    if (msg.voice) {
      const saved = saveMedia(chatId, msg.voice, msg.voiceMime)
      delete msg.voice
      msg.voiceMime = ''
      if (saved) Object.assign(msg, saved)
      else msg.mediaExpired = true
    }
    return msg
  }

  function append(chatId, payload) {
    // 多进程下 DSH 每个进程都跑一份插件，append/patchLast 的读-改-写必须进锁，否则并发丢消息。
    return withFileLock(`hist-${chatId}`, () => {
      const msg = extractMedia(chatId, { id: randomUUID(), t: Date.now(), ...payload })
      const idx = readIndex(chatId)
      let seg = idx.segments[idx.segments.length - 1]
      // 当前片写满就滚动：单文件永远 ≤ SEGMENT_LIMIT 条，append 的代价是常数级。
      // 前端不受影响——老消息还在磁盘上，滚到顶时按 pageFile(prev) 取得到；
      // 正在看的人靠 SSE 追加，列表不会因为滚动切片而少一条。
      if (!seg || (seg.count || 0) >= SEGMENT_LIMIT) {
        seg = { id: newSegmentId(idx.segments.length + 1), from: msg.t, to: msg.t, count: 0 }
        idx.segments.push(seg)
        writeIndex(chatId, idx)
      }
      const file = segFile(chatId, seg.id)
      const data = readJson(file, null) || { chatId, id: seg.id, from: msg.t, to: msg.t, messages: [] }
      data.messages.push(msg)
      data.from = data.messages[0].t
      data.to = msg.t
      writeJson(file, data)
      seg.from = data.from
      seg.to = data.to
      seg.count = data.messages.length
      writeIndex(chatId, idx)
      return msg
    }, { staleMs: 10000, timeoutMs: 5000 })
  }

  function readSeg(chatId, id) {
    const data = readJson(segFile(chatId, id), null)
    if (!data || !Array.isArray(data.messages)) return null
    return data
  }

  function patchLast(chatId, patch) {
    return withFileLock(`hist-${chatId}`, () => {
      const idx = readIndex(chatId)
      const seg = idx.segments[idx.segments.length - 1]
      if (!seg) return null
      const data = readSeg(chatId, seg.id)
      if (!data || !data.messages.length) return null
      const last = data.messages[data.messages.length - 1]
      Object.assign(last, patch)
      writeJson(segFile(chatId, seg.id), data)
      return last
    }, { staleMs: 10000, timeoutMs: 5000 })
  }

  function page(chatId, { before = 0, limit = SEGMENT_LIMIT } = {}) {
    const take = Math.max(1, Math.min(Number(limit) || SEGMENT_LIMIT, 500))
    const idx = readIndex(chatId)
    const segs = idx.segments
    const out = []
    for (let s = segs.length - 1; s >= 0; s--) {
      const seg = segs[s]
      if (!seg.count) continue
      const data = readSeg(chatId, seg.id)
      if (!data) continue
      const msgs = data.messages
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i]
        // 用 t 当游标时同一毫秒的多条消息会卡在边界上，所以边界这一条重复返回一次，由客户端按 id 去重
        if (before && m.t > before) continue
        out.unshift(m)
        if (out.length >= take) {
          const moreInSeg = i > 0
          const moreEarlier = moreInSeg || s > 0 ? hasAny(chatId, segs, s, moreInSeg, m.t) : false
          return { messages: out, oldestAt: out[0].t, hasMore: moreEarlier }
        }
      }
    }
    return { messages: out, oldestAt: out[0]?.t || 0, hasMore: false }
  }

  // 按「一个分片文件 = 一页」取：before=0 取最新那片，否则取 to < before 的最后一片。
  // 网页端用它做「查看更早的记录」，这样文件边界和界面边界是一致的。
  function pageFile(chatId, { before = 0 } = {}) {
    const idx = readIndex(chatId)
    const segs = idx.segments.filter((s) => s.count > 0)
    if (!segs.length) return { messages: [], oldestAt: 0, hasMore: false, index: -1, total: 0 }
    let pos = segs.length - 1
    if (before) {
      pos = -1
      for (let i = segs.length - 1; i >= 0; i--) {
        if (Number(segs[i].to) < Number(before)) { pos = i; break }
      }
      if (pos < 0) return { messages: [], oldestAt: 0, hasMore: false, index: -1, total: segs.length }
    }
    const seg = segs[pos]
    const data = readSeg(chatId, seg.id)
    const messages = data?.messages || []
    return {
      messages,
      oldestAt: messages[0]?.t || 0,
      hasMore: pos > 0,
      index: pos,
      total: segs.length,
      id: seg.id,
    }
  }

  // 判断是否还有比 t 更早的消息：同片前面还有，或在更旧的片里
  function hasAny(chatId, segs, s, moreInSeg, t) {
    if (moreInSeg) return true
    for (let i = s - 1; i >= 0; i--) {
      if (!segs[i].count) continue
      const data = readSeg(chatId, segs[i].id)
      if (data && data.messages.some((m) => m.t < t)) return true
    }
    return false
  }

  function recent(chatId, n = 20) {
    return page(chatId, { limit: Math.max(1, n) }).messages
  }

  function last(chatId) {
    const idx = readIndex(chatId)
    const seg = idx.segments[idx.segments.length - 1]
    if (!seg) return null
    const data = readSeg(chatId, seg.id)
    return data && data.messages.length ? data.messages[data.messages.length - 1] : null
  }

  function oldestAt(chatId) {
    const idx = readIndex(chatId)
    const seg = idx.segments[0]
    if (!seg) return 0
    const data = readSeg(chatId, seg.id)
    return data && data.messages.length ? data.messages[0].t : 0
  }

  function totalOf(chatId) {
    const idx = readIndex(chatId)
    return idx.segments.reduce((n, s) => n + (s.count || 0), 0)
  }

  // 孤儿媒体清理：media 目录里没有任何消息引用的文件，落盘超过 grace 就删掉。
  // 「写文件成功、写消息失败」或者手动删过分片都会留下这种文件；
  // grace 是为了不误删刚写进去、消息还没落盘的那一张。
  function reapOrphanMedia(chatId, graceMs = ORPHAN_GRACE_MS) {
    let files = []
    try { files = readdirSync(mediaDir(chatId)) } catch { return 0 }
    if (!files.length) return 0
    const used = new Set()
    const idx = readIndex(chatId)
    for (const seg of idx.segments) {
      if (!seg.count) continue
      const data = readSeg(chatId, seg.id)
      for (const m of data?.messages || []) if (m.mediaId) used.add(safeName(m.mediaId))
    }
    const now = Date.now()
    let removed = 0
    for (const f of files) {
      if (used.has(f)) continue
      const p = join(mediaDir(chatId), f)
      try {
        if (now - statSync(p).mtimeMs < graceMs) continue
        unlinkSync(p)
        removed += 1
      } catch {}
    }
    if (removed) log.info?.(`孤儿媒体清理：${chatId} 删了 ${removed} 个没人引用的文件`)
    return removed
  }

  // 过期清理：整片比 keepDays 还旧就删掉（连带这片的媒体文件），
  // 再顺手扫一遍 media 目录里过期/没人要的文件。
  function sweep(chatId) {
    const days = keepDays()
    const cutoff = Date.now() - days * 86400_000
    const idx = readIndex(chatId)
    const keep = []
    let dropped = 0
    let trimmed = false
    for (const seg of idx.segments) {
      if (!(seg.count > 0)) continue
      // 整片都过期：连片带媒体一起删
      if (Number(seg.to) <= cutoff) {
        const data = readSeg(chatId, seg.id)
        for (const m of data?.messages || []) {
          if (m.mediaId) dropMedia(chatId, m.mediaId)
          dropped += 1
        }
        try { unlinkSync(segFile(chatId, seg.id)) } catch {}
        continue
      }
      // 片跨过期线：把片里过期的消息掐掉，剩下的重写（这样"保留天数"是准的，不多留）
      if (Number(seg.from) <= cutoff) {
        const data = readSeg(chatId, seg.id)
        const rest = (data?.messages || []).filter((m) => {
          if (Number(m.t) > cutoff) return true
          if (m.mediaId) dropMedia(chatId, m.mediaId)
          dropped += 1
          return false
        })
        if (!rest.length) { try { unlinkSync(segFile(chatId, seg.id)) } catch {}; continue }
        seg.from = rest[0].t
        seg.to = rest[rest.length - 1].t
        seg.count = rest.length
        writeJson(segFile(chatId, seg.id), { chatId, id: seg.id, from: seg.from, to: seg.to, messages: rest })
        trimmed = true
        keep.push(seg)
        continue
      }
      keep.push(seg)
    }
    if (keep.length !== idx.segments.length || trimmed) {
      idx.segments = keep
      writeIndex(chatId, idx)
    }
    // media 目录里比保留期更旧的文件一律清掉（消息片删掉后的孤儿也在这里）
    try {
      const dir = mediaDir(chatId)
      for (const f of readdirSync(dir)) {
        const p = join(dir, f)
        try { if (statSync(p).mtimeMs < cutoff) unlinkSync(p) } catch {}
      }
    } catch {}
    // 还没到保留期、但已经没人引用的文件（写文件成功但消息没落盘的孤儿）
    const orphans = reapOrphanMedia(chatId)
    return { changed: dropped > 0, dropped, orphans, oldestAt: oldestAt(chatId), hasMore: totalOf(chatId) > 0 }
  }

  function sweepAll() {
    let names = []
    try { names = readdirSync(chatsRoot(), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) } catch {}
    const out = []
    for (const name of names) {
      const r = sweep(name)
      if (r.changed) out.push({ chatId: name, ...r })
    }
    // media 下还有聊天目录已经不在的，直接清掉
    try {
      for (const d of readdirSync(mediaRoot(), { withFileTypes: true })) {
        if (!d.isDirectory()) continue
        if (!existsSync(chatDir(d.name))) {
          try { for (const f of readdirSync(join(mediaRoot(), d.name))) unlinkSync(join(mediaRoot(), d.name, f)) } catch {}
        }
      }
    } catch {}
    return out
  }

  // 把「当前片」里超过 100 条的部分切成每片 100，最后一片留下当新的当前片。
  // 只在空闲时做：聊天途中完全不切，所以不会出现「聊到 101 条前面的忽然藏起来」。
  function splitCurrent(chatId) {
    const idx = readIndex(chatId)
    const last = idx.segments[idx.segments.length - 1]
    if (!last || (last.count || 0) <= SEGMENT_LIMIT) return null
    const data = readSeg(chatId, last.id)
    const msgs = data?.messages || []
    if (msgs.length <= SEGMENT_LIMIT) return null
    idx.segments.pop()
    const made = []
    let seq = idx.segments.length + 1
    for (let i = 0; i < msgs.length; i += SEGMENT_LIMIT) {
      const chunk = msgs.slice(i, i + SEGMENT_LIMIT)
      const seg = { id: newSegmentId(seq++), from: chunk[0].t, to: chunk[chunk.length - 1].t, count: chunk.length }
      writeJson(segFile(chatId, seg.id), { chatId, id: seg.id, from: seg.from, to: seg.to, messages: chunk })
      idx.segments.push(seg)
      made.push(seg)
    }
    writeIndex(chatId, idx)
    try { unlinkSync(segFile(chatId, last.id)) } catch {}
    log.info?.(`空闲裁切：${chatId} 把 ${msgs.length} 条切成 ${made.map((s) => s.count).join('+')}`)
    return made
  }

  // 空闲处理：先裁切，再清过期片，有删除就通知客户端新的边界
  function finalize(chatId) {
    timers.delete(chatId)
    let split = null
    try { split = splitCurrent(chatId) } catch (e) { log.warn?.('空闲裁切出错：' + e.message) }
    const r = sweep(chatId)
    if (r.changed) {
      log.info?.(`聊天记录过期清理：${chatId} 删了 ${r.dropped} 条`)
      emit('history', {
        chatId,
        oldestAt: r.oldestAt,
        droppedBefore: r.oldestAt,
        hasMore: totalOf(chatId) > SEGMENT_LIMIT,
      })
    }
    return { ...r, split: split ? split.map((s) => s.count) : null }
  }

  function touch(chatId) {
    const t = timers.get(chatId)
    if (t) clearTimeout(t)
    const timer = setTimeout(() => {
      try { finalize(chatId) } catch (e) { log.warn?.('空闲裁切出错：' + e.message) }
    }, IDLE_MS)
    if (typeof timer.unref === 'function') timer.unref()
    timers.set(chatId, timer)
  }

  function closeAll() {
    for (const t of timers.values()) clearTimeout(t)
    timers.clear()
  }

  // 老版本所有消息塞在 messages.json 里：不做迁移，直接忽略那个文件
  function stats(chatId) {
    const idx = readIndex(chatId)
    let bytes = 0
    let mediaBytes = 0
    for (const seg of idx.segments) {
      try { bytes += statSync(segFile(chatId, seg.id)).size } catch {}
    }
    try {
      for (const f of readdirSync(mediaDir(chatId))) {
        try { mediaBytes += statSync(join(mediaDir(chatId), f)).size } catch {}
      }
    } catch {}
    return { segments: idx.segments.length, messages: totalOf(chatId), textBytes: bytes, mediaBytes }
  }

  // 上下文轮换用把该 chat 的全部 seg 原文挪进 archive-<时间戳>/ 子目录，
  // 再重置 index.json —— 之后 stats() 只数新会话的消息，老对话作为本地归档保留。
  // rebuildIndex 只扫 chatDir 一层（不过滤子目录，目录本身不会被 .json 过滤命中），归档不会被误收。
  function archiveChat(chatId) {
    const idx = readIndex(chatId)
    if (!idx.segments.length) return 0
    const stamp = Date.now()
    const dest = join(chatDir(chatId), 'archive-' + stamp)
    try { mkdirSync(dest, { recursive: true }) } catch { return 0 }
    let moved = 0
    for (const seg of idx.segments) {
      try { renameSync(segFile(chatId, seg.id), join(dest, safeName(seg.id) + '.json')); moved++ } catch {}
    }
    try { renameSync(indexFile(chatId), join(dest, 'index.json')) } catch {}
    try { writeJson(indexFile(chatId), emptyIndex(chatId)) } catch {}
    return moved
  }

  return {
    append, patchLast, page, pageFile, recent, last, oldestAt, totalOf,
    sweep, sweepAll, touch, finalize, splitCurrent, closeAll, stats, reapOrphanMedia,
    saveMedia, mediaPath: mediaFile, mediaDir, chatDir, archiveChat,
  }
}
