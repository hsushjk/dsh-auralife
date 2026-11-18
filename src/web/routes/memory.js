// web/routes/memory.js — 记忆 v2 面板路由。
// 暴露真实的 v2 结构：事实（含版本链）/ 事件 / 联想 / 自我 / 整理。
// 旧的 profiles/insights/styles（档案/相处经验/说话方式）已随 v1 退休，不再暴露。
import { dataDir, readJson, writeJson, ensureDir, lockAndRun } from '../../core/store.js'
export function register(router, ctx) {
  const { json, readBody, requireUser, requireOwner } = ctx
  const { memory, self, organHost } = ctx.deps

  // 记忆全景：事实（全部，含 superseded 死行与版本链）、事件、联想、统计、最后整理
  router.add('GET', 'api/memory', async (req, res) => {
    const me = requireOwner(req, res); if (!me) return
    return json(res, {
      ok: true,
      stats: memory.stats(),
      facts: memory.facts(),
      episodes: memory.episodes(),
      edges: memory.edges(),
      lastConsolidate: memory.lastConsolidate(),
    })
  })

  // 记忆是只读的用户不能手动加/改/忘记忆，只有 Ta 自己的经历和 debug 接口能改。

  // 立即整理（编码新消息 → 事件 + 事实）
  router.add('POST', 'api/memory/consolidate', async (req, res) => {
    const me = requireOwner(req, res); if (!me) return
    try {
      const r = await memory.consolidate({ includeToday: true, force: true })
      return json(res, { ok: true, ...(r || {}) })
    } catch (error) {
      return json(res, { ok: false, reason: error.message })
    }
  })

  // 自我认知（记忆面板的「自我」tab，只读）
  router.add('GET', 'api/memory/self', async (req, res) => {
    const me = requireOwner(req, res); if (!me) return
    return json(res, { ok: true, self: self ? self.list() : null })
  })

  // 器官（Life-OS 能力清单，全 AI 托管无审批）
  router.add('GET', 'api/organs', async (req, res) => {
    const me = requireOwner(req, res); if (!me) return
    // 多进程同步：先按磁盘快照重扫（别的进程落盘/卸载的器官，本进程立刻看到）。
    if (organHost && typeof organHost.refreshIfChanged === 'function') {
      try { await organHost.refreshIfChanged() } catch (error) {}
    }
    // 只回传可序列化字段：内存条目里挂着 worker 运行时（Wire 对象）和执行函数，不能直接 JSON.stringify。
    const organs = (organHost ? organHost.list() : []).map((o) => ({
      id: o.id,
      name: o.name,
      description: o.description,
      status: o.status,
      source: o.source,
      capabilities: Array.isArray(o.capabilities) ? o.capabilities : [],
      settings: Array.isArray(o.settings) ? o.settings : [],
      tools: Array.isArray(o.toolDefs) ? o.toolDefs.map((d) => d && d.name).filter(Boolean) : [],
    }))
    return json(res, {
      ok: true,
      organs,
      capabilities: organHost ? organHost.capabilities() : [],
    })
  })

  // 器官审计（动作流水：加载/卸载/工具/联网/读写/借模型/自举。事后定位「谁的器官动过什么」）
  router.add('GET', 'api/organs/audit', async (req, res) => {
    const me = requireOwner(req, res); if (!me) return
    if (!organHost || !organHost.audit) return json(res, { ok: false, message: '器官审计未就绪' })
    const limit = Math.max(1, Math.min(200, Number(req.query?.limit) || 100))
    return json(res, { ok: true, entries: organHost.audit.list({ limit }) })
  })

  // 器官设置（meta.settings 声明式设置：读/写落在该器官自己的目录，器官代码用 api.store 读写）
  router.add('GET', 'api/organs/settings', async (req, res) => {
    const me = requireOwner(req, res); if (!me) return
    if (!organHost) return json(res, { ok: false, message: '器官宿主未就绪' })
    const org = String(req.query?.org || '')
    const entry = organHost.list().find((o) => o.id === org)
    if (!entry) return json(res, { ok: false, message: '没有这个器官' })
    const schema = Array.isArray(entry.settings) ? entry.settings : []
    const values = readJson(dataDir('organs', 'self-made', org, 'cfg.json'), null)
    return json(res, { ok: true, schema, values })
  })

  router.add('POST', 'api/organs/settings', async (req, res) => {
    const me = requireOwner(req, res); if (!me) return
    const b = await readBody(req)
    if (!organHost) return json(res, { ok: false, message: '器官宿主未就绪' })
    const org = String(b.org || '')
    if (!organHost.list().some((o) => o.id === org)) return json(res, { ok: false, message: '没有这个器官' })
    ensureDir(dataDir('organs', 'self-made', org))
    await lockAndRun(`organ-cfg-${org}`, () => {
      writeJson(dataDir('organs', 'self-made', org, 'cfg.json'), b.values || {})
    }, { staleMs: 10000, timeoutMs: 5000 })
    return json(res, { ok: true })
  })
}
