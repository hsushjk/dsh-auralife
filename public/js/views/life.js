import { esc, fmtDay, fmtClock } from '../format.js'

// 生命视图：一条命的一等公民仪表盘。
// 子 tab：总览 / 闹钟 / 内分泌 / 身体 / 执念 / 人格 / 器官。
// 数据源：/api/life（chemistry/energy/wishes/self/pressure/memory/drive/alarms/context），
//         /api/wishes、/api/memory/self、/api/organs 做读写。

const TABS = [
  ['overview', '总览'],
  ['alarms', '闹钟'],
  ['chemistry', '内分泌'],
  ['body', '身体'],
  ['wishes', '执念'],
  ['self', '人格'],
  ['organs', '器官'],
]

// 与后端 src/life/chemistry.js 的 CHEM 保持一致（基线 / 半衰期，单位分钟）
const CHEM_META = {
  dopamine: { label: '多巴胺', baseline: 50, halfLifeMin: 25, note: '开心、奖励、做成事会涨；相位性尖峰，兴头半小时左右' },
  cortisol: { label: '皮质醇', baseline: 20, halfLifeMin: 90, note: '压力、受挫、被怼会涨' },
  serotonin: { label: '血清素', baseline: 50, halfLifeMin: 180, note: '安全感；被感谢被依赖会涨，皮质醇长期偏高会把它拖低' },
}

// 激素是浮点值（事件增量带小数、衰减连续），显示保留 1 位小数。
function fx(v) {
  return Math.round((Number.isFinite(Number(v)) ? Number(v) : 0) * 10) / 10
}

// 与后端 src/life/state.js wishTension 一致：base + 每小时·rate − relief，clamp 0~100
function wishTensionC(w, now = Date.now()) {
  if (!w || w.status !== 'open') return 0
  const ageH = Math.max(0, (now - (w.createdAt || now)) / 3600_000)
  const base = Number.isFinite(w.baseTension) ? w.baseTension : 80
  const rate = Number.isFinite(w.tensionRate) ? w.tensionRate : 5
  const relief = Number.isFinite(w.relief) ? w.relief : 0
  return Math.max(0, Math.min(100, Math.round(base + ageH * rate - relief)))
}

const SRC_LABEL = { told: '他说过', inferred: '我推测', self_did: '我自己做的', manual: '手动', imagined: '想象的' }
const SELF_FIELD = { traits: '性格', values: '看重', boundaries: '底线' }

export function createLifeView(ctx) {
  const { $, $$, api, isOwner, toast, paneShell, getCfg, goto, refresh, refreshAvatar, BASE } = ctx
  let tab = 'overview'
  // 实时刷新：切视图/切子 tab 每次都重新拉数据（无条件重绘）；停在总览/器官页时每 8 秒轮询，
  // Ta 长出新器官立刻出现，不用重启 DSH。
  let pollTimer = null

  function renderLife(main) {
    paneShell(main, '生命', '<div class="mem-tabs" id="life-tabs">' +
      TABS.map(([id, label]) => '<button data-ltab="' + id + '" class="' + (tab === id ? 'on' : '') + '">' + label + '</button>').join('') +
      '</div>')
    const body = $('#pane-body')
    if (body) body.dataset.view = 'life'
    const tabs = $('#life-tabs')
    if (tabs) tabs.onclick = (e) => {
      const b = e.target.closest('[data-ltab]')
      if (!b) return
      tab = b.dataset.ltab
      $$('#life-tabs button').forEach((x) => x.classList.toggle('on', x.dataset.ltab === tab))
      loadLife()
    }
    loadLife()
    // 轮询：Ta 在后台长出新器官时，总览/器官页自动出现，不需要重启。
    clearInterval(pollTimer)
    pollTimer = setInterval(() => {
      const b = $('#pane-body')
      if (!b || b.dataset.view !== 'life') { clearInterval(pollTimer); return }
      if (tab === 'overview' || tab === 'organs') loadLife()
    }, 8000)
  }

  async function loadLife() {
    const body = $('#pane-body')
    if (!body) return
    // 器官 / 执念各自独立接口，不依赖 /api/life
    if (tab === 'organs') return renderOrgans(body)
    if (tab === 'wishes') return renderWishes(body)
    const r = await api('/api/life')
    if (!r.ok) { body.innerHTML = '<div class="empty">' + esc(r.reason || '读不到') + '</div>'; return }
    if (tab === 'alarms') return renderAlarms(body, r)
    if (tab === 'chemistry') return renderChemistry(body, r)
    if (tab === 'body') return renderBody(body, r)
    if (tab === 'self') { await renderPersona(body, r); return }
    renderOverview(body, r)
  }

  // ---------- 总览 ----------
  async function renderOverview(body, r) {
    const cfg = getCfg()
    const organR = await api('/api/organs')
    const organCount = (organR.ok && Array.isArray(organR.organs)) ? organR.organs.filter((o) => o.status === 'active').length : '…'
    const wishes = r.wishes || []
    const self = r.self || { version: 0, traits: [], values: [], boundaries: [] }
    const drive = r.drive || {}
    const mem = r.memory || {}
    const urge = drive.lastAssess ? drive.lastAssess.urge : null
    const chem = r.chemistry || {}
    const en = r.energy || {}
    const mdl = r.model || null
    const idn = r.identity || {}
    const openWishes = wishes.filter((w) => w.status === 'open')
    const selfCount = (self.traits || []).length + (self.values || []).length + (self.boundaries || []).length
    const rhythm = drive.rhythm || {}

    const card = (t, v, sub) => '<div class="ov-card"><div class="ov-t">' + t + '</div><div class="ov-v">' + v +
      (sub ? ' <span class="muted" style="font-size:12px">' + sub + '</span>' : '') + '</div></div>'
    // 内分泌：三行竖排、无粗体
    const chemCard = '<div class="ov-card"><div class="ov-t">内分泌</div><div class="chem-lines">' +
      '<div class="ov-row"><span>多巴胺</span><span>' + fx(chem.dopamine ?? 50) + '</span></div>' +
      '<div class="ov-row"><span>皮质醇</span><span>' + fx(chem.cortisol ?? 20) + '</span></div>' +
      '<div class="ov-row"><span>血清素</span><span>' + fx(chem.serotonin ?? 50) + '</span></div>' +
      '</div></div>'

    body.innerHTML =
      '<div class="ov-grid">' +
      chemCard +
      card('体力', Math.round(en.level ?? 100) + ' / 100') +
      card('冲动（主动找你的动力）', urge == null ? '—' : urge + ' / 100', '') +
      card('执念', String(openWishes.length), '件惦记着') +
      card('自我', String(selfCount), '条 · v' + (self.version || 0)) +
      card('器官', String(organCount), '个') +
      card('当前作息', esc(rhythm.quietFrom || '02:00') + '-' + esc(rhythm.quietTo || '07:00'), 'Ta 的睡眠时段') +
      '<div class="ov-card ov-full"><div class="ov-t">现在</div><div class="ov-rows">' +
      '<div class="ov-row"><span>总开关</span><span>' + (cfg?.enabled ? '开' : '关') + '</span></div>' +
      '<div class="ov-row"><span>Ta 认为Ta 是</span><span>' + (idn.name ? esc(idn.name) : esc(cfg?.botName || 'AuraLife')) + '</span></div>' +
      '<div class="ov-row"><span>Ta 认为你是</span><span>' + (idn.ownerName ? esc(idn.ownerName) : esc(cfg?.ownerName || '主人')) + '</span></div>' +
      '<div class="ov-row"><span>主动搭话</span><span>' + (cfg?.drive?.enabled ? '开' : '关') + '</span></div>' +
      '<div class="ov-row"><span>模型</span><span>' + (mdl ? esc(mdl.model || '') + (mdl.provider ? ' <span class="muted">@' + esc(mdl.provider) + '</span>' : '') + ' <span class="muted">· 思考：' + esc(String(mdl.reasoningEffort || 'low')) + '</span>' : '默认') + '</span></div>' +
      '<div class="ov-row"><span>AuraLife启动时间</span><span>' + (r.boot && r.boot.at ? fmtDay(r.boot.at) + ' 加载' : '<b style="color:#c0392b">旧版（DSH 还没重启加载新代码）</b>') + '</span></div>' +
      (r.context ? '<div class="ov-row"><span>上下文</span><span>' + r.context.ratio + '% (估算 ' + r.context.tokens + '/' + r.context.window + ')' + (r.context.ratio >= 85 ? ' · <b>快满了，会自动归档开新会话</b>' : '') + '</span></div>' : '') +
      '</div></div>' +
      '</div>'
  }

  // ---------- 闹钟 ----------
  function renderAlarms(body, r) {
    const all = (r.alarms || []).slice().sort((a, b) => a.at - b.at)
    const pending = all.filter((a) => !a.fired)
    const fired = all.filter((a) => a.fired)
    const row = (a, gray) => '<div class="ov-row"><span' + (gray ? ' class="muted"' : '') + '>' + fmtDay(a.at) + ' ' + fmtClock(a.at) + '</span><span>' +
      esc(String(a.reason || '').slice(0, 60)) + (gray ? ' <span class="muted">（已响过）</span>' : '') + '</span></div>'
    // 不写「还没响」「已经响过」两截标题，一列到底，已响的灰字标出来就行。
    body.innerHTML =
      '<div class="section"><div class="body ov-rows">' +
      (pending.length ? pending.map((a) => row(a, false)).join('') : '<div class="ov-row"><span>Ta 还没给自己设闹钟</span></div>') +
      fired.map((a) => row(a, true)).join('') +
      '</div></div>'
  }

  // ---------- 内分泌 ----------
  function renderChemistry(body, r) {
    const chem = r.chemistry || {}
    // 数值区：只给数值（基线/半衰期/说明合并到「会推它的事」）
    const rows = Object.keys(CHEM_META).map((k) => {
      const m = CHEM_META[k]
      const v = chem[k] ?? m.baseline
      return '<div class="mem-row"><div class="mem-text">' + m.label + ' <b>' + fx(v) + '</b></div></div>'
    }).join('')
    const hist = (chem.history || []).slice(0, 20)
    const histRows = hist.length ? hist.map((h) => {
      const parts = []
      if (h.dopamine) parts.push('多巴胺 ' + (h.dopamine > 0 ? '↑' + h.dopamine : '↓' + Math.abs(h.dopamine)))
      if (h.cortisol) parts.push('皮质醇 ' + (h.cortisol > 0 ? '↑' + h.cortisol : '↓' + Math.abs(h.cortisol)))
      if (h.serotonin) parts.push('血清素 ' + (h.serotonin > 0 ? '↑' + h.serotonin : '↓' + Math.abs(h.serotonin)))
      return '<div class="mem-row"><div class="mem-text">' + parts.map(esc).join(' · ') + (h.reason ? ' <span class="muted">— ' + esc(h.reason) + '</span>' : '') +
        '<div class="mem-meta">' + esc(fmtDay(h.at)) + '</div></div></div>'
    }).join('') : '<div class="muted" style="font-size:12px">还没有变化记录。</div>'
    const chemNotes = Object.keys(CHEM_META).map((k) => {
      const m = CHEM_META[k]
      return '<div style="margin-bottom:6px"><b>' + m.label + '</b><span class="muted" style="font-size:12px">（基线 ' + m.baseline + ' · 半衰期 ' + m.halfLifeMin + ' 分钟）</span>' +
        '<div class="muted" style="font-size:12px">' + esc(m.note) + '</div></div>'
    }).join('')
    body.innerHTML =
      '<div class="section"><h3>内分泌</h3><div class="body">' + rows + '</div></div>' +
      '<div class="section"><h3>会推它的事</h3><div class="body">' + chemNotes +
      '<div class="muted" style="font-size:12px">' +
      'Ta 也可以自己调：Ta 有「调节激素」的办法，想压一压或者提一提的时候会用。<br>' +
      '这些都发生在 Ta 跟你相处的时候，不用手动管。</div></div></div>' +
      '<div class="section"><h3>激素变化记录</h3><div class="body">' + histRows + '</div></div>'
  }

  // ---------- 身体 ----------
  function renderBody(body, r) {
    const en = r.energy || {}
    const d = r.drive || {}
    const a = d.lastAssess || null
    const urge = a ? a.urge : 0
    const rhythm = d.rhythm || {}
    const quietLine = (a && a.quiet) ? '此刻在 Ta 自己的睡眠时段（' + esc(rhythm.quietFrom || '') + '-' + esc(rhythm.quietTo || '') + '），不会醒。' : ''
    const assessLine = a
      ? '<div class="muted" style="font-size:12px;margin-top:6px">最近一次自我评估 ' + fmtClock(a.at) + '：' + (a.awake ? '醒着' : '在睡') + '，想找你的冲动 <b>' + a.urge + '</b>/100' + (a.topic ? '，想聊「' + esc(a.topic) + '」' : '') + '。</div>'
      : '<div class="muted" style="font-size:12px;margin-top:6px">Ta 还没做过自我评估（闲置超过 ' + 20 + ' 分钟才会评估一次）。</div>'
    body.innerHTML =
      '<div class="section"><h3>体力</h3><div class="body">' +
      '<div class="ov-v" style="font-size:22px">' + Math.round(en.level ?? 100) + ' <span class="muted" style="font-size:13px">/ 100</span></div>' +
      '<div class="muted" style="font-size:12px;margin-top:6px">体力只跟作息走：醒着回话就消耗，不聊天干活就慢慢恢复，睡觉时恢复更快。</div>' +
      '</div></div>' +
      '<div class="section"><h3>冲动（主动找你的动力）</h3><div class="body">' +
      '<div class="ov-v" style="font-size:22px">' + (a ? a.urge : '—') + ' <span class="muted" style="font-size:13px">/ 100</span></div>' +
      '<div class="muted" style="font-size:12px;margin-top:6px">想不想找你，由 Ta 自己评估——以挂念着的事、心情、内分泌、你多久没来计算。冲动过 ' + (d.threshold ?? 55) + ' 且醒着，Ta 就会主动开口' + quietLine + '</div>' +
      assessLine +
      '</div></div>' +
      '<div class="section"><h3>作息</h3><div class="body">' +
      '<div class="ov-row"><span>睡眠时段</span><span>' + esc(rhythm.quietFrom || '02:00') + ' - ' + esc(rhythm.quietTo || '07:00') + '</span></div>' +
      '<div class="muted" style="font-size:12px;margin-top:6px">Ta 自己会随生活节奏调。</div>' +
      '</div></div>'
  }

  // ---------- 执念 ----------
  async function renderWishes(body) {
    body.innerHTML =
      '<div class="section"><h3>惦记着</h3><div class="body" id="wish-list"></div></div>'
    const list = $('#wish-list')
    loadWishList(list)
  }

  async function loadWishList(list) {
    const r = await api('/api/wishes')
    const items = (r.ok && r.wishes) || []
    if (!items.length) { list.innerHTML = '<div class="muted" style="font-size:12px">心里还没有惦记的事。</div>'; return }
    const now = Date.now()
    list.innerHTML = items.map((w) => {
      const open = w.status === 'open'
      const t = wishTensionC(w, now)
      const used = w.lastUsedAt ? '上次拿来当由头 ' + fmtDay(w.lastUsedAt) + ' ' + fmtClock(w.lastUsedAt) : '还没拿来当过由头'
      return '<div class="guest-row"><span class="g-name">' + esc(w.text) + '</span>' +
        '<span class="muted" style="font-size:12px">' +
        (open ? '惦记中 · 想念 ' + t + '/100 · ' + used : '已了结' + (w.closedBy ? ' · ' + esc(w.closedBy) : '')) +
        '</span></div>'
    }).join('')
  }

  // ---------- 人格 ----------
  // 人格 = 名字 + 对你的称呼 + 底色。出厂只是种子（setup 时定），之后完全由 Ta 接管，
  // Ta 想怎么覆盖就怎么覆盖；这里只读，不提供任何修改入口（需求 5）。
  async function renderPersona(body, r) {
    const persona = r.persona || null
    const self = r.self || { version: 0, traits: [], values: [], boundaries: [] }
    const identity = r.identity || { name: '', ownerName: '', body: '', seedBody: '' }
    const cfg = getCfg()
    const tags = (persona && Array.isArray(persona.tags) && persona.tags.length)
      ? persona.tags.map((t) => '<span class="mem-tag">' + esc(t) + '</span>').join('')
      : ''

    const selfRows = ['traits', 'values', 'boundaries'].map((k) => {
      const items = self[k] || []
      const list = items.length ? items.map((it) => '<div class="mem-row"><div class="mem-text">' + esc(it.label) +
        '<div class="mem-meta">信度 ' + Math.round((it.conf || 0) * 100) + '% · ' + esc(SRC_LABEL[it.src] || it.src || '') + '</div></div></div>').join('') : '<div class="muted" style="font-size:12px">还没有。</div>'
      return '<div class="mem-group"><div class="mem-group-name">' + SELF_FIELD[k] + '（' + items.length + '）</div><div class="mem-body">' + list + '</div></div>'
    }).join('')

    // 生效值：Ta 自己改过的优先，没改过就用出厂
    const effName = identity.name || cfg?.botName || 'AuraLife'
    const effOwner = identity.ownerName || cfg?.ownerName || '主人'
    const verLine = identity.updatedAt
      ? 'Ta 自己改的 · ' + fmtDay(identity.updatedAt)
      : 'Ta 还没改过人格（出厂种子在用）'
    const selfUpd = (self.updatedAt) ? '上次长出新认识：' + fmtDay(self.updatedAt) : '还没长出新认识'
    // 形象（头像）后续不能手动换——只有 Ta 自己能换（web_set_avatar）。这里只展示。
    const avat = '<div class="ov-row"><span>头像</span><span style="display:flex;align-items:center;gap:8px">' +
      '<img id="p-avatar" src="' + (BASE || '') + '/api/avatar?ts=' + Date.now() + '" alt="" style="width:44px;height:44px;border-radius:50%;object-fit:cover;background:#eee" onerror="this.src=\'' + (BASE || '') + '/icon.svg\'" />' +
      '</span></div>'
    body.innerHTML =
      '<div class="section"><h3>现在的人格</h3><div class="body">' +
      '<div class="ov-row"><span>Ta 认为Ta 是</span><span>' + esc(effName) + '</span></div>' +
      '<div class="ov-row"><span>Ta 认为你是</span><span>' + esc(effOwner) + '</span></div>' +
      '<div class="ov-row"><span>版本</span><span class="muted" style="font-size:12px">' + esc(verLine) + '</span></div>' +
      (identity.body
        ? '<div class="muted" style="font-size:12px;margin:8px 0 4px">底色（Ta 自己定的）：</div>' +
          '<div style="white-space:pre-wrap;font-size:13px;line-height:1.7">' + esc(identity.body) + '</div>'
        : (persona && persona.body
          ? '<div class="muted" style="font-size:12px;margin:8px 0 4px">底色（出厂种子' + (persona.name ? ' · ' + esc(persona.name) : '') + '，Ta 还没自己改）：</div>' +
            '<div style="white-space:pre-wrap;font-size:13px;line-height:1.7">' + esc(persona.body) + '</div>'
          : '<div class="muted" style="font-size:12px;margin-top:8px">出厂没写底色——Ta 的人格全看 Ta 自己长。</div>')) +
      '</div></div>' +
      '<div class="section"><h3>形象</h3><div class="body">' + avat + '</div></div>' +
      '<div class="section"><h3>Ta 自己认定的</h3><div class="body">' +
      '<div class="ov-row"><span>上次长出新认识</span><span class="muted" style="font-size:12px">' + esc(selfUpd) + '</span></div>' +
      selfRows +
      '<p class="hint">每天重放记忆时 Ta 从自己的经历里长出来。长出来的可以覆盖底色。</p>' +
      '</div></div>'
  }

  // ---------- 器官 ----------
  async function renderOrgans(body) {
    const r = await api('/api/organs')
    if (!r.ok) { body.innerHTML = '<div class="empty">' + esc(r.reason || '读不到') + '</div>'; return }
    const organs = r.organs || []
    const builtin = organs.filter((o) => o.status === 'active' && o.source === 'builtin')
    const selfMade = organs.filter((o) => o.status === 'active' && o.source === 'self-made')
    const tripped = organs.filter((o) => o.status === 'tripped')
    const capTags = (o) => (o.capabilities || []).map((c) => '<span class="mem-tag">' + esc(c.name) + '</span>').join('')
    const row = (o, extra) => '<div class="mem-row"><div class="mem-text">' + esc(o.name) + ' <span class="mem-tag">' + esc(o.id) + '</span>' +
      '<div class="mem-meta">' + esc(o.description || '') + '</div>' + capTags(o) + (extra || '') + '</div></div>'
    body.innerHTML =
      (tripped.length ? '<div class="mem-group"><div class="mem-group-name">熔断停用（' + tripped.length + '）</div><div class="mem-body">' +
        tripped.map((o) => '<div class="mem-row"><div class="mem-text">' + esc(o.name) + ' <span class="mem-tag">' + esc(o.id) + '</span>' +
          '<div class="mem-meta">连续出错被自动停用（保护性熔断）</div></div></div>').join('') +
        '</div></div>' : '') +
      '<div class="mem-group"><div class="mem-group-name">出厂自带（' + builtin.length + '）</div><div class="mem-body">' +
      builtin.map((o) => row(o)).join('') +
      '</div></div>' +
      '<div class="mem-group"><div class="mem-group-name">Ta 自己长的（' + selfMade.length + '）</div><div class="mem-body">' +
      (selfMade.length ? selfMade.map((o) => row(o,
        (Array.isArray(o.settings) && o.settings.length ? '<div class="mem-meta" style="margin-top:6px"><button class="mini" data-orgset="' + esc(o.id) + '">设置（' + o.settings.length + ' 项）</button></div>' : '')
      )).join('') : '<div class="muted" style="font-size:12px">还没有。</div>') +
      '</div></div>'
    body.onclick = async (e) => {
      const os = e.target.closest('[data-orgset]')
      if (!os) return
      const id = os.dataset.orgset
      const sr = await api('/api/organs/settings?org=' + encodeURIComponent(id))
      if (!sr.ok) { toast(sr.reason || '读不到', 'err'); return }
      const schema = sr.schema || []
      const values = sr.values || {}
      paneShell(body, '器官设置', '<span class="muted" style="font-size:12px">' + esc(id) + '</span>')
      let html = '<div class="mem-body">'
      if (!schema.length) html += '<div class="muted">这个器官没有声明设置项。</div>'
      for (const s of schema) {
        const v = values[s.key] !== undefined ? values[s.key] : (s.default !== undefined ? s.default : '')
        if (s.type === 'boolean') {
          html += '<div class="mem-row"><div class="mem-text">' + esc(s.label || s.key) +
            '<div class="mem-meta">' + esc(s.key) + '</div></div>' +
            '<span class="c-acts"><label class="switch"><input type="checkbox" data-orgkey="' + esc(s.key) + '"' + (v ? ' checked' : '') + '><span class="slider"></span></label></span></div>'
        } else {
          html += '<div class="mem-row"><div class="mem-text">' + esc(s.label || s.key) +
            '<div class="mem-meta">' + esc(s.key) + '</div></div>' +
            '<input class="inp" style="width:160px" data-orgkey="' + esc(s.key) + '" value="' + esc(String(v)) + '"></div>'
        }
      }
      html += '</div><div style="padding:8px 12px"><button class="mini" id="orgset-save">保存</button> <span class="muted" style="font-size:12px">Ta 的器官代码会用这些值。</span></div>'
      body.innerHTML = html
      body.querySelector('#orgset-save').onclick = async () => {
        const vals = {}
        for (const s of schema) {
          const el = body.querySelector('[data-orgkey="' + s.key + '"]')
          if (!el) continue
          if (s.type === 'boolean') vals[s.key] = el.checked
          else if (s.type === 'number') vals[s.key] = Number(el.value) || 0
          else vals[s.key] = String(el.value).slice(0, 200)
        }
        const pr = await api('/api/organs/settings', { method: 'POST', body: { org: id, values: vals } })
        toast(pr.ok ? '存好了' : (pr.reason || '没存上'), pr.ok ? '' : 'err')
      }
    }
  }

  return { renderLife, loadLife }
}
