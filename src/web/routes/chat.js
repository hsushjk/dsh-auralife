// 引用快照只带显示需要的字段；这里只做形状清洗，真正落盘前 hub 会按 id 回查
// 真实消息并重建快照（客户端传的 text/who 一律不信，防伪造「你之前说过的话」）。
function cleanQuote(q) {
  if (!q || typeof q !== 'object') return null
  const id = String(q.id || '').trim().slice(0, 80)
  const text = String(q.text || '').trim().slice(0, 300)
  if (!id || !text) return null
  const kind = ['text', 'voice', 'sticker', 'image', 'file'].includes(q.kind) ? q.kind : 'text'
  return { id, who: q.who === 'bot' ? 'bot' : 'user', text, at: Math.round(Number(q.at) || 0), kind }
}

export function register(router, ctx) {
  const { json, readBody, stripDataUrl, requireUser, chatIdOf, displayNameOf, log } = ctx
  const { hub } = ctx.deps

  // 分页拉聊天记录：
  //   /api/messages                    → 最新 100 条（老客户端兼容用）
  //   /api/messages?before=<t>         → 取出比 t 更早的 100 条
  //   /api/messages?file=last          → 最新那一整片（网页端首屏，一文件=一页）
  //   /api/messages?file=prev&before=t → t 之前的那一整片（"查看更早的记录"）
  router.add('GET', 'api/messages', async (req, res, url) => {
    const me = requireUser(req, res); if (!me) return
    const chatId = chatIdOf(me.subject)
    const q = url?.searchParams || new URLSearchParams()
    const before = Math.max(0, Math.round(Number(q.get('before')) || 0))
    const file = String(q.get('file') || '')
    if (file === 'last' || file === 'prev') {
      const page = hub.pageFileOf(chatId, { before: file === 'prev' ? before : 0 })
      return json(res, {
        ok: true,
        messages: page.messages,
        oldestAt: page.oldestAt,
        hasMore: page.hasMore,
        file: { index: page.index, total: page.total, id: page.id || '' },
      })
    }
    const limit = Math.min(100, Math.max(1, Math.round(Number(q.get('limit')) || 100)))
    const page = hub.pageOf(chatId, { before, limit })
    return json(res, {
      ok: true,
      messages: page.messages,
      oldestAt: page.oldestAt,
      hasMore: page.hasMore,
      segment: { limit },
    })
  })

  // 按 id 定位一条历史消息（引用跳转用）：被引用的那条可能在旧分片里，
  // 前端先查这里，知道它存在再往前翻页，不用盲目翻到底。
  router.add('GET', 'api/messages/locate', async (req, res, url) => {
    const me = requireUser(req, res); if (!me) return
    const chatId = chatIdOf(me.subject)
    const id = String(url?.searchParams?.get('id') || '').trim().slice(0, 80)
    const message = id.length >= 6 ? hub.locateOf(chatId, id) : null
    if (!message) return json(res, { ok: false, reason: '那条消息已经找不到了' })
    return json(res, { ok: true, message })
  })

  router.add('POST', 'api/messages', async (req, res) => {
    const me = requireUser(req, res); if (!me) return
    const b = await readBody(req)
    const text = String(b.text || '').trim()
    const images = (Array.isArray(b.images) ? b.images : []).map((i) => ({
      data: stripDataUrl(i.data),
      mediaType: i.mediaType || 'image/png',
      name: i.name || 'image',
    })).filter((i) => i.data)
    // 任意后缀文件：不设业务上限，只防单个超物理极限（base64 30M≈原文件 24MB）；0 字节明确报错
    const files = []
    for (const f of Array.isArray(b.files) ? b.files : []) {
      const data = stripDataUrl(f.data)
      const name = String(f.name || '文件').slice(0, 120)
      if (!data) continue
      if (data.length >= 30 * 1024 * 1024) continue
      try {
        if (!Buffer.from(data, 'base64').length) return json(res, { ok: false, reason: '「' + name + '」读不出来（空文件）' })
      } catch { /* 非法 base64 交给 hub 处理 */ }
      files.push({ data, mediaType: f.mediaType || 'application/octet-stream', name })
    }
    const voice = b.voice && b.voice.data ? { data: stripDataUrl(b.voice.data), mime: b.voice.mime || 'audio/webm', dur: Math.min(60, Math.max(1, Number(b.voice.dur) || 1)) } : null
    const sticker = String(b.sticker || '').trim()
    const quote = cleanQuote(b.quote)
    if (!text && images.length === 0 && files.length === 0 && !voice && !sticker) return json(res, { ok: false, reason: '没说啥' })
    // 文件发送链路探针（排查「选了文件没弹窗」）：确认前端有没有把请求送过来
    if (files.length || images.length) log.info('[messages] 收到 ' + (files.length ? files.length + ' 个文件' : '') + (files.length && images.length ? ' + ' : '') + (images.length ? images.length + ' 张图' : ''))
    hub.onUserMessage({ chatId: chatIdOf(me.subject), userId: me.subject, nickname: displayNameOf(me.subject), text, images, files, voice, sticker, level: me.level, quote }).catch((e) => log.warn('收消息出错：' + e.message))
    return json(res, { ok: true })
  })

  router.add('POST', 'api/voice', async (req, res) => {
    const me = requireUser(req, res); if (!me) return
    const b = await readBody(req)
    const data = stripDataUrl(b.data)
    const dur = Number(b.dur) || 0
    if (!data) return json(res, { ok: false, reason: '没有音频数据' })
    if (dur < 1 || dur > 60) return json(res, { ok: false, reason: '语音条要 1 到 60 秒' })
    hub.onUserMessage({ chatId: chatIdOf(me.subject), userId: me.subject, nickname: displayNameOf(me.subject), text: '', voice: { data, mime: b.mime || 'audio/webm', dur }, level: me.level, quote: cleanQuote(b.quote) }).catch((e) => log.warn('收语音出错：' + e.message))
    return json(res, { ok: true })
  })

  router.add('POST', 'api/typing', async (req, res) => {
    const me = requireUser(req, res); if (!me) return
    const b = await readBody(req)
    hub.noteTyping?.(chatIdOf(me.subject), Boolean(b.typing))
    return json(res, { ok: true })
  })
}
