import { readFileSync, writeFileSync, existsSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from '../../core/store.js'
import { stickerPath } from '../../features/stickers.js'
import { mediaPath as mediaFileOf, mimeOfExt } from '../../chat/history.js'

export function register(router, ctx) {
  const { json, send, readBody, stripDataUrl, requireUser, requireOwner, getConfig, setConfig, MIME, ROOT, tokenOf, sessionUser } = ctx
  const { stickers } = ctx.deps

  // <img>/<audio> 没法带 Authorization 头，所以媒体接口允许 ?token= 兜底（和 SSE 一样）。
  // 注意：DSH 自己会在 127.0.0.1 上种 oc_s cookie，那个 token 不是本插件的会话，
  // 所以这里要把「URL 里的 token」和「header/cookie 里的 token」都试一遍，谁先认出来用谁。
  function meOf(req, url) {
    const fromUrl = url && url.searchParams.get('token')
    const fromReq = tokenOf(req)
    for (const t of [fromUrl, fromReq]) {
      if (!t) continue
      const me = sessionUser(t)
      if (me) return me
    }
    return null
  }

  // 聊天里的图片/语音：按 mediaId 取文件，只有本人能取自己会话的媒体。
  // 带强缓存，客户端/浏览器存过就不会再回来问。
  router.prefix('GET', 'api/media/', async (req, res, url, p) => {
    const me = meOf(req, url)
    if (!me) return send(res, 401, { ok: false, reason: '没登录' })
    const id = decodeURIComponent(p.slice('api/media/'.length)).split('/')[0]
    if (!id) return send(res, 404, { ok: false, reason: '没有这个媒体' })
    const file = mediaFileOf(ctx.chatIdOf(me.subject), id)
    if (!file || !existsSync(file)) return send(res, 404, { ok: false, reason: '这个媒体已经过期了' })
    const etag = '"' + id + '"'
    if (String(req.headers['if-none-match'] || '') === etag) { res.writeHead(304, { etag }); return res.end() }
    const st = statSync(file)
    const ext = (id.match(/\.([a-z0-9]+)$/i) || [])[1] || ''
    res.writeHead(200, {
      'content-type': mimeOfExt(ext),
      'content-length': st.size,
      'cache-control': 'private, max-age=31536000, immutable',
      etag,
    })
    res.end(readFileSync(file))
  })

  router.prefix('GET', 'api/sticker/', async (req, res, url, p) => {
    const md5 = decodeURIComponent(p.slice('api/sticker/'.length)).split('/')[0]
    const item = stickers.library().items.find((i) => i.md5 === md5)
    if (!item) return json(res, { ok: false, reason: '没有这张表情' })
    const file = stickerPath(item)
    if (!existsSync(file)) return json(res, { ok: false, reason: '表情文件丢了' })
    const ext = (item.file.match(/\.[a-z0-9]+$/i) || ['.png'])[0].toLowerCase()
    const buf = readFileSync(file)
    res.writeHead(200, { 'content-type': MIME[ext] || 'image/png', 'cache-control': 'public, max-age=86400', 'content-length': buf.length })
    res.end(buf)
  })

  router.add('GET', 'api/stickers', async (req, res) => {
    const me = requireUser(req, res); if (!me) return
    const items = stickers.library().items.map((i) => ({ md5: i.md5, name: i.name, tags: i.tags, from: i.from, at: i.at, width: i.width, height: i.height, bytes: i.bytes, uses: i.uses || 0 }))
    return json(res, { ok: true, items })
  })

  router.add('POST', 'api/stickers/upload', async (req, res) => {
    const me = requireOwner(req, res); if (!me) return
    const b = await readBody(req)
    if (b.from === 'steal' && getConfig().stickers?.steal === false) return json(res, { ok: false, reason: '偷表情开关关着' })
    const data = stripDataUrl(b.data)
    if (!data) return json(res, { ok: false, reason: '没有图片数据' })
    const buf = Buffer.from(data, 'base64')
    const r = await stickers.addFromBuffer(buf, { name: b.name || '', tags: Array.isArray(b.tags) ? b.tags : [], from: b.from || 'panel', hint: b.hint || '' })
    return json(res, r)
  })

  router.prefix('DELETE', 'api/stickers/', async (req, res, url, p) => {
    const me = requireOwner(req, res); if (!me) return
    const md5 = decodeURIComponent(p.slice('api/stickers/'.length))
    return json(res, stickers.remove(md5))
  })

  router.prefix('PATCH', 'api/stickers/', async (req, res, url, p) => {
    const me = requireOwner(req, res); if (!me) return
    const md5 = decodeURIComponent(p.slice('api/stickers/'.length))
    const b = await readBody(req)
    return json(res, stickers.rename(md5, b.name, b.tags))
  })

  router.add('GET', 'api/icon', async (req, res) => {
    const f = dataDir('avatar')
    if (existsSync(f)) {
      let mime = 'image/png'
      try { mime = readFileSync(dataDir('avatar.mime'), 'utf8').trim() || 'image/png' } catch {}
      const buf = readFileSync(f)
      res.writeHead(200, { 'content-type': mime, 'cache-control': 'no-cache', 'content-length': buf.length })
      res.end(buf)
      return
    }
    const icon = readFileSync(join(ROOT, 'icon.svg'))
    res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-cache', 'content-length': icon.length })
    res.end(icon)
  })

  router.add('GET', 'api/avatar', async (req, res) => {
    const f = dataDir('avatar')
    if (!existsSync(f)) return json(res, { ok: false, reason: '还没有头像' })
    let mime = 'image/png'
    try { mime = readFileSync(dataDir('avatar.mime'), 'utf8').trim() || 'image/png' } catch {}
    const buf = readFileSync(f)
    res.writeHead(200, { 'content-type': mime, 'cache-control': 'no-store', 'content-length': buf.length })
    res.end(buf)
  })

  router.add('POST', 'api/avatar', async (req, res) => {
    const me = requireOwner(req, res); if (!me) return
    const b = await readBody(req)
    const data = stripDataUrl(b.data)
    // 空数据 = 用回默认图标（删掉头像文件，回到 icon.svg）
    if (!data) {
      try { unlinkSync(dataDir('avatar')) } catch {}
      try { unlinkSync(dataDir('avatar.mime')) } catch {}
      return json(res, { ok: true })
    }
    writeFileSync(dataDir('avatar'), Buffer.from(data, 'base64'))
    writeFileSync(dataDir('avatar.mime'), b.mime || 'image/png')
    return json(res, { ok: true })
  })

  router.add('GET', 'api/background', async (req, res) => {
    const f = dataDir('background')
    if (!existsSync(f)) return json(res, { ok: false, reason: '还没有背景图' })
    let mime = 'image/jpeg'
    try { mime = readFileSync(dataDir('background.mime'), 'utf8').trim() || 'image/jpeg' } catch {}
    const buf = readFileSync(f)
    res.writeHead(200, { 'content-type': mime, 'cache-control': 'no-store', 'content-length': buf.length })
    res.end(buf)
  })

  router.add('POST', 'api/background', async (req, res) => {
    const me = requireOwner(req, res); if (!me) return
    const b = await readBody(req)
    const data = stripDataUrl(b.data)
    // 空数据 = 清除背景图（前端「清除」按钮走这里）
    if (!data) {
      try { unlinkSync(dataDir('background')) } catch {}
      try { unlinkSync(dataDir('background.mime')) } catch {}
      setConfig({ theme: { mode: getConfig().theme.mode, background: '' } })
      return json(res, { ok: true })
    }
    writeFileSync(dataDir('background'), Buffer.from(data, 'base64'))
    writeFileSync(dataDir('background.mime'), b.mime || 'image/jpeg')
    setConfig({ theme: { mode: getConfig().theme.mode, background: 'local' } })
    return json(res, { ok: true })
  })
}
