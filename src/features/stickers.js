import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir, readJson, writeJson, withFileLock } from '../core/store.js'
import { imageSize, mimeOf, stickerSizeOk, isAnimated } from '../core/image.js'
import { askModel } from '../core/llm.js'

const dir = () => dataDir('stickers')
const indexFile = () => join(dir(), 'index.json')
const ext = (mime) => ({ 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' })[mime] || 'jpg'

export const DEFAULT_TAGS = ['开心', '卖萌', '生气', '委屈', '无语', '嘲讽', '疑惑', '早晚安']

// 表情库上限内置（DESIGN-modular.md §3）。
const LIBRARY_MAX = 300

export function loadLibrary() {
  return readJson(indexFile(), () => ({ items: [] }))
}

function saveLibrary(lib) {
  writeJson(indexFile(), lib)
}

export function stickerPath(item) {
  return join(dir(), item.file)
}

export function matchSticker(items, query) {
  const q = String(query || '').trim()
  if (!q || !items.length) return null
  let best = null
  let bestScore = 0
  for (const it of items) {
    const hay = [it.name || '', ...(it.tags || [])]
    let s = 0
    for (const h of hay) {
      if (!h) continue
      if (h === q) s = Math.max(s, 10)
      else if (h.includes(q) || q.includes(h)) s = Math.max(s, 6)
      else {
        const common = [...q].filter((c) => h.includes(c)).length
        if (common >= 2) s = Math.max(s, common / Math.max(q.length, 1) * 4)
      }
    }
    if (s > bestScore || (s === bestScore && s > 0 && Math.random() < 0.5)) {
      best = it
      bestScore = s
    }
  }
  return bestScore >= 1.5 ? best : null
}

export function pickForReply(items, replyText) {
  if (!items.length) return null
  const words = DEFAULT_TAGS.concat(items.flatMap((i) => i.tags || []))
  for (const w of words) {
    if (w && String(replyText).includes(w)) {
      const m = matchSticker(items, w)
      if (m) return m
    }
  }
  return items[Math.floor(Math.random() * items.length)]
}

export function pickEvict(items) {
  const pool = items.filter((i) => i.from !== 'manual' && i.from !== 'panel')
  if (!pool.length) return null
  return pool.slice().sort((a, b) => (a.uses || 0) - (b.uses || 0) || (a.lastUsed || a.at || 0) - (b.lastUsed || b.at || 0))[0]
}

export function createStickerStore({ dsh, getConfig, log }) {
  async function caption(buf, mime, hint) {
    try {
      const text = await askModel(dsh, {
        cfg: getConfig(),
        system: '你给表情包起名字。只输出一行：不超过 12 个字的中文备注，描述这个表情表达的情绪或内容（例如「委屈巴巴的小猫」「得意地叉腰」）。然后空格，再写 1~3 个标签，从这些里挑：' + DEFAULT_TAGS.join('、') + '。格式：备注 #标签1 #标签2',
        text: hint ? `上传者给的描述是「${hint}」。请看图起名。` : '请看图起名。',
        images: [{ data: buf.toString('base64'), mediaType: mime }],

        maxTokens: 1000,
        temperature: 0.2,
      })
      if (!text) log.warn('看图起名：模型没给出文字')
      const line = text.split(/\r?\n/).map((s) => s.trim()).find(Boolean) || ''
      const tags = [...line.matchAll(/#\s*([^\s#]+)/g)].map((m) => m[1]).filter((t) => t.length <= 6).slice(0, 3)
      const name = line.replace(/#\s*[^\s#]+/g, '').replace(/[「」"'“”]/g, '').trim().slice(0, 12)
      return { name, tags }
    } catch (error) {
      log.warn('看图起名失败：', error.message)
      return { name: '', tags: [] }
    }
  }

  async function addFromBuffer(buf, { name = '', tags = [], from = 'manual', hint = '' } = {}) {
    const md5 = createHash('md5').update(buf).digest('hex')
    const lib = loadLibrary()
    const exist = lib.items.find((i) => i.md5 === md5)
    if (exist) return { ok: true, item: exist, existed: true }
    const mime = mimeOf(buf)
    if (!mime.startsWith('image/')) return { ok: false, reason: '不是图片' }
    const { width, height } = imageSize(buf)
    mkdirSync(dir(), { recursive: true })
    const file = `manual-${md5}.${ext(mime)}`
    writeFileSync(join(dir(), file), buf)
    const item = { md5, file, name: String(name).slice(0, 12), tags, from, at: Date.now(), width, height, bytes: buf.length }
    lib.items.push(item)
    saveLibrary(lib)
    log.info(`收了一张表情 ${md5.slice(0, 8)}（${width}x${height}）`)
    await trim()
    if (getConfig().stickers.caption && !item.name) {
      caption(buf, mime, hint).then(async ({ name, tags }) => {
        const l = loadLibrary()
        const it = l.items.find((i) => i.md5 === md5)
        if (!it) return
        if (!it.name) it.name = name || hint || '表情'
        it.tags = tags.length ? tags : it.tags
        saveLibrary(l)
        log.info(`表情 ${md5.slice(0, 8)} 起名「${it.name}」${it.tags.length ? ' #' + it.tags.join(' #') : ''}`)
      }).catch((error) => log.warn('表情起名收尾出错：', error.message))
    }
    return { ok: true, item }
  }

  async function trim() {
    const max = LIBRARY_MAX
    for (let guard = 0; guard < 20; guard++) {
      const items = loadLibrary().items
      if (items.length <= max) return
      const out = pickEvict(items)
      if (!out) return
      log.info(`表情库满了（上限 ${max}），清掉一张不常用的：${out.name || out.md5.slice(0, 8)}`)
      await remove(out.md5)
    }
  }

  function markUsed(md5) {
    // 多进程下 library 的读-改-写要进锁（审计：无锁 RMW）。
    withFileLock('sticker-lib', () => {
      const lib = loadLibrary()
      const it = lib.items.find((i) => i.md5 === md5)
      if (!it) return
      it.uses = (it.uses || 0) + 1
      it.lastUsed = Date.now()
      saveLibrary(lib)
    }, { staleMs: 5000, timeoutMs: 4000 })
  }

  async function remove(md5) {
    const lib = loadLibrary()
    const it = lib.items.find((i) => i.md5 === md5)
    if (!it) return { ok: false, reason: '没有这张' }
    try { unlinkSync(join(dir(), it.file)) } catch (error) {}
    lib.items = lib.items.filter((i) => i.md5 !== md5)
    saveLibrary(lib)
    return { ok: true }
  }

  function rename(md5, name, tags) {
    const lib = loadLibrary()
    const it = lib.items.find((i) => i.md5 === md5)
    if (!it) return { ok: false }
    if (name !== undefined) it.name = String(name).slice(0, 12)
    if (tags !== undefined) it.tags = tags
    saveLibrary(lib)
    return { ok: true, item: it }
  }

  function resolve(tagOrName) {
    const it = matchSticker(loadLibrary().items, tagOrName)
    if (!it) return null
    const p = stickerPath(it)
    if (!existsSync(p)) return null
    return { item: it, path: p }
  }

  return {
    addFromBuffer,
    remove,
    rename,
    markUsed,
    trim,
    resolve,
    library: loadLibrary,
    match: (q) => matchSticker(loadLibrary().items, q),
    pickForReply: (t) => pickForReply(loadLibrary().items, t),
  }
}
