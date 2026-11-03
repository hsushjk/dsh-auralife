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
    if (!text && images.length === 0 && files.length === 0 && !voice && !sticker) return json(res, { ok: false, reason: '没说啥' })
    // 文件发送链路探针（排查「选了文件没弹窗」）：确认前端有没有把请求送过来
    if (files.length || images.length) log.info('[messages] 收到 ' + (files.length ? files.length + ' 个文件' : '') + (files.length && images.length ? ' + ' : '') + (images.length ? images.length + ' 张图' : ''))
    hub.onUserMessage({ chatId: chatIdOf(me.subject), userId: me.subject, nickname: displayNameOf(me.subject), text, images, files, voice, sticker, level: me.level }).catch((e) => log.warn('收消息出错：' + e.message))
    return json(res, { ok: true })
  })

  router.add('POST', 'api/voice', async (req, res) => {
    const me = requireUser(req, res); if (!me) return
    const b = await readBody(req)
    const data = stripDataUrl(b.data)
    const dur = Number(b.dur) || 0
    if (!data) return json(res, { ok: false, reason: '没有音频数据' })
    if (dur < 1 || dur > 60) return json(res, { ok: false, reason: '语音条要 1 到 60 秒' })
    hub.onUserMessage({ chatId: chatIdOf(me.subject), userId: me.subject, nickname: displayNameOf(me.subject), text: '', voice: { data, mime: b.mime || 'audio/webm', dur }, level: me.level }).catch((e) => log.warn('收语音出错：' + e.message))
    return json(res, { ok: true })
  })

  router.add('POST', 'api/typing', async (req, res) => {
    const me = requireUser(req, res); if (!me) return
    const b = await readBody(req)
    hub.noteTyping?.(chatIdOf(me.subject), Boolean(b.typing))
    return json(res, { ok: true })
  })
}
