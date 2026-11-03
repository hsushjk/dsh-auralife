import { writeFileSync } from 'node:fs'
import { dataDir } from '../../core/store.js'
import { listPersonas, readPersona, savePersona, deletePersona } from '../../persona/personas.js'

export function register(router, ctx) {
  const {
    json, readBody, stripDataUrl, requireUser, requireOwner,
    getConfig, setConfig, log, dsh, listModels,
    needSetup, setupOwner, verify, issueSession, sessionUser, dropSession,
    listGuests, createGuest, updateGuest, deleteGuest, displayNameOf, changePassword,
  } = ctx

  router.add('GET', 'api/state', async (req, res) => {
    const me = sessionUser(ctx.tokenOf(req))
    const cfg = getConfig()
    let identity = null
    try { identity = ctx.deps?.life?.load?.().identity || null } catch {}
    return json(res, {
      ok: true,
      needSetup: needSetup(),
      me: me ? { subject: me.subject, role: me.role, name: displayNameOf(me.subject), level: me.level || (me.role === 'owner' ? 'full' : 'social') } : null,
      botName: (identity?.name || cfg.botName) || 'AuraLife',
      title: cfg.pageTitle || 'AuraLife',
      siteName: cfg.siteName || 'AuraLife',
      version: ctx.VERSION,
      ownerName: (identity?.ownerName || cfg.ownerName) || '主人',
      persona: cfg.persona?.current || '',
      enabled: Boolean(cfg.enabled),
      theme: cfg.theme || { mode: 'follow', background: '' },
    })
  })

  router.add('POST', 'api/setup', async (req, res) => {
    if (!needSetup()) return json(res, { ok: false, reason: '已经有主人了' })
    const b = await readBody(req)
    if (!b.pledge) return json(res, { ok: false, reason: '先答应两件事：不用 Ta 开播圈钱、不放 Ta 污染社区' })
    const r = setupOwner({ username: b.username, password: b.password })
    if (r.ok) {
      const extra = { pledge: true }
      if (b.botName) extra.botName = String(b.botName).slice(0, 40)
      if (b.ownerName) extra.ownerName = String(b.ownerName).slice(0, 40)
      if (b.themeMode) extra.theme = { mode: String(b.themeMode), background: '' }
      if (b.persona) extra.persona = { current: String(b.persona).slice(0, 60) }

      if (!b.botName) {
        const hit = listPersonas().find((x) => x.id === (b.persona || 'dafeiyu'))
        if (hit?.name) extra.botName = hit.name
      }
      if (b.model && (b.model.provider || b.model.model)) {
        extra.model = {
          provider: String(b.model.provider || ''),
          model: String(b.model.model || ''),
          reasoningEffort: String(b.model.reasoningEffort || '').trim() || 'low',
        }
      }
      setConfig({ setupDone: true, ...extra })

      const av = b.avatar ? stripDataUrl(b.avatar.data || b.avatar) : ''
      if (av) {
        try {
          writeFileSync(dataDir('avatar'), Buffer.from(av, 'base64'))
          writeFileSync(dataDir('avatar.mime'), (b.avatar && b.avatar.mime) || 'image/png')
        } catch (e) { log.warn('向导存头像失败：' + e.message) }
      }
    }
    return json(res, r)
  })

  router.add('GET', 'api/models', async (req, res) => {
    const models = await listModels().catch(() => null)
    const def = (() => { try { return dsh.get('agentDefaultModel').currentSelection() || null } catch { return null } })()
    return json(res, { ok: true, models: models || [], default: def })
  })

  router.add('GET', 'api/personas', async (req, res) => {
    return json(res, { ok: true, personas: listPersonas().map((x) => ({ id: x.id, name: x.name, tags: x.tags || [] })) })
  })

  router.add('GET', 'api/personas/detail', async (req, res, url) => {
    if (!needSetup()) { const me = requireUser(req, res); if (!me) return }
    const id = url.searchParams.get('id') || ''
    const one = id ? readPersona(id) : null
    return json(res, { ok: true, persona: one ? { id: one.id, name: one.name, tags: one.tags, body: one.body } : null })
  })

  router.add('POST', 'api/personas/save', async (req, res) => {
    if (!needSetup()) { const me = requireOwner(req, res); if (!me) return }
    const b = await readBody(req)
    try {
      const saved = savePersona(String(b.id || '').trim() || String(b.name || '').trim(), {
        name: String(b.name || '').trim(),
        tags: Array.isArray(b.tags) ? b.tags.map((t) => String(t).trim()).filter(Boolean) : String(b.tags || '').split(/[,，\s]+/).filter(Boolean),
        body: String(b.body || ''),
      })
      return json(res, { ok: true, persona: { id: saved.id, name: saved.name, tags: saved.tags } })
    } catch (error) {
      return json(res, { ok: false, reason: error.message })
    }
  })

  router.add('POST', 'api/personas/delete', async (req, res) => {
    const me = requireOwner(req, res); if (!me) return
    const b = await readBody(req)
    const id = String(b.id || '')
    if (!id) return json(res, { ok: false, reason: '没说要删哪个' })
    if (id === (getConfig().persona?.current || '')) return json(res, { ok: false, reason: '这个是当前正在用的人设，先换一个再删' })
    deletePersona(id)
    return json(res, { ok: true })
  })

  router.add('POST', 'api/login', async (req, res) => {
    const b = await readBody(req)
    const acc = verify(b.username, b.password)
    if (!acc) return json(res, { ok: false, reason: '用户名或密码不正确' })
    const token = issueSession(acc)
    return json(res, { ok: true, token, subject: acc.subject, role: acc.role, name: displayNameOf(acc.subject) })
  })

  router.add('POST', 'api/logout', async (req, res) => {
    dropSession(ctx.tokenOf(req))
    return json(res, { ok: true })
  })

  router.add('POST', 'api/account/password', async (req, res) => {
    const me = requireUser(req, res); if (!me) return
    const b = await readBody(req)
    return json(res, changePassword(me.subject, b.oldPassword, b.newPassword))
  })

  router.add('GET', 'api/guests', async (req, res) => {
    const me = requireOwner(req, res); if (!me) return
    return json(res, { ok: true, guests: listGuests() })
  })

  router.add('POST', 'api/guests', async (req, res) => {
    const me = requireOwner(req, res); if (!me) return
    const b = await readBody(req)
    return json(res, createGuest({ username: b.username, displayName: b.displayName, note: b.note, level: b.level }))
  })

  router.prefix('PATCH', 'api/guests/', async (req, res, url, p) => {
    const me = requireOwner(req, res); if (!me) return
    const subject = decodeURIComponent(p.slice('api/guests/'.length))
    const b = await readBody(req)
    return json(res, updateGuest(subject, b))
  })

  router.prefix('DELETE', 'api/guests/', async (req, res, url, p) => {
    const me = requireOwner(req, res); if (!me) return
    const subject = decodeURIComponent(p.slice('api/guests/'.length))
    return json(res, deleteGuest(subject))
  })
}
