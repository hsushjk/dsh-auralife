// web/routes/settings.js — 设置 / 状态 / 生命总览路由。
// 彻底化后：status 不再有 speakUp/selfDrive 假键；自驱统一为 drive；便签变成执念池 wishes。
import { readPersona } from '../../persona/personas.js'
import { modulesSummary } from '../../core/modules.js'
import { readJson, dataDir } from '../../core/store.js'

export function register(router, ctx) {
  const { json, readBody, requireOwner, getConfig, setConfig, publicConfig, ownerInfo, log, VERSION, deps } = ctx
  const { hub, azone, drive, azoneSocial, memory, logger, asrInfo, listModels, self, life, wishes, chemistry, energy, alarm, hostInfo } = deps

  router.add('GET', 'api/config', async (req, res) => {
    const me = requireOwner(req, res); if (!me) return
    return json(res, { ok: true, config: publicConfig(getConfig()), owner: ownerInfo() })
  })

  router.add('PATCH', 'api/config', async (req, res) => {
    const me = requireOwner(req, res); if (!me) return
    const b = await readBody(req)
    const pid = b?.persona?.current
    if (pid && b.botName === undefined) {
      const hit = ctx.listPersonas().find((x) => x.id === pid)
      if (hit?.name) b.botName = hit.name
    }
    setConfig(b)
    try { deps?.rebindPort?.() } catch {}
    return json(res, { ok: true, config: publicConfig(getConfig()) })
  })

  router.add('GET', 'api/modules', async (req, res) => {
    const me = requireOwner(req, res); if (!me) return
    return json(res, { ok: true, ...modulesSummary(getConfig()) })
  })

  router.add('GET', 'api/logs', async (req, res) => {
    const me = requireOwner(req, res); if (!me) return
    return json(res, { ok: true, version: VERSION, logs: logger.recent(300), stats: logger.stats ? logger.stats() : null, maxMB: getConfig().logs?.maxMB || 2 })
  })

  router.add('POST', 'api/logs/clear', async (req, res) => {
    const me = requireOwner(req, res); if (!me) return
    const n = logger.clear ? logger.clear() : 0
    log.info(`日志已清空（${n} 条）`)
    return json(res, { ok: true, cleared: n })
  })

  // 生命总览：一条命（心情 / 执念 / 自我 / 压力 / 自驱 / 记忆 / 出厂人设 / 宿主机）
  router.add('GET', 'api/life', async (req, res) => {
    const me = requireOwner(req, res); if (!me) return
    const pid = getConfig().persona?.current || ''
    let persona = null
    try { persona = pid ? readPersona(pid) : null } catch {}
    return json(res, {
      ok: true,
      chemistry: chemistry ? chemistry.state() : null,
      energy: energy ? energy.state() : null,
      wishes: wishes.list(),
      self: self ? self.list() : null,
      pressure: life.pressure(Date.now()),
      pressureParts: (() => { try { return life.pressureParts ? life.pressureParts(Date.now()) : null } catch { return null } })(),
      drive: drive.state(),
      memory: memory.stats(),
      persona: persona ? { id: persona.id, name: persona.name, tags: persona.tags || [], body: persona.body || '' } : null,
      identity: (() => {
        try {
          const id = life.load().identity || {}
          return {
            name: id.name || getConfig().botName || '',
            ownerName: id.ownerName || getConfig().ownerName || '',
            body: id.body || '',
            updatedAt: Number(id.updatedAt) || 0,
            // 出厂种子（只读底子）：Ta 自己没改人格时生效的那一套。
            seedBody: persona ? (persona.body || '') : '',
          }
        } catch { return { name: getConfig().botName || '', ownerName: getConfig().ownerName || '', body: '', updatedAt: 0, seedBody: '' } }
      })(),
      // 总览显示的应该是「实际生效的模型」——Ta 自己选的（state.model）优先，否则主人配的（cfg.model）
      model: (() => {
        try {
          const own = life.load().model
          const c = getConfig().model || {}
          if (own && (own.provider || own.model)) {
            return { provider: own.provider, model: own.model, reasoningEffort: own.reasoningEffort || c.reasoningEffort || 'low', self: true }
          }
          return { provider: c.provider || '', model: c.model || '', reasoningEffort: c.reasoningEffort || 'low', self: false }
        } catch { return null }
      })(),
      alarms: alarm ? alarm.list() : [],
      // 上下文兜底估算用量占模型窗口的比例，接近 85% 会自动归档旧会话、开新会话。
      context: (() => { try { return hub.contextUsage ? hub.contextUsage('owner', true) : null } catch { return null } })(),
      // 部署探针：DSH 每次启动时 host.js 写 boot.json（记录加载的代码修改时间）。
      // 前端显示它，用户一眼就知道当前跑的是哪份代码，不用再猜「部署了没有」。
      boot: (() => { try { return readJson(dataDir('boot.json'), null) } catch { return null } })(),
    })
  })

  router.add('GET', 'api/status', async (req, res) => {
    const me = requireOwner(req, res); if (!me) return
    return json(res, {
      ok: true,
      version: VERSION, // 关于页「版本」此前漏了这个字段，前端一直显示「…」
      platform: process.platform, // 前端按平台隐藏 win 语音卡等
      host: (() => { try { return hostInfo ? hostInfo() : null } catch { return null } })(), // 关于页（DSH 版本/系统）
      stats: hub.stats(),
      diary: azone.state(),
      diaryStats: azone.stats(),
      drive: drive.state(),
      memory: memory.stats(),
      self: self ? self.list() : null,
      sessions: hub.sessions(),
      asr: (() => { try { return asrInfo ? asrInfo() : null } catch { return null } })(),
      models: (await listModels().catch(() => null)) || null,
    })
  })

  router.add('POST', 'api/test', async (req, res) => {
    const me = requireOwner(req, res); if (!me) return
    const b = await readBody(req)
    const what = String(b.what || '')
    try {
      if (what === 'drive') { await drive.fire('手动'); return json(res, { ok: true, message: '叫 Ta 了' }) }
      if (what === 'diary') { const r = await azone.writeDiary({ force: true }); return json(res, { ok: true, ...r }) }
      if (what === 'social') { const r = await azoneSocial.run({ force: true }); return json(res, { ok: true, ...r }) }
      return json(res, { ok: false, reason: '不认识：' + what })
    } catch (error) {
      return json(res, { ok: false, reason: error.message })
    }
  })

  // 执念池（取代旧 api/selfdrive 便签）
  router.add('GET', 'api/wishes', async (req, res) => {
    const me = requireOwner(req, res); if (!me) return
    return json(res, { ok: true, wishes: wishes.list() })
  })

  router.add('POST', 'api/wishes', async (req, res) => {
    const me = requireOwner(req, res); if (!me) return
    const b = await readBody(req)
    if (b?.resolve) {
      const w = wishes.resolve(String(b.id || ''), String(b.closedBy || ''))
      // 了结一桩心事：多巴胺小涨（+4，事情成了）+ 血清素涨（+2，踏实了）。
      if (w) {
        chemistry?.event?.({ dopamine: 4, serotonin: 2 }, '了结了一桩心事')
      }
      return json(res, { ok: true, wish: w })
    }
    const opts = {}
    const bt = Number(b.baseTension)
    const tr = Number(b.tensionRate)
    if (Number.isFinite(bt)) opts.baseTension = bt
    if (Number.isFinite(tr)) opts.tensionRate = tr
    const w = wishes.add(String(b.text || '').trim(), opts)
    return json(res, { ok: true, wish: w })
  })

  // 自我认知（reset 回滚到「只有出厂人设」）
  router.add('GET', 'api/self', async (req, res) => {
    const me = requireOwner(req, res); if (!me) return
    return json(res, { ok: true, self: self ? self.list() : null })
  })

  router.add('POST', 'api/self', async (req, res) => {
    const me = requireOwner(req, res); if (!me) return
    const b = await readBody(req)
    if (b?.reset) return json(res, { ok: true, self: self ? self.reset() : null })
    return json(res, { ok: false, message: '只支持 reset' })
  })
}
