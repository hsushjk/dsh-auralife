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

  // 删除端点已移除（m11672）：日记和留言都不允许手动删——Ta 的空间归 Ta 自己管。

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

  router.add('POST', 'api/diary/social-run', async (req, res) => {
    const me = requireOwner(req, res); if (!me) return
    const r = await azoneSocial.run({ force: true })
    return json(res, { ok: true, ...r })
  })
}
