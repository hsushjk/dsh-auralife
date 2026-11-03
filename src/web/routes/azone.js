export function register(router, ctx) {
  const { json, readBody, requireUser, requireOwner, displayNameOf, log } = ctx
  const { azone, azoneSocial } = ctx.deps

  router.add('GET', 'api/diary', async (req, res) => {
    const me = requireUser(req, res); if (!me) return
    const role = me.role === 'owner' ? 'owner' : 'guest'
    return json(res, { ok: true, entries: azone.visibleEntries(role), state: azone.state(), stats: azone.stats() })
  })

  router.add('POST', 'api/diary/comment', async (req, res) => {
    const me = requireUser(req, res); if (!me) return
    const b = await readBody(req)
    const r = azone.addComment(b.entryId, { from: me.subject, name: displayNameOf(me.subject), text: String(b.text || '').trim() })
    azoneSocial.run({ force: true }).catch((e) => log.warn('回访留言出错：' + e.message))
    return json(res, r || { ok: true })
  })

  router.add('POST', 'api/diary/comment/delete', async (req, res) => {
    const me = requireUser(req, res); if (!me) return
    const b = await readBody(req)
    const entry = azone.entryById(b.entryId)
    const comment = entry?.comments?.find((c) => c.id === b.commentId)
    if (!comment) return json(res, { ok: false, reason: '这条留言没了' })
    if (b.replyId) {
      const reply = comment.replies?.find((r) => r.id === b.replyId)
      if (!reply) return json(res, { ok: false, reason: '这条回复没了' })
      if (me.role !== 'owner' && reply.from !== me.subject) return json(res, { ok: false, reason: '只能删自己的' })
      return json(res, azone.deleteReply(b.entryId, b.commentId, b.replyId))
    }
    if (me.role !== 'owner' && comment.from !== me.subject) return json(res, { ok: false, reason: '只能删自己的' })
    return json(res, azone.deleteComment(b.entryId, b.commentId))
  })

  router.add('POST', 'api/diary/reply', async (req, res) => {
    const me = requireUser(req, res); if (!me) return
    const b = await readBody(req)
    const r = azone.addReply(b.entryId, b.commentId, { from: me.subject, name: displayNameOf(me.subject), text: String(b.text || '').trim() })
    azoneSocial.run({ force: true }).catch((e) => log.warn('回访留言出错：' + e.message))
    return json(res, r || { ok: true })
  })

  router.add('POST', 'api/diary/run', async (req, res) => {
    const me = requireOwner(req, res); if (!me) return
    const b = await readBody(req)
    const entry = await azone.writeDiary({ visibility: b.visibility === 'self' ? 'self' : 'all' })
    return json(res, { ok: true, entry })
  })

  router.add('POST', 'api/diary/delete', async (req, res) => {
    const me = requireOwner(req, res); if (!me) return
    const b = await readBody(req)
    return json(res, azone.remove(b.entryId))
  })

  router.add('POST', 'api/diary/social-run', async (req, res) => {
    const me = requireOwner(req, res); if (!me) return
    const r = await azoneSocial.run({ force: true })
    return json(res, { ok: true, ...r })
  })
}
