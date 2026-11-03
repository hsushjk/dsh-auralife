// 同一份前端会被挂在 DSH 的 /auralife/ 下，也会被固定端口挂在根路径，所以顺着当前地址推，别写死。
import { esc, fmtClock, fmtDay, dayKey, dayLabel, BARS, fmtDur, greet } from './js/format.js'
import { bindTheme, bgUrl, bustBackground, applyTheme, watchSystemDark } from './js/theme.js'
import { TONES, playSound as playTone } from './js/sound.js'
import { encodeWav } from './js/audio.js'
import { createLifeView } from './js/views/life.js'
import { createLogsView } from './js/views/logs.js'

const BASE = (location.pathname.replace(/\/?$/, '').replace(/\/index\.html$/, ''))
const TOKEN_KEY = 'auralife_token'
let token = localStorage.getItem(TOKEN_KEY) || ''
let botState = null      // /api/state 的结果
let me = null            // 当前登录的人
let cfg = null           // 完整配置（主人）
let models = []          // [{provider, model}]
let personaList = []     // [{id, name, tags}]
let currentView = 'chat'
let stream = null
// 聊天记录分页状态：服务端一片 100 条，往上翻一页取比 oldestAt 更早的 100 条
let historyState = { oldestAt: 0, hasMore: false, loading: false }

const $ = (s, el) => (el || document).querySelector(s)
const $$ = (s, el) => Array.from((el || document).querySelectorAll(s))

function api(path, opts = {}) {
  const headers = Object.assign({}, opts.headers || {})
  if (token) headers.authorization = 'Bearer ' + token
  if (opts.body !== undefined && !(opts.body instanceof Blob)) {
    headers['content-type'] = 'application/json'
    opts.body = JSON.stringify(opts.body)
  }
  return fetch(BASE + path, { ...opts, headers }).then(async (r) => {
    if (r.status === 401) { setToken(''); }
    const t = await r.text()
    try { return JSON.parse(t) } catch (e) { return { ok: false, reason: t.slice(0, 200) || ('HTTP ' + r.status) } }
  }).catch((e) => ({ ok: false, reason: e.message }))
}

function setToken(t) { token = t || ''; if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY) }

function toast(msg, kind = '') {
  const box = $('#toasts')
  const el = document.createElement('div')
  el.className = 'toast ' + kind
  el.textContent = msg
  box.appendChild(el)
  setTimeout(() => el.remove(), 3200)
}

// 名字优先级：/api/state（后端已做 identity 优先）> 本地配置 > 默认。Ta 自己改名字后刷新页面即见。
const bot = () => (botState && botState.botName) || cfg?.botName || 'AuraLife'
const ownerName = () => (botState && botState.ownerName) || cfg?.ownerName || '主人'
const isOwner = () => Boolean(me && me.role === 'owner')

bindTheme({ base: BASE, cfg: () => cfg, state: () => botState })
watchSystemDark()

// 自动化测试用的把手
window.__aura = {
  get cfg() { return cfg },
  get me() { return me },
  get state() { return botState },
  applyTheme,
  playSound,
  bustBackground,
}

function setAvatar(el, hasImg) {
  if (!el) return
  el.innerHTML = '<img src="' + (hasImg ? BASE + '/api/avatar?ts=' + Date.now() : BASE + '/icon.svg') + '" alt="" />'
}
function refreshAvatar() {
  const el = $('#rail-avatar')
  if (!el) return
  const img = new Image()
  img.onload = () => setAvatar(el, true)
  img.onerror = () => setAvatar(el, false)
  img.src = BASE + '/api/avatar?ts=' + Date.now()
}

function showGate(mode, msg = '') {
  $('#gate').classList.remove('hidden')
  $('#app').classList.add('hidden')
  const wiz = $('#wizard'), form = $('#gate-form')
  wiz.classList.toggle('hidden', mode !== 'setup')
  form.classList.toggle('hidden', mode !== 'login')
  $('#gate-sub').textContent = mode === 'setup' ? '第一次来，先把 Ta 安顿好。' : ''
  $('#gate-hello').textContent = mode === 'login' ? greet() : ''
  if (msg) { (mode === 'setup' ? $('#wizard-msg') : $('#gate-msg')).textContent = msg }
  setAvatar($('#gate-logo'), false)
  applyTitle()
}

const WIZ_LAST = 6
let wizStep = 1
let wizAvatar = null
let wizPersona = 'dafeiyu'

function initWizard() {
  wizStep = 1
  showWizStep(1)
  api('/api/personas').then((r) => {
    personaList = (r.ok && r.personas) || []
    renderWizPersonas()
  })
  api('/api/models').then((r) => {
    models = flattenModels(r.ok ? r.models : [])
    const sel = $('#w-model')
    sel.innerHTML = '<option value="__default__">默认（跟随 DSH）</option>' + models.map((m) => '<option value="' + esc(m.provider + '::' + m.model) + '">' + esc(m.provider + ' / ' + m.model) + '</option>').join('')
  })
  setAvatar($('#w-avatar-preview'), false)

  const form = $('#wizard')
  form.addEventListener('click', (e) => {
    const next = e.target.closest('[data-next]')
    const prev = e.target.closest('[data-prev]')
    if (next && wizStep === 1) {
      // 第 1 步是使用承诺，两条都勾了才放行（不提示文案，静默拦下）
      const p1 = $('#w-pledge-1'), p2 = $('#w-pledge-2')
      if (!p1 || !p1.checked || !p2 || !p2.checked) return
      if (wizStep < WIZ_LAST) showWizStep(wizStep + 1)
      return
    }
    if (next && wizStep < WIZ_LAST) showWizStep(wizStep + 1)
    if (prev && wizStep > 1) showWizStep(wizStep - 1)
  })
  $('#w-avatar').onchange = (e) => {
    const f = e.target.files && e.target.files[0]
    if (!f) return
    const rd = new FileReader()
    rd.onload = () => {
      wizAvatar = { data: String(rd.result).split(',')[1] || '', mime: f.type || 'image/png' }
      const box = $('#w-avatar-preview')
      box.innerHTML = '<img src="' + rd.result + '" alt="" />'
    }
    rd.readAsDataURL(f)
  }
  $('#w-avatar-clear').onclick = () => { wizAvatar = null; setAvatar($('#w-avatar-preview'), false) }
  form.onsubmit = async (e) => {
    e.preventDefault()
    const username = $('#w-username').value.trim()
    const password = $('#w-password').value
    if (password.length < 6) { $('#wizard-msg').textContent = '密码至少 6 位'; return }
    const mv = $('#w-model').value
    const mm = mv && mv !== '__default__' ? mv.split('::') : null
    let personaId = wizPersona
    if (personaId === '__new') {
      const pn = ($('#w-pn-name')?.value || '').trim()
      if (!pn) { $('#wizard-msg').textContent = '先给人设起个名字'; $('#w-pn-name')?.focus(); return }
      const saved = await api('/api/personas/save', {
        method: 'POST',
        body: { name: pn, tags: ($('#w-pn-tags')?.value || '').trim(), body: ($('#w-pn-body')?.value || '').trim() },
      })
      if (!saved.ok) { $('#wizard-msg').textContent = saved.reason || '人设没存上'; return }
      personaId = saved.persona?.id || pn
      personaList = [{id: personaId, name: pn, tags: []}, ...personaList.filter((p) => p.id !== personaId)]
      wizPersona = personaId
    }
    const body = {
      username, password,
      pledge: true, // 第一步承诺（不开播圈钱、不污染社区）已在向导里勾选
      botName: $('#w-name').value.trim() || undefined,
      ownerName: $('#w-owner').value.trim() || undefined,
      persona: wizPersona,
      themeMode: 'follow',
      model: mm ? { provider: mm[0], model: mm.slice(1).join('::'), reasoningEffort: $('#w-effort')?.value || 'low' } : undefined,
      avatar: wizAvatar || undefined,
    }
    const r = await api('/api/setup', { method: 'POST', body })
    if (!r.ok) { $('#wizard-msg').textContent = r.reason || '没建成，再试一次'; return }
    await doLogin(username, password)
  }
}

function renderWizPersonas() {
  const box = $('#w-persona-list')
  if (!box) return
  box.innerHTML = (personaList.length ? personaList.map((p) => (
    '<div class="persona-opt' + (p.id === wizPersona ? ' on' : '') + '" data-pid="' + esc(p.id) + '">' +
    '<b>' + esc(p.name || p.id) + '</b>' +
    '<span>' + esc((p.tags || []).join(' · ')) + '</span></div>'
  )).join('') : '') +
    '<div class="persona-opt new' + (wizPersona === '__new' ? ' on' : '') + '" data-pid="__new">' +
    '<b>＋ 自己写一个</b><span>不用预设，现场告诉Ta该是什么样的人</span></div>'
  box.onclick = (e) => {
    const el = e.target.closest('[data-pid]')
    if (!el) return
    wizPersona = el.dataset.pid
    const custom = $('#w-persona-new')
    if (custom) custom.classList.toggle('hidden', wizPersona !== '__new')
    if (wizPersona === '__new' && $('#w-pn-name')) setTimeout(() => $('#w-pn-name').focus(), 30)
    renderWizPersonas()
  }
}

function showWizStep(n) {
  wizStep = Math.max(1, Math.min(WIZ_LAST, n))
  $$('#wizard .w-step').forEach((s) => s.classList.toggle('hidden', Number(s.dataset.step) !== wizStep))
}

async function doLogin(username, password) {
  const r = await api('/api/login', { method: 'POST', body: { username, password } })
  if (!r.ok) {
    const msg = r.reason || '登录失败'
    if ($('#wizard') && !$('#wizard').classList.contains('hidden')) $('#wizard-msg').textContent = msg
    else $('#gate-msg').textContent = msg
    return false
  }
  setToken(r.token)
  me = { role: r.role, subject: r.subject, name: r.name } || null
  await boot()
  return true
}

async function enterApp() {
  $('#gate').classList.add('hidden')
  $('#app').classList.remove('hidden')
  applyTitle()
  applyFavicon()
  buildNav()
  refreshAvatar()
  bindDebugAvatar($('#rail-avatar'))
  await loadConfig()
  await loadModels()
  await api('/api/status').then((r) => { if (r && r.ok) window._platform = r.platform || 'unknown' }).catch(() => {})
  await api('/api/personas').then((r) => { personaList = (r.ok && r.personas) || [] })
  if (!queryOf('nosse')) connectStream()
  switchView(currentView)
}

const NAVS = [
  { id: 'chat', label: '聊天' },
  { id: 'life', label: '生命', owner: true },
  { id: 'memory', label: '记忆', owner: true },
  { id: 'diary', label: '空间' },
  { id: 'settings', label: '设置' },
  { id: 'logs', label: '日志', owner: true },
]

function buildNav() {
  const nav = $('#nav')
  const items = NAVS.slice()
  if (isOwner() && localStorage.getItem('auralife_debug') === '1') items.push({ id: 'debug', label: '调试' })
  nav.innerHTML = items
    .filter((n) => !n.owner || isOwner())
    .map((n) => '<button data-view="' + n.id + '">' + n.label + '</button>').join('')
  nav.onclick = (e) => { const b = e.target.closest('[data-view]'); if (b) switchView(b.dataset.view) }
  syncNav()
}
function syncNav() { $$('#nav [data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === currentView)) }

const views = {
  life: createLifeView({ $, $$, api, esc, isOwner, toast, paneShell, getCfg: () => cfg, goto: (id) => switchView(id), refresh: loadConfig, refreshAvatar, BASE }),
  logs: createLogsView({ $, api, esc, toast, paneShell }),
}

function switchView(id) {
  currentView = id
  syncNav()
  if (dbgTimer && id !== 'debug') { clearInterval(dbgTimer); dbgTimer = null }
  const main = $('#main')
  main.innerHTML = ''
  if (id === 'chat') renderChat(main)
  else if (id === 'diary') renderDiary(main)
  else if (id === 'life') views.life.renderLife(main)
  else if (id === 'memory') renderMemory(main)
  else if (id === 'settings') renderSettings(main)
  else if (id === 'logs') views.logs.renderLogs(main)
  else if (id === 'debug') renderDebug(main)
}

// 调试台：头像 5 连击 + 1 击确认激活（不依赖 confirm——iframe 里可能被拦），对开发/测试开放破坏性操作。
// 可关闭——开着时用同样方式（5 连击 + 第 6 击确认）关闭。
function bindDebugAvatar(el) {
  if (!el) return
  let taps = 0
  let lastT = 0
  el.addEventListener('click', () => {
    const now = Date.now()
    if (now - lastT > 2500) taps = 0
    lastT = now
    taps++
    if (taps < 5) return
    const on = localStorage.getItem('auralife_debug') === '1'
    if (taps === 5) {
      toast(on ? '再点一下头像，确认关闭调试台' : '再点一下头像，确认打开调试台')
      return
    }
    taps = 0
    if (on) {
      localStorage.setItem('auralife_debug', '0')
      buildNav()
      if (currentView === 'debug') switchView('chat')
      toast('调试台已关闭')
    } else {
      localStorage.setItem('auralife_debug', '1')
      buildNav()
      switchView('debug')
      toast('调试台已开启（左侧栏出现「调试」）')
    }
  })
}

// 调试台页面本身不用 prompt/confirm（DSH iframe 里会被拦）：
//   带参数的操作 → 点按钮展开结构化表单（每字段一个输入框，不用写 JSON）；
//   危险操作 → 两击确认（第一次点按钮变红「再点一次确认」，3 秒内再点才执行）。
let dbgTimer = null

function renderDebug(main) {
  if (dbgTimer) { clearInterval(dbgTimer); dbgTimer = null }
  const body = paneShell(main, '调试台', '<span class="muted" style="font-size:12px">破坏性操作，用于测试与验收</span>')

  const DANGEROUS = new Set(['memory.clear', 'chat.prune', 'wishes.clear', 'alarm.clear'])
  // 带参动作 → 结构化表单（不写 JSON，人可用，）
  const FORMS = {
    'memory.seed': { fields: [
      { k: 'facts', label: '事实（一行一条）', type: 'textarea', def: '测试事实：主人最近喜欢喝热水' },
      { k: 'conf', label: '置信度 0~1', type: 'number', def: '0.7' },
    ], build: (v) => ({ facts: String(v.facts || '').split('\n').map((s) => s.trim()).filter(Boolean).map((text) => ({ text, conf: Number(v.conf) || 0.7 })) }) },
    'memory.forget': { fields: [{ k: 'id', label: '事实 id（快照或记忆页里看）', type: 'text', ph: '贴事实 id' }], build: (v) => ({ id: String(v.id || '').trim() }) },
    'chemistry.set': { fields: [
      { k: 'dopamine', label: '多巴胺（留空=不动）', type: 'number', ph: '0~100' },
      { k: 'cortisol', label: '皮质醇（留空=不动）', type: 'number', ph: '0~100' },
      { k: 'serotonin', label: '血清素（留空=不动）', type: 'number', ph: '0~100' },
    ], build: (v) => { const p = {}; for (const k of ['dopamine', 'cortisol', 'serotonin']) if (v[k] !== '') p[k] = Math.max(0, Math.min(100, Number(v[k]) || 0)); return p } },
    'chemistry.event': { fields: [
      { k: 'dopamine', label: '多巴胺 ±（留空=0）', type: 'number', ph: '-50~50' },
      { k: 'cortisol', label: '皮质醇 ±（留空=0）', type: 'number', ph: '-50~50' },
      { k: 'serotonin', label: '血清素 ±（留空=0）', type: 'number', ph: '-50~50' },
    ], build: (v) => { const d = {}; for (const k of ['dopamine', 'cortisol', 'serotonin']) if (v[k] !== '') d[k] = Math.max(-50, Math.min(50, Number(v[k]) || 0)); return { delta: d } } },
    'energy.set': { fields: [{ k: 'level', label: '体力 0~100', type: 'number', def: '60' }], build: (v) => ({ level: Math.max(0, Math.min(100, Number(v.level) || 0)) }) },
    'wishes.add': { fields: [
      { k: 'text', label: '执念内容', type: 'text', def: 'debug 执念' },
      { k: 'baseTension', label: '初始张力 0~100', type: 'number', def: '80' },
    ], build: (v) => ({ text: String(v.text || ''), baseTension: Math.max(0, Math.min(100, Number(v.baseTension) || 80)) }) },
    'wishes.resolve': { fields: [{ k: 'text', label: '内容关键词或 id（匹配到就了结）', type: 'text', ph: '关键词' }], build: (v) => ({ text: String(v.text || '').trim() }) },
    'self.set': { fields: [
      { k: 'field', label: '字段', type: 'select', opts: [['traits', '性格'], ['values', '看重'], ['boundaries', '底线']] },
      { k: 'label', label: '条目', type: 'text', def: 'debug 条目' },
      { k: 'conf', label: '置信度 0~1', type: 'number', def: '0.7' },
    ], build: (v) => ({ field: v.field || 'traits', entries: [{ label: String(v.label || ''), conf: Number(v.conf) || 0.7 }] }) },
    'self.remove': { fields: [
      { k: 'field', label: '字段', type: 'select', opts: [['traits', '性格'], ['values', '看重'], ['boundaries', '底线']] },
      { k: 'label', label: '要删的条目（完整 label）', type: 'text', ph: '从「列自我」结果里抄' },
    ], build: (v) => ({ field: v.field || 'traits', label: String(v.label || '').trim() }) },
    'alarm.cancel': { fields: [{ k: 'id', label: '闹钟 id（从「列闹钟」结果里抄）', type: 'text', ph: '贴 id' }], build: (v) => ({ id: String(v.id || '').trim() }) },
    'identity.set': { fields: [
      { k: 'name', label: 'Ta 的名字（留空=不动）', type: 'text', ph: '' },
      { k: 'ownerName', label: 'Ta 对你的称呼（留空=不动）', type: 'text', ph: '' },
      { k: 'body', label: '底色（整段替换，留空=不动）', type: 'textarea', ph: '' },
    ], build: (v) => { const p = {}; if (v.name !== '') p.name = String(v.name); if (v.ownerName !== '') p.ownerName = String(v.ownerName); if (v.body !== '') p.body = String(v.body); return p } },
    'alarm.set': { fields: [
      { k: 'in_minutes', label: '几分钟后响', type: 'number', def: '1' },
      { k: 'reason', label: '理由', type: 'text', def: 'debug 闹钟' },
    ], build: (v) => ({ in_minutes: Math.max(0, Number(v.in_minutes) || 1), reason: String(v.reason || 'debug 闹钟') }) },
    'chat.inject': { fields: [
      { k: 'who', label: '身份', type: 'select', opts: [['user', '用户'], ['bot', 'Ta']] },
      { k: 'text', label: '内容', type: 'textarea', def: 'debug 假消息' },
    ], build: (v) => ({ who: v.who || 'user', text: String(v.text || '') }) },
  }
  const ACTS = [
    ['memory', '记忆', [['seed', '种入测试事实'], ['forget', '忘掉一条（给 id）'], ['list', '列事实'], ['consolidate', '整理对话（调模型）'], ['replay', '记忆重放（调模型）'], ['clear', '清空（危险）']]],
    ['chemistry', '三激素', [['set', '设数值'], ['reset', '回基线'], ['event', '注入事件']]],
    ['energy', '体力', [['set', '设数值'], ['reset', '重置'], ['spend', '扣一点']]],
    ['wishes', '执念', [['list', '列执念'], ['add', '加一条'], ['resolve', '了结一条'], ['clear', '清空（危险）']]],
    ['self', '自我', [['list', '列自我'], ['set', '设条目'], ['remove', '删一条'], ['reset', '回滚出厂']]],
    ['identity', '人格', [['set', '设身份'], ['reset', '清空回种子']]],
    ['alarm', '闹钟', [['list', '列闹钟'], ['set', '设一个'], ['cancel', '取消一个'], ['clear', '清空（危险）']]],
    ['chat', '聊天记录', [['inject', '注入消息'], ['prune', '清空（危险）']]],
  ]

  body.innerHTML =
    '<div class="section"><h3>操作结果</h3><div class="body"><pre id="dbg-out" style="font-size:12px;white-space:pre-wrap;max-height:300px;overflow:auto"></pre></div></div>' +
    '<div class="section"><h3>状态快照（5 秒自动刷新）</h3><div class="body">' +
    '<pre id="dbg-state" style="font-size:12px;white-space:pre-wrap;max-height:400px;overflow:auto"></pre>' +
    '<div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">' +
    '<button class="ghost" id="dbg-state-refresh">立即刷新</button>' +
    '<button class="ghost" data-test="drive">叫 Ta 一次（调模型）</button>' +
    '<button class="ghost" data-test="diary">让 Ta 写日记（调模型）</button>' +
    '<button class="ghost" data-test="social">跑一轮社交（调模型）</button>' +
    '</div></div></div>' +
    '<p class="muted" style="font-size:12px;padding:0 12px">只有标「（调模型）」的会烧 token：整理对话、记忆重放、叫 Ta 一次、写日记、社交。其余全是确定性操作，不烧。危险操作连点两次确认。带参操作点按钮展开表单，不用写 JSON。</p>' +
    ACTS.map(([mod, title, acts]) => '<div class="section"><h3>' + title + '</h3><div class="body">' +
      acts.map(([act, label]) => '<button class="ghost" data-dbg="' + mod + '.' + act + '">' + label + '</button>').join('') +
      '</div></div>').join('')

  // —— 状态快照 ——
  const fmt = (t) => (t ? new Date(t).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—')
  const fx = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 10) / 10 : v)
  async function refreshDbgState() {
    const out = $('#dbg-state')
    if (!out) return
    const [l, sf] = await Promise.all([api('/api/life'), api('/api/self')])
    if (!l.ok) { out.textContent = '读不到 /api/life（未登录或接口挂了）'; return }
    const c = l.chemistry || {}
    const en = l.energy || {}
    const wl = Array.isArray(l.wishes) ? l.wishes : []
    const openW = wl.filter((w) => w.status === 'open')
    const closedN = wl.length - openW.length
    const al = (l.alarms || []).filter((a) => !a.fired)
    const selfList = sf.ok && sf.self ? sf.self : null
    const selfCount = Array.isArray(selfList) ? selfList.length : (selfList ? ((selfList.traits || []).length + (selfList.values || []).length + (selfList.boundaries || []).length) : 0)
    const idn = l.identity || {}
    const mem = l.memory || {}
    const d = l.drive || {}
    const ctx = l.context || null
    const chemHist = (c.history || []).slice(0, 8).map((h) => fmt(h.at) + '  ' + (h.dopamine >= 0 ? '+' : '') + fx(h.dopamine) + '/' + (h.cortisol >= 0 ? '+' : '') + fx(h.cortisol) + '/' + (h.serotonin >= 0 ? '+' : '') + fx(h.serotonin) + '  ' + (h.reason || '')).join('\n')
    const lines = [
      '内分泌  多巴胺 ' + fx(c.dopamine ?? 50) + ' · 皮质醇 ' + fx(c.cortisol ?? 20) + ' · 血清素 ' + fx(c.serotonin ?? 50) + '（基线 50/20/50，半衰 25/90/180 分钟）',
      chemHist ? '  最近事件：\n' + chemHist.split('\n').map((x) => '    ' + x).join('\n') : '  最近事件：（没有）',
      '体力    ' + Math.round(en.level ?? 100) + '/100',
      '执念    未了 ' + openW.length + ' 条 · 已了结 ' + closedN + ' 条',
      ...openW.slice(0, 6).map((w) => '  ・' + w.text + '（想念 ' + fx(w.tension ?? 0) + '/100 · 基础 ' + fx(w.baseTension ?? 0) + '）' + (w.id ? '  #' + String(w.id).slice(0, 8) : '')),
      '闹钟    ' + al.length + ' 个未响' + (al.length ? '：' + al.slice(0, 4).map((a) => fmt(a.at) + ' ' + (a.reason || '')).join('；') : ''),
      '自我    ' + selfCount + ' 条' + (selfList && selfList.version != null ? ' · v' + selfList.version : ''),
      '身份    ' + (idn.name ? idn.name + ' · 叫你「' + (idn.ownerName || '') + '」' : '还没改（用出厂种子）') + (idn.body ? ' · 底色已自定' : ''),
      '记忆    ' + (mem.currentFacts ?? 0) + ' 条生效 · ' + (mem.episodes ?? 0) + ' 事件 · ' + (mem.edges ?? 0) + ' 联想',
      '主动搭话  今日 ' + (d.count ?? 0) + ' 次' +
        (d.lastAssess ? ' · 最近评估 ' + fmt(d.lastAssess.at) + ' ' + (d.lastAssess.awake ? '醒着' : '在睡') + ' 冲动 ' + d.lastAssess.urge + '/100' : ' · 还没评估过') +
        (d.lastSpokeAt ? ' · 上次开口 ' + fmt(d.lastSpokeAt) + (d.coldMarked ? ' · 已记「被冷落」' : '') : '') +
        (d.inQuiet ? ' · ⚠ 睡眠时段' : ' · 醒着时段') + '（阈值 ' + (d.threshold ?? 55) + '）',
      ctx ? '上下文  ' + ctx.ratio + '% (估算 ' + ctx.tokens + '/' + ctx.window + ')' + (ctx.ratio >= 85 ? ' ⚠ 快满了' : '') : '',
      l.boot && l.boot.at ? '代码    ' + fmt(l.boot.at) + ' 加载' : '代码    ⚠ 旧版（DSH 没重启，新代码没生效）',
    ].filter((x) => x !== '')
    out.textContent = lines.join('\n')
  }
  refreshDbgState()
  dbgTimer = setInterval(refreshDbgState, 5000)
  const refreshBtn = $('#dbg-state-refresh')
  if (refreshBtn) refreshBtn.onclick = refreshDbgState
  // 测试按钮（调模型类，走 /api/test）
  body.querySelectorAll('[data-test]').forEach((tb) => {
    tb.onclick = async () => {
      tb.disabled = true
      const r = await api('/api/test', { method: 'POST', body: { what: tb.dataset.test } })
      tb.disabled = false
      const out = $('#dbg-out')
      if (out) out.textContent = JSON.stringify(r, null, 2)
      toast(r.ok ? '跑完了' : (r.reason || '失败'), r.ok ? '' : 'err')
      refreshDbgState()
    }
  })

  // —— 执行一个 debug 动作 ——
  async function runDbg(mod, act, payload) {
    const r = await api('/api/debug', { method: 'POST', body: { module: mod, action: act, ...payload } })
    const out = $('#dbg-out')
    if (out) out.textContent = JSON.stringify(r, null, 2)
    toast(r.ok ? mod + '.' + act + ' 完成' : (r.reason || '失败'), r.ok ? '' : 'err')
    refreshDbgState()
    return r
  }

  function arm(btn) {
    btn.dataset.armed = '1'
    btn.classList.add('danger')
    btn.textContent = '再点一次确认'
    btn._armT = setTimeout(() => unarm(btn), 3000)
  }
  function unarm(btn) {
    delete btn.dataset.armed
    btn.classList.remove('danger')
    const [mod, act] = btn.dataset.dbg.split('.')
    const label = (ACTS.find(([m]) => m === mod)?.[2] || []).find(([a]) => a === act)?.[1] || act
    btn.textContent = label
  }

  body.onclick = async (e) => {
    const b = e.target.closest('[data-dbg]')
    if (!b) return
    e.stopPropagation()
    const key = b.dataset.dbg
    const [mod, act] = key.split('.')

    // 危险操作：两击确认（不依赖 confirm）
    if (DANGEROUS.has(key)) {
      if (b.dataset.armed === '1') {
        clearTimeout(b._armT)
        b.disabled = true
        await runDbg(mod, act)
        b.disabled = false
        unarm(b)
        return
      }
      arm(b)
      return
    }
    // 带参操作：展开结构化表单（不写 JSON）
    if (FORMS[key]) {
      const row = document.getElementById('dbg-args-' + key.replace('.', '-'))
      if (row) { row.remove(); return } // 再点一次收起
      const wrap = b.closest('.body') || b.parentElement
      const spec = FORMS[key]
      const div = document.createElement('div')
      div.id = 'dbg-args-' + key.replace('.', '-')
      div.style.cssText = 'margin-top:10px;display:flex;flex-direction:column;gap:8px;max-width:560px'
      div.innerHTML = spec.fields.map((f) => {
        if (f.type === 'textarea') {
          return '<label style="font-size:12px">' + esc(f.label) + '<br><textarea rows="3" data-k="' + f.k + '" placeholder="' + esc(f.ph || '') + '" style="width:100%;font-size:12px;font-family:inherit">' + esc(f.def || '') + '</textarea></label>'
        }
        if (f.type === 'select') {
          return '<label style="font-size:12px">' + esc(f.label) + '<br><select data-k="' + f.k + '" style="font-size:12px">' + f.opts.map(([v, l]) => '<option value="' + esc(v) + '">' + esc(l) + '</option>').join('') + '</select></label>'
        }
        return '<label style="font-size:12px">' + esc(f.label) + '<br><input data-k="' + f.k + '" type="' + f.type + '" value="' + esc(f.def ?? '') + '" placeholder="' + esc(f.ph || '') + '" style="font-size:12px;width:100%;max-width:340px"></label>'
      }).join('') + '<div style="display:flex;gap:8px"><button class="primary">执行</button><button class="ghost">取消</button></div>'
      wrap.appendChild(div)
      const go = div.querySelector('.primary')
      go.onclick = async () => {
        const vals = {}
        div.querySelectorAll('[data-k]').forEach((el) => { vals[el.dataset.k] = el.value })
        let payload
        try { payload = spec.build(vals) } catch (err) { toast('参数不对：' + err.message, 'err'); return }
        if (payload && typeof payload === 'object' && Object.keys(payload).length === 0 && key === 'identity.set') { toast('全留空了，等于不改。想清空请用「清空回种子」。', 'err'); return }
        go.disabled = true
        await runDbg(mod, act, payload)
        div.remove()
      }
      div.querySelector('.ghost').onclick = () => div.remove()
      return
    }
    // 无参操作：直接执行
    b.disabled = true
    await runDbg(mod, act)
    b.disabled = false
  }
}

async function loadConfig() {
  if (!isOwner()) return
  const r = await api('/api/config')
  if (r.ok) {
    cfg = r.config
    applyTheme()
    const hn = $('#head-name')
    if (hn) hn.textContent = bot()
  }
}
async function loadModels() {
  const r = await api('/api/models')
  models = flattenModels(r.ok ? r.models : [])
}
function flattenModels(raw) {
  const out = []
  const push = (x) => { if (x && x.model) out.push({ provider: x.provider || '', model: x.model }) }
  if (!Array.isArray(raw)) return out
  for (const x of raw) {
    if (!x) continue
    if (Array.isArray(x.models)) { for (const m of x.models) push({ provider: x.provider, model: typeof m === 'string' ? m : m.model || m.id }) }
    else push(x)
  }
  return out
}
function splitModelValue(v) {
  const s = String(v || '')
  const i = s.indexOf('::')
  if (i < 0) return { provider: '', model: '' }
  return { provider: s.slice(0, i), model: s.slice(i + 2) }
}

function renderChat(main) {
  main.innerHTML =
    '<div class="chat">' +
    '<div class="chat-head"><span class="name" id="head-name"></span></div>' +
    '<div class="msgs" id="msgs"></div>' +
    '<div class="typing" id="typing"></div>' +
    '<div class="composer">' +
    '<div class="composer-tools"><button class="tool" id="tool-image">图片</button>' +
    '<button class="tool" id="tool-sticker">表情</button>' +
    '<button class="tool" id="tool-voice">语音</button>' +
    '<button class="tool" id="tool-file">＋ 文件</button></div>' +
    '<div class="composer-row"><textarea id="input" rows="1" placeholder="说点什么…（回车发送，Shift+回车换行）"></textarea>' +
    '<button class="primary" id="send">发送</button></div>' +
    '<input type="file" id="image-file" accept="image/*" hidden />' +
    '<input type="file" id="file-upload" multiple hidden />' +
    '</div></div>'
  $('#head-name').textContent = bot()
  $('#send').onclick = sendText
  $('#input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText() } })
  let pingTimer = null
  let lastPing = 0
  $('#input').addEventListener('input', () => {
    const now = Date.now()
    if (now - lastPing < 2000) return
    lastPing = now
    api('/api/typing', { method: 'POST', body: { typing: true } }).catch(() => {})
    clearTimeout(pingTimer)
    pingTimer = setTimeout(() => { lastPing = 0 }, 3000)
  })
  $('#tool-image').onclick = () => $('#image-file').click()
  $('#image-file').onchange = sendImage
  $('#tool-file').onclick = () => $('#file-upload').click()
  $('#file-upload').onchange = sendFiles
  $('#tool-sticker').onclick = (e) => openStickerPicker(e.currentTarget)
  setupVoiceButton()
  loadMessages()
}

async function loadMessages() {
  // 一个分片文件 = 一页：首屏只渲染最新那片，往上翻才取上一片
  const r = await api('/api/messages?file=last')
  const box = $('#msgs')
  if (!box) return
  box.innerHTML = ''
  historyState = { oldestAt: 0, hasMore: false, loading: false, index: 0, total: 0 }
  if (!r.ok) { box.innerHTML = '<div class="empty">读不到消息：' + esc(r.reason || '') + '</div>'; return }
  const list = r.messages || []
  if (r.file) { historyState.index = Number(r.file.index) || 0; historyState.total = Number(r.file.total) || 0 }
  if (!list.length) { box.innerHTML = '<div class="empty">还没说过话。打个招呼吧。</div>'; return }
  for (const m of list) appendMessage(m, false)
  historyState.oldestAt = r.oldestAt || (list[0] && list[0].t) || 0
  historyState.hasMore = Boolean(r.hasMore)
  renderHistoryMore()
  scrollDown()
}

// 「查看更早的记录」按钮：只在还有更早的消息时出现，位置固定在列表最上面
function renderHistoryMore() {
  const box = $('#msgs')
  if (!box) return
  const old = box.querySelector('.more-history')
  if (old) old.remove()
  if (!historyState.hasMore) return
  const btn = document.createElement('button')
  btn.className = 'more-history'
  // 一个文件就是一页
  btn.textContent = '查看更早的记录'
  btn.onclick = () => loadOlder(btn)
  box.insertBefore(btn, box.firstChild)
}

async function loadOlder(btn) {
  if (historyState.loading) return
  historyState.loading = true
  if (btn) { btn.textContent = '正在取…'; btn.disabled = true }
  const box = $('#msgs')
  const keep = box ? box.scrollHeight - box.scrollTop : 0
  const r = await api('/api/messages?file=prev&before=' + encodeURIComponent(historyState.oldestAt || 0))
  historyState.loading = false
  if (!r || !r.ok) {
    if (btn) { btn.textContent = '查看更早的记录'; btn.disabled = false }
    return toast(r?.reason || '没取到更早的记录', 'err')
  }
  const list = r.messages || []
  if (r.file) { historyState.index = Number(r.file.index) || 0; historyState.total = Number(r.file.total) || 0 }
  if (r.oldestAt) historyState.oldestAt = r.oldestAt
  if (!list.length) historyState.hasMore = false
  else historyState.hasMore = Boolean(r.hasMore)
  if (box) {
    const more = box.querySelector('.more-history')
    if (more) more.remove()
    // 从后往前插到最前面，保证 DOM 顺序和原来的列表一致
    for (let i = list.length - 1; i >= 0; i--) prependMessage(list[i])
    reflowDaySeparators()
    box.scrollTop = box.scrollHeight - keep
  }
  renderHistoryMore()
}

function mediaUrl(m) {
  if (!m || !m.mediaId) return ''
  return BASE + '/api/media/' + encodeURIComponent(m.mediaId) + '?token=' + encodeURIComponent(token)
}

function fmtSize(n) {
  n = Number(n) || 0
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  return (n / 1024 / 1024).toFixed(1) + ' MB'
}

function buildMessageNode(m) {
  const mine = m.who === 'user'
  const wrap = document.createElement('div')
  wrap.className = 'msg ' + (mine ? 'me' : 'her')
  wrap.dataset.t = String(m.t || '')
  if (m.id) wrap.dataset.id = String(m.id)
  let inner = ''
  if (m.kind === 'voice') {
    const src = m.mediaId ? mediaUrl(m) : (m.voice ? 'data:' + (m.voiceMime || 'audio/mpeg') + ';base64,' + m.voice : '')
    inner = src
      ? '<div class="voice-bar" data-vid="' + esc(m.id || '') + '">' +
        '<button class="vb-play" data-voice-play aria-label="播放"></button>' +
        '<span class="vb-bars">' + BARS + '</span>' +
        '<span class="vb-dur">' + (m.dur ? fmtDur(m.dur) : '') + '</span>' +
        '<audio preload="metadata" src="' + src + '"></audio></div>' +
        (m.heard ? '<div class="heard">听成了：' + esc(m.heard) + '</div>' : '')
      : (m.heard ? '<div class="heard">听成了：' + esc(m.heard) + '</div>' : esc(m.text || '[语音已过期]'))
  } else if (m.kind === 'sticker') {
    inner = '<img src="' + BASE + '/api/sticker/' + esc(m.sticker) + '" alt="' + esc(m.name || '表情') + '" />'
  } else if (m.kind === 'image') {
    const src = m.mediaId ? mediaUrl(m) : (m.image ? 'data:' + (m.imageMime || 'image/png') + ';base64,' + m.image : '')
    inner = src ? '<img src="' + src + '" alt="图片" />' : '<span class="expired">图片已经过期了</span>'
  } else if (m.kind === 'file') {
    const url = m.mediaId ? mediaUrl(m) : ''
    inner = '<span class="file-chip">📎 ' + esc(m.fileName || '文件') + (m.bytes ? ' · ' + fmtSize(m.bytes) : '') +
      (url ? ' <a href="' + url + '" download="' + esc(m.fileName || '文件') + '">下载</a>' : '') + '</span>'
  } else {
    inner = esc(m.text || '')
  }
  if (mine && m.kind === 'image' && cfg?.stickers?.steal !== false) inner += '<button class="collect" data-collect="' + esc(m.id || '') + '">收进表情库</button>'
  wrap.innerHTML = (mine ? '' : '<div class="sender">' + esc(bot()) + '</div>') +
    '<div class="bubble"><div class="body">' + inner + '</div><span class="meta">' + esc(fmtClock(m.t)) + '</span></div>'
  return wrap
}

// 日期分隔条：同一天的消息只标一个「今天 / 昨天 / 日期」
function daySepNode(t) {
  const el = document.createElement('div')
  el.className = 'day-sep'
  el.textContent = dayLabel(t)
  return el
}

// 按 DOM 里消息的实际顺序重排日期分隔条（追加 / 前插 / 过期裁剪后都调一次）
function reflowDaySeparators() {
  const box = $('#msgs')
  if (!box) return
  box.querySelectorAll('.day-sep').forEach((el) => el.remove())
  let prev = ''
  box.querySelectorAll('.msg').forEach((el) => {
    const k = dayKey(Number(el.dataset.t || 0))
    if (k !== prev) { box.insertBefore(daySepNode(Number(el.dataset.t || 0)), el); prev = k }
  })
}

function appendMessage(m, scroll = true) {
  const box = $('#msgs')
  if (!box) return
  if (m?.id && box.querySelector('[data-id="' + cssId(m.id) + '"]')) return
  const empty = box.querySelector('.empty')
  if (empty) empty.remove()
  box.appendChild(buildMessageNode(m))
  reflowDaySeparators()
  if (scroll) scrollDown()
}

// 消息 id 里可能有特殊字符，塞进属性选择器前先转义
function cssId(id) { return String(id).replace(/["\\]/g, '\\$&') }

// 往前翻页时插到「查看更早」按钮的后面（按钮永远在最上面）
function prependMessage(m) {
  const box = $('#msgs')
  if (!box) return
  if (m?.id && box.querySelector('[data-id="' + cssId(m.id) + '"]')) return
  const more = box.querySelector('.more-history')
  box.insertBefore(buildMessageNode(m), more ? more.nextSibling : box.firstChild)
}

function scrollDown() { const box = $('#msgs'); if (box) box.scrollTop = box.scrollHeight }
function setTyping(on) { const t = $('#typing'); if (t) t.textContent = on ? bot() + ' 正在输入…' : '' }

async function sendText() {
  const inp = $('#input')
  const text = inp.value.trim()
  if (!text) return
  inp.value = ''
  inp.style.height = 'auto'
  api('/api/typing', { method: 'POST', body: { typing: false } }).catch(() => {})
  const r = await api('/api/messages', { method: 'POST', body: { text } })
  if (!r.ok) toast(r.reason || '没发出去', 'err')
  else playSound('out')
}

async function sendImage(e) {
  const f = e.target.files && e.target.files[0]
  e.target.value = ''
  if (!f) return
  // 从「图片」入口选了非图片文件 → 转走文件确认流程（用户常从图片按钮发文件）
  if (f.type && !f.type.startsWith('image/')) return confirmAndSendFiles([f])
  if (f.size > 10 * 1024 * 1024) return toast('图片太大了（最多 10MB）', 'err')
  const rd = new FileReader()
  rd.onload = async () => {
    const data = String(rd.result).split(',')[1] || ''
    const r = await api('/api/messages', { method: 'POST', body: { text: '', images: [{ data, mediaType: f.type || 'image/png', name: f.name }] } })
    if (!r.ok) toast(r.reason || r.message || '没发出去', 'err')
  }
  rd.readAsDataURL(f)
}

// 「＋ 文件」：任意后缀文件（///）。不设业务上限，选完先弹确认框列每个文件大小，
// 确认后才发。唯一硬限制 = 后端请求体 32MB（base64），约 24MB 原文件。
// 真凶：e.target.files 是「活的」FileList，先清空 input 会让它变空 → 永远静默 return。
// 必须先把文件展开成数组快照再清空。
async function sendFiles(e) {
  const list = e.target.files ? [...e.target.files] : []
  e.target.value = ''
  if (!list.length) return
  return confirmAndSendFiles(list)
}

async function confirmAndSendFiles(list) {
  const items = []
  try {
    for (const f of list) {
      const data = await new Promise((res) => { const rd = new FileReader(); rd.onload = () => res(String(rd.result || '').split(',')[1] || ''); rd.onerror = () => res(''); rd.readAsDataURL(f) })
      if (!data) { toast(f.name + ' 读不出来', 'err'); continue }
      items.push({ f, data, mime: f.type || 'application/octet-stream' })
    }
    if (!items.length) return
    const totalRaw = items.reduce((n, i) => n + i.f.size, 0)
    const totalB64 = items.reduce((n, i) => n + i.data.length, 0)
    showFileConfirm(items, totalRaw, totalB64)
  } catch (err) {
    // 任何异常都变成可见红字，别静默吞掉（排查）
    toast('文件读取出错了：' + (err && err.message ? err.message : String(err)), 'err')
    console.error('confirmAndSendFiles 失败', err)
  }
}

// 发送前确认：逐个列文件名与大小 + 总计，点「发送」才真发。不用 confirm()（DSH 内嵌页会拦）。
function showFileConfirm(items, totalRaw, totalB64) {
  const HARD_B64 = 30 * 1024 * 1024 // 请求体 32MB 的安全边际
  const over = totalB64 > HARD_B64
  const rows = items.map((i) => '<div class="fc-row"><span class="fc-name">📎 ' + esc(i.f.name) + '</span><span>' + fmtSize(i.f.size) + '</span></div>').join('')
  const ov = document.createElement('div')
  ov.className = 'file-confirm-mask'
  ov.innerHTML = '<div class="file-confirm"><div class="fc-t">把这些文件发给 Ta？</div>' + rows +
    '<div class="fc-row fc-total"><span>一共 ' + items.length + ' 个</span><span>' + fmtSize(totalRaw) + '</span></div>' +
    (over ? '<div class="fc-warn">超过传输上限（约 24MB），发不了。拆开发或换小的。</div>' : '') +
    '<div class="fc-acts"><button class="ghost" data-fc="cancel">取消</button><button class="primary" data-fc="ok"' + (over ? ' disabled' : '') + '>发送</button></div></div>'
  document.body.appendChild(ov)
  ov.querySelector('[data-fc="cancel"]').onclick = () => ov.remove()
  ov.querySelector('[data-fc="ok"]').onclick = async () => {
    ov.remove()
    const images = []
    const files = []
    for (const i of items) {
      if (i.mime.startsWith('image/')) images.push({ data: i.data, mediaType: i.mime, name: i.f.name })
      else files.push({ data: i.data, mediaType: i.mime, name: i.f.name })
    }
    const r = await api('/api/messages', { method: 'POST', body: { text: '', images, files } })
    if (!r.ok) toast(r.reason || r.message || '没发出去', 'err')
    else playSound('out')
  }
  ov.addEventListener('click', (e2) => { if (e2.target === ov) ov.remove() })
}

function connectStream() {
  if (stream) stream.close()
  stream = new EventSource(BASE + '/api/stream?token=' + encodeURIComponent(token))
  stream.onmessage = (e) => {
    let ev
    try { ev = JSON.parse(e.data) } catch (err) { return }
    if (ev.type === 'message') {
      const m = ev.message || {}
      if (m.who === 'bot') playSound('in')
      if (!ev.chatId || !me || String(ev.chatId) === String(me.subject)) {
        if (currentView === 'chat') appendMessage(m)
      }
    } else if (ev.type === 'typing') {
      if (currentView === 'chat') setTyping(Boolean(ev.on))
    } else if (ev.type === 'history') {
      // 服务端过期清理 / 分片边界变了：把客户端里比 droppedBefore 更早的气泡也删掉
      if (!ev.chatId || !me || String(ev.chatId) === String(me.subject)) {
        const before = Number(ev.droppedBefore || 0)
        const box = $('#msgs')
        if (before > 0 && box) {
          box.querySelectorAll('.msg[data-t]').forEach((el) => { if (Number(el.dataset.t) < before) el.remove() })
          reflowDaySeparators()
          historyState.oldestAt = Math.max(historyState.oldestAt || 0, before)
        }
        if (typeof ev.hasMore === 'boolean') historyState.hasMore = ev.hasMore
        if (currentView === 'chat') renderHistoryMore()
      }
    } else if (ev.type === 'azone') {
      // 空间有新动静（Ta 回了留言等），在空间页就原地刷新，不用切页面
      if (currentView === 'diary') loadDiary()
    }
  }
  stream.onerror = () => {}
}

async function startPcmRecording(btn) {
  const s = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
  const AC = window.AudioContext || window.webkitAudioContext
  if (!AC) { s.getTracks().forEach((t) => t.stop()); throw Object.assign(new Error('这个浏览器不支持录音'), { name: 'NotSupportedError' }) }
  const ctx = new AC()
  const rate = ctx.sampleRate
  const src = ctx.createMediaStreamSource(s)
  const proc = ctx.createScriptProcessor(4096, 1, 1)
  const parts = []
  let frames = 0
  proc.onaudioprocess = (e) => { const d = e.inputBuffer.getChannelData(0); parts.push(new Float32Array(d)); frames += d.length }
  src.connect(proc)
  proc.connect(ctx.destination)
  const started = Date.now()
  let done = false
  let auto = null
  btn.classList.add('recording'); btn.textContent = '停止'
  const stop = async () => {
    if (done) return
    done = true
    clearTimeout(auto)
    btn.classList.remove('recording'); btn.textContent = '语音'
    try {
      proc.onaudioprocess = null
      src.disconnect(); proc.disconnect()
      s.getTracks().forEach((t) => t.stop())
      await ctx.close()
    } catch (e) {}
    const dur = Math.min(60, Math.max(1, Math.round((Date.now() - started) / 1000)))
    if (frames < rate * 0.2) { toast('太短了，再按一次重说'); return }
    const blob = encodeWav(parts, frames, rate)
    const rd = new FileReader()
    rd.onload = async () => {
      const data = String(rd.result).split(',')[1] || ''
      const r = await api('/api/messages', { method: 'POST', body: { text: '', voice: { data, mime: 'audio/wav', dur } } })
      if (!r.ok) toast(r.reason || '语音没发出去', 'err')
    }
    rd.readAsDataURL(blob)
  }
  auto = setTimeout(stop, 60_000)
  return { stop }
}

function pickAudioFile() {
  const inp = document.createElement('input')
  inp.type = 'file'
  inp.accept = 'audio/*'
  inp.onchange = () => {
    const f = inp.files && inp.files[0]
    if (!f) return
    if (f.size > 12 * 1024 * 1024) return toast('音频太大了（最多 12MB）', 'err')
    const url = URL.createObjectURL(f)
    const a = new Audio()
    a.preload = 'metadata'
    a.onloadedmetadata = () => {
      const dur = Math.min(60, Math.max(1, Math.round(a.duration || 1)))
      const rd = new FileReader()
      rd.onload = async () => {
        const data = String(rd.result).split(',')[1] || ''
        const r = await api('/api/messages', { method: 'POST', body: { text: '', voice: { data, mime: f.type || 'audio/wav', dur } } })
        toast(r.ok ? '发出去了' : (r.reason || '没发出去'), r.ok ? '' : 'err')
      }
      rd.readAsDataURL(f)
      URL.revokeObjectURL(url)
    }
    a.onerror = () => toast('这个音频读不出来', 'err')
    a.src = url
  }
  inp.click()
}

function openInBrowser() {
  const url = location.origin + location.pathname + '?token=' + encodeURIComponent(token || '')
  let w = null
  try { w = window.open(url, '_blank') } catch (e) {}
  if (!w && navigator.clipboard) {
    navigator.clipboard.writeText(url).then(() => toast('弹窗被拦了，地址已复制，粘到浏览器里打开'), () => toast('弹窗被拦了', 'err'))
  }
  return w
}

function setupVoiceButton() {
  const btn = $('#tool-voice')
  if (!btn) return
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { btn.title = '这个环境不支持录音'; return }
  let rec = null
  btn.onclick = async () => {
    if (rec) { await rec.stop(); rec = null; return }
    try {
      rec = await startPcmRecording(btn)
    } catch (e) {
      rec = null
      const name = (e && e.name) || ''
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
        toast('当前窗口没有麦克风权限，请在浏览器中打开后再录音', 'err')
        setTimeout(() => confirmAction('用新窗口打开 AuraLife 再录？（这个窗口留着不动）', openInBrowser), 250)
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        toast('没找到麦克风', 'err')
      } else {
        toast('麦克风打不开：' + ((e && e.message) || name || '未知原因'), 'err')
        pickAudioFile()
      }
    }
  }
}

function confirmAction(text, onOk) {
  const box = document.createElement('div')
  box.className = 'mini-confirm'
  box.innerHTML = '<div>' + esc(text) + '</div><div class="mc-row"><button class="primary small" data-ok>好</button><button class="ghost small" data-no>算了</button></div>'
  document.body.appendChild(box)
  const close = () => box.remove()
  box.querySelector('[data-no]').onclick = close
  box.querySelector('[data-ok]').onclick = () => { close(); onOk() }
  return box
}

async function openStickerPicker(anchor) {
  const old = $('.sticker-picker')
  if (old) { old.remove(); return }
  const r = await api('/api/stickers')
  const items = (r.ok && r.items) || []
  const box = document.createElement('div')
  box.className = 'sticker-picker'
  const empty = !items.length
  if (empty) {
    box.classList.add('is-empty')
    box.style.width = '236px'
    box.innerHTML = '<div class="empty sticker-empty"><div>表情库还是空的</div>' +
      '<button class="btn-sm" id="go-sticker-settings">去设置里传几张</button></div>'
  } else {
    box.innerHTML = items.map((i) => '<button class="sticker-opt" data-md5="' + esc(i.md5) + '" title="' + esc(i.name || '还没起名') + '">' +
      '<img src="' + BASE + '/api/sticker/' + esc(i.md5) + '" alt="" />' +
      (i.name ? '<i class="sticker-opt-name">' + esc(i.name) + '</i>' : '') + '</button>').join('')
  }
  box.style.visibility = 'hidden'
  box.style.left = '0px'
  box.style.top = '0px'
  document.body.appendChild(box)
  const rect = anchor.getBoundingClientRect()
  const bw = box.offsetWidth || 256
  const bh = box.offsetHeight || 200
  let left = rect.left + rect.width / 2 - bw / 2
  left = Math.max(8, Math.min(left, window.innerWidth - bw - 8))
  let top = empty ? rect.bottom + 8 : rect.top - bh - 10
  if (top + bh > window.innerHeight - 8) top = Math.max(8, Math.min(rect.bottom + 8, window.innerHeight - bh - 8))
  if (top < 8) top = Math.max(8, Math.min(rect.bottom + 10, window.innerHeight - bh - 8))
  box.style.left = left + 'px'
  box.style.top = top + 'px'
  box.style.visibility = ''
  const go = $('#go-sticker-settings', box)
  if (go) go.onclick = () => {
    box.remove()
    switchView('settings')
    setTimeout(() => {
      const grid = $('#sticker-grid')
      grid?.closest('.section')?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }, 60)
  }
  box.onclick = async (e) => {
    const b = e.target.closest('[data-md5]')
    if (!b) return
    box.remove()
    const res = await api('/api/messages', { method: 'POST', body: { text: '', sticker: b.dataset.md5 } })
    if (!res.ok) toast(res.reason || '没发出去', 'err')
  }
  setTimeout(() => document.addEventListener('click', function h(ev) { if (!box.contains(ev.target)) { box.remove(); document.removeEventListener('click', h) } }), 0)
}

document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-collect]')
  if (!b) return
  const img = b.closest('.bubble')?.querySelector('img')
  if (!img) return
  const src = img.getAttribute('src') || ''
  const data = await imageBase64(src)
  if (!data) return toast('这张图存不下来', 'err')
  const r = await api('/api/stickers/upload', { method: 'POST', body: { data, from: 'steal', hint: '' } })
  toast(r.ok ? '收进表情库了' : (r.reason || '没收成'), r.ok ? '' : 'err')
})

// 图片可能是内联 data:，也可能是 /api/media/... 的地址，统一转成 base64 再传
async function imageBase64(src) {
  if (!src) return ''
  if (src.startsWith('data:')) { const i = src.indexOf(','); return i >= 0 ? src.slice(i + 1) : '' }
  try {
    const buf = await (await fetch(src)).arrayBuffer()
    const bytes = new Uint8Array(buf)
    let bin = ''
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
    return btoa(bin)
  } catch { return '' }
}

function paneShell(main, title, headRight) {
  main.innerHTML = '<div class="pane"><div class="pane-head"><h2>' + esc(title) + '</h2><span class="spacer"></span>' + (headRight || '') + '</div><div class="pane-body" id="pane-body"></div></div>'
  return $('#pane-body')
}

function renderDiary(main) {
  paneShell(main, '空间', '<span class="count" id="diary-count"></span>')
  loadDiary()
}

async function loadDiary() {
  const r = await api('/api/diary')
  const body = $('#pane-body')
  if (!body) return
  const st = (r.ok && r.stats) || {}
  const cnt = $('#diary-count')
  if (cnt) cnt.textContent = '共 ' + (st.total || 0) + ' 篇 · 今天 ' + (st.today || 0) + ' 篇'
  const list = (r.ok && r.entries) || []
  if (!list.length) { body.innerHTML = '<div class="empty">还没有记录。</div>'; return }
  body.innerHTML = list.map(renderEntry).join('')
  bindDiaryEvents(body)
}

function renderEntry(e) {
  const comments = (e.comments || []).map((c) => renderComment(c, e.id)).join('')
  return '<div class="entry" data-eid="' + esc(e.id) + '">' +
    '<div class="entry-head"><span class="who">' + esc(fmtDay(e.at)) + '</span>' +
    (e.visibility === 'self' ? '<span class="visibility-tag">仅主人可见</span>' : '') +
    '<span class="spacer"></span>' + '</div>' +
    '<div class="entry-text">' + esc(e.text) + '</div>' +
    '<div class="comments">' + (comments || '<div class="muted" style="font-size:12px">还没有留言</div>') +
    '<div class="c-input"><input type="text" placeholder="留句话…" data-cinput="' + esc(e.id) + '" /><button class="primary small" data-csend="' + esc(e.id) + '">留言</button></div>' +
    '</div></div>'
}

function renderComment(c, entryId) {
  const replies = (c.replies || []).map((r2) => (
    '<div class="comment" data-cid="' + esc(c.id) + '" data-rid="' + esc(r2.id) + '">' +
    '<span class="c-who">' + esc(r2.name || r2.from) + '</span><span class="c-text">' + esc(r2.text) + '</span>' +
    '<span class="c-time">' + esc(fmtClock(r2.at)) + '</span>' +
    '</div>'
  )).join('')
  return '<div class="comment" data-cid="' + esc(c.id) + '">' +
    '<span class="c-who">' + esc(c.name || c.from) + '</span><span class="c-text">' + esc(c.text) + '</span>' +
    '<span class="c-time">' + esc(fmtClock(c.at)) + '</span>' +
    '</div>' + (replies ? '<div class="replies">' + replies + '</div>' : '')
}

function bindDiaryEvents(body) {
  body.onclick = async (e) => {
    const cs = e.target.closest('[data-csend]')
    if (cs) {
      const eid = cs.dataset.csend
      const inp = body.querySelector('[data-cinput="' + eid + '"]')
      const text = (inp?.value || '').trim()
      if (!text) return
      const r = await api('/api/diary/comment', { method: 'POST', body: { entryId: eid, text } })
      toast(r.ok ? '留言好了' : (r.reason || '没发出去'), r.ok ? '' : 'err')
      loadDiary()
    }
  }
  body.onkeydown = (e) => {
    if (e.key !== 'Enter') return
    const inp = e.target.closest('[data-cinput]')
    if (!inp) return
    const btn = body.querySelector('[data-csend="' + inp.dataset.cinput + '"]')
    btn?.click()
  }
}

let memTab = 'facts'
function renderMemory(main) {
  paneShell(main, '记忆',
    '<div class="mem-tabs" id="mem-tabs">' +
    ['facts|事实', 'episodes|事件', 'edges|联想'].map((x) => {
      const [id, label] = x.split('|')
      return '<button data-mtab="' + id + '" class="' + (memTab === id ? 'on' : '') + '">' + label + '</button>'
    }).join('') + '</div>')
  $('#mem-tabs').onclick = (e) => {
    const b = e.target.closest('[data-mtab]')
    if (!b) return
    memTab = b.dataset.mtab
    $$('#mem-tabs button').forEach((x) => x.classList.toggle('on', x.dataset.mtab === memTab))
    loadMemory()
  }
  loadMemory()
}

const SRC_LABEL = { told: '他说过', inferred: '我推测', self_did: '我自己做的', manual: '手动', imagined: '想象的' }

async function loadMemory() {
  const body = $('#pane-body')
  if (!body) return
  const r = await api('/api/memory')
  if (!r.ok) { body.innerHTML = '<div class="empty">' + esc(r.reason || '读不到') + '</div>'; return }
  // 记忆内容包一层 .mem-sheet 玻璃底，别让文字糊在背景上
  const wrap = (html) => '<div class="mem-sheet">' + html + '</div>'
  if (memTab === 'episodes') { body.innerHTML = wrap(renderEpisodes(r)); return }
  if (memTab === 'edges') { body.innerHTML = wrap(renderEdges(r)); return }
  body.innerHTML = wrap(renderFacts(r))
}

function renderFacts(r) {
  const facts = r.facts || []
  const supersededIds = new Set(facts.filter((f) => f.supersedes).map((f) => String(f.supersedes)))
  // 头注与只读说明整段删除（用户要求）
  return facts.length ? facts.map((f) => {
      const dead = Boolean(f.invalidAt) || supersededIds.has(String(f.id))
      const isNew = Boolean(f.supersedes)
      return '<div class="mem-row' + (dead ? ' mem-dead' : '') + '"><div class="mem-text">' + esc(f.text) +
        '<div class="mem-meta">' + (f.aboutName ? '<span class="mem-tag">' + esc(f.aboutName) + '</span>' : '') +
        (f.tags || []).map((t) => '<span class="mem-tag">' + esc(t) + '</span>').join('') +
        ' <span>' + esc(fmtDay(f.t0)) + ' · ' + esc(SRC_LABEL[f.src] || f.src || '') + ' · 信度 ' + Math.round((f.conf || 0) * 100) + '%' + (f.archived ? ' · 硬档' : '') + '</span>' +
        (dead ? ' <span class="mem-tag">已失效</span>' : '') + (isNew ? ' <span class="mem-tag">新版本</span>' : '') +
        '</div></div></div>'
    }).join('') : '<div class="empty">还没有记忆，聊几句就有了。</div>'
}

function renderEpisodes(r) {
  const eps = r.episodes || []
  return '<div class="mem-head"><span class="muted" style="font-size:12px">共 ' + eps.length + ' 段事件 · 一段对话自动合成一个事件，带情绪起止</span></div>' +
    (eps.length ? eps.map((e) => '<div class="mem-row"><div class="mem-text">' + esc(e.summary || '（无摘要）') +
      '<div class="mem-meta">' + esc(fmtDay(e.t0)) + (e.t1 && e.t1 !== e.t0 ? ' – ' + esc(fmtDay(e.t1)) : '') +
      ' · 重要度 ' + Math.round((e.salience || 0) * 100) + '%' +
      ((e.tags || []).map((t) => '<span class="mem-tag">' + esc(t) + '</span>').join('')) + '</div></div></div>').join('') : '<div class="empty">还没有事件，聊完会把一段对话自动合成一个事件。</div>')
}

function renderEdges(r) {
  const edges = r.edges || []
  const label = new Map()
  ;(r.facts || []).forEach((f) => label.set(String(f.id), f.text))
  ;(r.episodes || []).forEach((e) => label.set(String(e.id), '事件：' + (e.summary || e.id)))
  const name = (id) => label.get(String(id)) || String(id).slice(0, 8)
  const KIND = { evidence: '证据', assoc: '相关' }
  return '<div class="mem-head"><span class="muted" style="font-size:12px">共 ' + edges.length + ' 条联想 · 凌晨重放时把相关的事连起来，回忆时顺藤摸瓜</span></div>' +
    (edges.length ? edges.map((e) => '<div class="mem-row"><div class="mem-text">' + esc(name(e.a)) + ' ↔ ' + esc(name(e.b)) +
      '<div class="mem-meta">' + esc(KIND[e.kind] || e.kind) + ' · 强度 ' + Math.round((e.w || 0) * 100) + '%' + (e.why ? ' · ' + esc(e.why) : '') + '</div></div></div>').join('') : '<div class="empty">还没有联想，凌晨重放时会自动建立。</div>')
}

function openSettings() { switchView('settings') }

// 架构定位：模块 ≠ 插件。除「器官」外全部固化——web/客户端写死模块清单与页面；
// 器官是唯一全插件：按 Ta 写出的器官声明动态加载（清单、工具、设置表单都走 /api/organs）。
// 后端 modules.js 仍广播 /api/modules 给外部程序，但本 web 面板不再依赖它渲染。
const SETTINGS_MODULES = [
  // 设置页只留「有内容可配」的模块，且不出现介绍类文案；生命相关全在生命页。
  { id: 'chat', name: '聊天', kind: 'bridge', settings: [
    { key: 'merge.waitSec', label: '停顿几秒再回', type: 'number' },
    { key: 'merge.waitTypingSec', label: '最多等几秒', type: 'number' },
    { key: 'history.keepDays', label: '聊天记录保留天数', type: 'number', hint: '只删聊天原文，不影响记忆（记忆事实永久保留）' },
    { key: 'chat.contextWindow', label: '上下文窗口（tokens）', type: 'number', hint: '0 = 自动读 DSH 平台的实际窗口。填1000000相当于1M，按照85%预处理' },
  ] },
  { id: 'web', name: '网页面板', kind: 'bridge', settings: [
    { key: 'web.port', label: '端口', type: 'number' },
    { key: 'web.host', label: '监听地址', type: 'text' },
    { key: 'siteName', label: '网站名称', type: 'text' },
    { key: 'pageTitle', label: '页面标题', type: 'text' },
    { key: 'theme.mode', label: '主题', type: 'select', options: [['follow', '跟随系统'], ['light', '浅色'], ['dark', '深色'], ['acrylic', '亚克力'], ['frosted', '毛玻璃']] },
    { key: 'theme.acrylic.brightness', label: '亚克力·背景亮度', type: 'number', hint: '0-100，默认 100（100=原样不处理）' },
  ] },
  { id: 'tts', name: '语音合成', kind: 'bridge', settings: [] },
  { id: 'stt', name: '语音识别', kind: 'bridge', settings: [] },
  { id: 'imagegen', name: '生图', kind: 'bridge', settings: [] },
  { id: 'stickers', name: '表情', kind: 'bridge', settings: [] },
  { id: 'sound', name: '提示音', kind: 'bridge', settings: [] },
]

function renderSettings(main) {
  const owner = isOwner()
  const body = paneShell(main, '设置', owner ? '<button class="primary small" id="cfg-save">保存设置</button>' : '')
  body.innerHTML = '<div class="cfg-shell"><div class="cfg-nav" id="cfg-nav"></div><div class="cfg-detail" id="cfg-detail"></div></div>'
  if (!owner) {
    $('#cfg-detail').innerHTML = sectionAccount()
    bindSectionEvents($('#cfg-detail'))
    return
  }
  // web 面板写死模块清单，不再请求 api/modules（后端广播保留给外部程序/客户端）。
  // 删掉「模块开关」汇总页——四个开关只出现在各自模块页顶部（TTS/STT/生图/提示音）。
  const items = []
  for (const m of SETTINGS_MODULES.filter((x) => x.kind === 'bridge')) items.push({ id: m.id, label: m.name, html: sectionModule(m) })
  for (const m of SETTINGS_MODULES.filter((x) => x.kind === 'life')) items.push({ id: m.id, label: m.name, html: sectionModule(m) })
  items.push({ id: '__system__', label: '系统', html: sectionSwitch('总开关', 'enabled', '关掉后 Ta 休眠：不回复、不搭话、不整理记忆；再打开会从刚才的状态继续') + sectionModel() + sectionGuests() + sectionAccount() + sectionLogs() })
  items.push({ id: '__about__', label: 'AuraLife', html: sectionAbout() })
  window._cfgItems = items
  const nav = $('#cfg-nav')
  nav.innerHTML = items.map((it, i) => '<button data-cfgitem="' + it.id + '" class="cfg-nav-item' + (i === 0 ? ' active' : '') + '">' + esc(it.label) + '</button>').join('')
  nav.onclick = (e) => {
    const b = e.target.closest('[data-cfgitem]')
    if (b) showCfgItem(b.dataset.cfgitem)
  }
  const saveBtn = $('#cfg-save')
  if (saveBtn) saveBtn.onclick = () => saveConfig()
  showCfgItem(items[0].id)
}

function showCfgItem(id) {
  // 每次切换都重算该模块的 html——否则主档卡的选中标记停留在旧快照（cfg 已变但 html 没变）。
  const m = SETTINGS_MODULES.find((x) => x.id === id)
  if (m) {
    const it = (window._cfgItems || []).find((x) => x.id === id)
    if (it) it.html = sectionModule(m)
  }
  const it = (window._cfgItems || []).find((x) => x.id === id)
  if (!it) return
  window._curCfgItem = id
  $$('#cfg-nav [data-cfgitem]').forEach((b) => b.classList.toggle('active', b.dataset.cfgitem === id))
  const box = $('#cfg-detail')
  box.innerHTML = it.html
  if (id === '__about__') fillAbout()
  box.onclick = (e) => {
    const cp = e.target.closest('#pw-save')
    if (cp) return changePassword()
    const lo = e.target.closest('#logout')
    if (lo) return logout()
  }
  bindSectionEvents(box)
  applyWhen(box)
}

function setPath(obj, key, v) {
  const parts = String(key).split('.')
  let o = obj
  for (let i = 0; i < parts.length - 1; i++) { o[parts[i]] = o[parts[i]] || {}; o = o[parts[i]] }
  o[parts[parts.length - 1]] = v
  return obj
}

// 模块开关总览页已删除开关收窄后只有 tts/stt/imagegen/sound 四个开关，
// 且就放在各自模块页顶部；总开关移进「系统」页。sectionModuleSwitches 无引用。


// 单模块设置页（左侧栏点进来）：头部 + schema 各项 + 复杂 UI。
// 只有 tts/stt/imagegen/sound 有启用开关；其余模块不渲染开关行。
// 不渲染介绍文案（description/capabilities/hint 都不再显示）。
function sectionModule(m) {
  const isSwitchable = ['tts', 'stt', 'imagegen', 'sound'].includes(m.id)
  const switchRow = () => {
    if (m.id === 'tts') return '<div class="row"><label>启用</label><div class="ctl"><label class="switch"><input type="checkbox" data-key="voice.enabled" data-instant="1" /><span class="slider"></span></label></div></div>'
    if (m.id === 'stt') return '<div class="row"><label>启用</label><div class="ctl"><label class="switch"><input type="checkbox" data-key="voice.asr" data-instant="1" data-stt-toggle="1" /><span class="slider"></span></label></div></div>'
    if (m.id === 'imagegen') return '<div class="row"><label>启用</label><div class="ctl"><label class="switch"><input type="checkbox" data-key="imageGen.enabled" data-instant="1" /><span class="slider"></span></label></div></div>'
    if (m.id === 'sound') return '<div class="row"><label>启用</label><div class="ctl"><label class="switch"><input type="checkbox" data-key="sound.enabled" data-instant="1" /><span class="slider"></span></label></div></div>'
    return ''
  }
  const renderSetting = (s) => {
    if (s.type === 'bool') return rowSwitch(s.label, s.key, '')
    if (s.type === 'number') return rowNum(s.label, s.key, s.hint || '')
    if (s.type === 'select') return rowSelect(s.label, s.key, s.options || [])
    return rowInput(s.label, s.key, s.hint || '', s.secret ? 'password' : 'text')
  }
  const extra = (m) => {
    if (m.id === 'web') return sectionWebBg()
    if (m.id === 'tts') return sectionVoice()
    if (m.id === 'stt') return sectionListen()
    if (m.id === 'imagegen') return sectionImageGen()
    if (m.id === 'stickers') return sectionStickers()
    if (m.id === 'sound') return sectionSound()
    return ''
  }
  return '<div class="section"><h3>' + esc(m.name) + '</h3><div class="body">' +
    (isSwitchable ? switchRow() : '') +
    (m.settings || []).map(renderSetting).join('') + extra(m) +
    '</div></div>'
}

// 头像与背景区块已拆走——背景就是 web 模块的「背景图」行；头像移进生命 → 人格「形象」区。


function saveConfig() {
  const b = collectConfig()
  const mv = $('#model-sel')?.value
  if (mv !== undefined) {
    const mm = splitModelValue(mv)
    b.model = b.model || {}
    b.model.provider = mm.provider
    b.model.model = mm.model
  }
  // 思考强度选了「自定义」时，把自定义值合并进 reasoningEffort
  if (b.model && String(b.model.reasoningEffortCustom || '').trim()) {
    b.model.reasoningEffort = String(b.model.reasoningEffortCustom).trim()
  }
  if (b.model) delete b.model.reasoningEffortCustom
  const keep = scrollState()
  api('/api/config', { method: 'PATCH', body: b }).then(async (r) => {
    toast(r.ok ? '存好了' : (r.reason || '没存上'), r.ok ? '' : 'err')
    if (!r.ok) return
    cfg = r.config
    applyTheme()
    applyTitle()
    await boot({ silent: true })
    restoreScroll(keep)
  })
}

function scrollState() {
  return { win: window.scrollY || 0, pane: $('.pane')?.scrollTop || 0, body: $('#pane-body')?.scrollTop || 0 }
}

function restoreScroll(s) {
  if (!s) return
  const put = (el, v) => { if (el && v) el.scrollTop = v }
  put($('.pane'), s.pane)
  put($('#pane-body'), s.body)
  if (s.win) window.scrollTo(0, s.win)
}

async function changePassword() {
  const oldPw = $('#pw-old')?.value || ''
  const newPw = $('#pw-new')?.value || ''
  if (newPw.length < 6) return toast('新密码至少 6 位', 'err')
  const r = await api('/api/account/password', { method: 'POST', body: { oldPassword: oldPw, newPassword: newPw } })
  toast(r.ok ? '密码改好了' : (r.reason || '没改成'), r.ok ? '' : 'err')
  if (r.ok) { $('#pw-old').value = ''; $('#pw-new').value = '' }
}
async function logout() {
  await api('/api/logout', { method: 'POST' })
  setToken('')
  me = null
  if (stream) { stream.close(); stream = null }
  showGate('login')
}

function sectionSwitch(title, key, hint) {
  return '<div class="section"><h3>' + esc(title) + '</h3><div class="body"><div class="row">' +
    '<label>' + esc(title) + '</label><div class="ctl"><label class="switch"><input type="checkbox" data-key="' + key + '" /><span class="slider"></span></label>' +
    '<span class="muted" style="font-size:12px">' + esc(hint || '') + '</span></div></div></div></div>'
}

function rowInput(label, key, hint, type = 'text') {
  return '<div class="row"><label>' + esc(label) + '</label><div class="ctl"><input type="' + type + '" data-key="' + key + '" />' +
    (hint ? '<span class="muted" style="font-size:12px">' + esc(hint) + '</span>' : '') + '</div></div>'
}
function rowNum(label, key, hint) {
  return '<div class="row"><label>' + esc(label) + '</label><div class="ctl"><input type="number" data-key="' + key + '" />' +
    (hint ? '<span class="muted" style="font-size:12px">' + esc(hint) + '</span>' : '') + '</div></div>'
}
function rowSelect(label, key, opts) {
  return '<div class="row"><label>' + esc(label) + '</label><div class="ctl"><select data-key="' + key + '">' +
    opts.map((o) => '<option value="' + esc(o[0]) + '">' + esc(o[1]) + '</option>').join('') + '</select></div></div>'
}
function rowTime(label, key, hint) {
  return '<div class="row"><label>' + esc(label) + '</label><div class="ctl"><input type="text" data-key="' + key + '" placeholder="HH:MM" maxlength="5" style="max-width:110px" />' +
    '<span class="muted" style="font-size:12px">' + esc(hint || 'HH:MM') + '</span></div></div>'
}

function rowWhen(when, html) {
  return '<div class="when-wrap" data-when="' + esc(when) + '">' + html + '</div>'
}
function applyWhen(root) {
  $$('[data-when]', root || document).forEach((w) => {
    const [key, vals] = String(w.dataset.when || '').split(':')
    const el = root ? root.querySelector('[data-key="' + key + '"]') : $('[data-key="' + key + '"]')
    const want = String(vals || '').split('|')
    w.style.display = !el || want.includes(String(el.value)) ? '' : 'none'
  })
}
document.addEventListener('change', (e) => {
  const t = e.target
  if (t && t.dataset && t.dataset.key) applyWhen(t.closest('#cfg-detail') || document.body)
})

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-voice-play]')
  if (!b) return
  const bar = b.closest('.voice-bar')
  const a = bar && bar.querySelector('audio')
  if (!a) return
  if (!a.paused) { a.pause(); bar.classList.remove('on'); return }
  document.querySelectorAll('.voice-bar audio').forEach((x) => {
    if (x !== a) { try { x.pause() } catch (err) {} x.closest('.voice-bar')?.classList.remove('on') }
  })
  const p = a.play()
  if (p && p.then) p.then(() => bar.classList.add('on')).catch(() => {})
  else bar.classList.add('on')
})
document.addEventListener('ended', (e) => {
  if (e.target && e.target.tagName === 'AUDIO') e.target.closest('.voice-bar')?.classList.remove('on')
}, true)
document.addEventListener('pause', (e) => {
  if (e.target && e.target.tagName === 'AUDIO') e.target.closest('.voice-bar')?.classList.remove('on')
}, true)
document.addEventListener('loadedmetadata', (e) => {
  if (!e.target || e.target.tagName !== 'AUDIO') return
  const bar = e.target.closest('.voice-bar')
  const d = bar && bar.querySelector('.vb-dur')
  if (d && !d.textContent) d.textContent = fmtDur(e.target.duration)
}, true)

function sectionSound() {
  return '<div class="section"><h3>提示音</h3><div class="body">' +
    rowSwitch('Ta来消息时响', 'sound.onIncoming') +
    rowSelect('来消息的音', 'sound.incoming', TONES) +
    rowWhen('sound.incoming:custom', rowInput('来消息的音频地址', 'sound.incomingUrl', 'http(s) 地址，或者本机的 /xxx.mp3')) +
    rowSwitch('我发消息时响', 'sound.onSend') +
    rowSelect('我发消息的音', 'sound.outgoing', TONES) +
    rowWhen('sound.outgoing:custom', rowInput('我发消息的音频地址', 'sound.outgoingUrl', '同上')) +
    '<div class="row"><label>来消息音量</label><div class="ctl"><input type="number" step="0.1" min="0" max="1" data-key="sound.inVolume" />' +
    '<button class="ghost small" data-tone="in">试听</button></div></div>' +
    '<div class="row"><label>发消息音量</label><div class="ctl"><input type="number" step="0.1" min="0" max="1" data-key="sound.outVolume" />' +
    '<button class="ghost small" data-tone="out">试听</button></div></div>' +
    '</div></div>'
}

function playSound(kind) { playTone(kind, cfg) }

function sectionModel() {
  const cur = cfg?.model || {}
  return '<div class="section"><h3>模型</h3><div class="body">' +
    '<div class="row"><label>模型</label><div class="ctl"><select id="model-sel">' +
    '<option value="__default__">默认（跟随 DSH）</option>' +
    models.map((m) => '<option value="' + esc(m.provider + '::' + m.model) + '">' + esc(m.provider + ' / ' + m.model) + '</option>').join('') +
    '</select></div></div>' +
    rowSelect('思考强度', 'model.reasoningEffort', [['off', '关'], ['low', '低'], ['high', '高'], ['max', '满'], ['custom', '自定义']]) +
    rowWhen('model.reasoningEffort:custom', rowInput('自定义值', 'model.reasoningEffortCustom')) +
    '</div></div>'
}

// 背景图 = 上传（存服务端文件，任何浏览器打开都同步显示；客户端不参与）。
function sectionWebBg() {
  const has = (cfg?.theme?.background || '') === 'local'
  return '<div class="row"><label>背景图</label><div class="ctl">' +
    '<label class="ghost" style="cursor:pointer">上传图片<input type="file" id="bg-file" accept="image/*" style="display:none"></label>' +
    '<button class="ghost" id="bg-clear">清除</button>' +
    '<span class="muted" style="font-size:12px">' + (has ? '已上传（换浏览器也同步显示）' : '还没上传') + '</span>' +
    '</div></div>'
}

// 左栏独立「AuraLife」项——版本正常读，无说明无文档，展示宿主版本与宿主操作系统。
function sectionAbout() {
  return '<div class="section"><h3>AuraLife</h3><div class="body">' +
    '<div class="row"><label>版本</label><div class="ctl"><span class="muted" id="about-version">…</span></div></div>' +
    '<div class="row"><label>宿主版本</label><div class="ctl"><span class="muted" id="about-host">…</span></div></div>' +
    '<div class="row"><label>操作系统</label><div class="ctl"><span class="muted" id="about-os">…</span></div></div>' +
    '</div></div>'
}

async function fillAbout() {
  try {
    const r = await api('/api/status')
    if (!r || r.ok === false) return
    const v = $('#about-version'); if (v && r.version) v.textContent = String(r.version)
    const h = $('#about-host'); if (h) {
      const hv = r.host || {}
      h.textContent = hv.dshVersion ? 'DSH ' + String(hv.dshVersion) + (hv.node ? ' · Node ' + String(hv.node) : '') : (hv.node ? 'Node ' + String(hv.node) : '未知')
    }
    const o = $('#about-os'); if (o) {
      const hv = r.host || {}
      const p = hv.platform || r.platform || ''
      o.textContent = p === 'win32' ? 'Windows' : p === 'linux' ? 'Linux' : p === 'darwin' ? 'macOS' : (p || '未知') + (hv.arch ? ' · ' + String(hv.arch) : '')
    }
  } catch (error) {}
}

function rowSwitch(label, key, hint) {
  return '<div class="row"><label>' + esc(label) + '</label><div class="ctl"><label class="switch"><input type="checkbox" data-key="' + key + '" /><span class="slider"></span></label>' +
    (hint ? '<span class="muted" style="font-size:12px">' + esc(hint) + '</span>' : '') + '</div></div>'
}

// TTS 主档四选一（关 / edgetts / win 语音 / 自定义接口）。
// 「自定义」= provider 落 'custom' + local.tts 开；怎么配见 Interface.md。
const TTS_MAIN = [
  { id: 'off', title: '关', desc: '不发语音' },
  { id: 'edge', title: 'edgetts', desc: '微软 edge-tts，在线，音色自然', badge: true },
  { id: 'windows', title: 'win 语音', desc: 'Windows 自带语音，离线可用，仅 Windows', winOnly: true },
  { id: 'custom', title: '自定义接口', desc: '根据 Interface.md 配置' },
]
const ttsMainId = () => {
  const v = cfg?.voice || {}
  if (v.enabled === false) return 'off'
  if (v.provider === 'edge') return 'edge'
  if (v.provider === 'windows') return 'windows'
  return 'custom'
}

const EDGE_VOICES = [
  ['zh-CN-XiaoxiaoNeural', '晓晓 · 温暖女声'],
  ['zh-CN-XiaoyiNeural', '晓伊 · 活泼女声'],
  ['zh-CN-XiaochenNeural', '晓辰 · 清亮女声'],
  ['zh-CN-XiaohanNeural', '晓涵 · 知性女声'],
  ['zh-CN-XiaomengNeural', '晓梦 · 少女'],
  ['zh-CN-XiaomoNeural', '晓墨 · 低柔女声'],
  ['zh-CN-YunxiNeural', '云希 · 少年'],
  ['zh-CN-YunjianNeural', '云健 · 浑厚男声'],
  ['zh-CN-YunxiaNeural', '云夏 · 少年'],
  ['zh-CN-YunyangNeural', '云扬 · 播报男声'],
  ['zh-CN-liaoning-XiaobeiNeural', '晓北 · 东北女声'],
  ['zh-CN-shaanxi-XiaoniNeural', '晓妮 · 陕西女声'],
  ['zh-HK-HiuMaanNeural', '曉曼 · 粤语女声'],
  ['zh-HK-WanLungNeural', '雲龍 · 粤语男声'],
  ['zh-TW-HsiaoChenNeural', '曉臻 · 台湾女声'],
  ['zh-TW-YunJheNeural', '雲哲 · 台湾男声'],
]

// 生图主档三选一（关 / 代码画 / 自定义接口）。
// 自定义 = provider 落 'custom' + local.image 开；怎么配见 Interface.md。
const IMG_MAIN = [
  { id: 'off', title: '关', desc: '不画图' },
  { id: 'code', title: '代码画', desc: '让 Ta 写代码画，不连任何服务' },
  { id: 'custom', title: '自定义接口', desc: '根据 Interface.md 配置' },
]
const imgMainId = () => {
  const g = cfg?.imageGen || {}
  if (g.enabled === false) return 'off'
  if (g.provider === 'code') return 'code'
  return 'custom'
}

// STT 主档三选一（关 / dsh 自带 / 自定义接口）。落 config voice.asr：'off'|'dsh'|'custom'。
const STT_MAIN = [
  { id: 'off', title: '关', desc: '不转写语音，听到就听到' },
  { id: 'dsh', title: 'dsh 自带', desc: 'DSH 平台自带识别，桌面版可用' },
  { id: 'custom', title: '自定义接口', desc: '连你自己的 ASR 服务，根据 Interface.md 配置' },
]
const sttMainId = () => (cfg?.voice?.asr === 'custom' ? 'custom' : cfg?.voice?.asr === 'dsh' ? 'dsh' : 'off')

function rowSlider(label, key, min, max, step, unit, hint) {
  return '<div class="row"><label>' + esc(label) + '</label><div class="ctl">' +
    '<input type="range" min="' + min + '" max="' + max + '" step="' + step + '" data-key="' + key + '" data-unit="' + esc(unit) + '" />' +
    '<span class="pill" data-out="' + esc(key) + '"></span>' +
    '</div>' + (hint ? '<p class="hint">' + esc(hint) + '</p>' : '') + '</div>'
}

function sectionListen() {
  // STT 三档（关 / dsh 自带 / 自定义接口），落 config voice.asr = 'off'|'dsh'|'custom'
  const cur = sttMainId()
  const cards = STT_MAIN.map((c) =>
    '<button type="button" class="tts-card' + (c.id === cur ? ' on' : '') + '" data-stt-main="' + c.id + '">' +
    '<b>' + esc(c.title) + '</b><small>' + esc(c.desc) + '</small></button>').join('')
  return '<div class="section"><h3>语音识别（STT）</h3><div class="body">' +
    '<div class="tts-cards">' + cards + '</div>' +
    '<input type="hidden" data-key="voice.asr" />' +
    rowWhen('voice.asr:dsh', '<div class="row"><label>识别服务</label><div class="ctl"><span class="muted" id="asr-state">正在查…</span></div></div>') +
    rowWhen('voice.asr:dsh', rowInput('识别语言', 'voice.asrLanguage')) +
    '</div></div>'
}

async function loadAsrState() {
  const el = $('#asr-state')
  if (!el) return
  const r = await api('/api/status')
  if (!r || r.ok === false) { el.textContent = '查不到（要主人登录）'; return }
  const a = r.asr || {}
  if (!a.host) el.textContent = '宿主没有提供语音识别（网页版没有；桌面版要启用语音输入）'
  else if (a.providers && a.providers.length) el.textContent = '可用：' + a.providers.join('、')
  else el.textContent = '宿主有服务，但识别器还没注册（模型可能没下载完）'
}

function sectionVoice() {
  // TTS 主档四选一（关 / edgetts / win 语音 / 自定义接口）
  const cur = ttsMainId()
  const mainCards = TTS_MAIN
    .filter((c) => !c.winOnly || (window._platform || '') === 'win32')
    .map((c) =>
      '<button type="button" class="tts-card' + (c.id === cur ? ' on' : '') + '" data-tts-main="' + c.id + '">' +
      '<b>' + esc(c.title) + '</b><small>' + esc(c.desc) + '</small>' +
      (c.badge ? '<em class="tts-badge" data-edge-badge>还没装</em>' : '') + '</button>').join('')
  return '<div class="section"><h3>语音合成（TTS）</h3><div class="body">' +
    '<div class="tts-cards">' + mainCards + '</div>' +
    '<input type="hidden" data-key="voice.provider" />' +
    rowWhen('voice.provider:edge', '<div class="row"><label>edge-tts</label><div class="ctl">' +
      '<span class="muted" id="edge-state">正在查…</span><button class="ghost small" id="edge-install">安装</button></div></div>') +
    rowWhen('voice.provider:edge', rowSelect('音色', 'voice.voice', EDGE_VOICES)) +
    rowWhen('voice.provider:windows', rowInput('音色', 'voice.voice')) +
    rowWhen('voice.provider:edge|windows', rowSelect('语速', 'voice.rate', [['-30%', '很慢'], ['-15%', '慢'], ['+0%', '正常'], ['+15%', '快'], ['+30%', '很快']])) +
    '<div class="row"><label>试听</label><div class="ctl">' +
    '<input type="text" id="tts-test-text" value="晚安啦，今天也辛苦了，明天见～" style="max-width:320px" />' +
    '<button class="ghost small" id="tts-test">生成</button><span class="muted" id="tts-test-state" style="font-size:12px"></span>' +
    '</div></div>' +
    '<audio id="tts-test-audio" style="display:none"></audio>' +
    '</div></div>'
}

function sectionImageGen() {
  // 生图主档三选一（关 / 代码画 / 自定义接口）
  const cur = imgMainId()
  const mainCards = IMG_MAIN.map((c) =>
    '<button type="button" class="tts-card' + (c.id === cur ? ' on' : '') + '" data-img-main="' + c.id + '">' +
    '<b>' + esc(c.title) + '</b><small>' + esc(c.desc) + '</small></button>').join('')
  return '<div class="section"><h3>生图</h3><div class="body">' +
    '<div class="tts-cards">' + mainCards + '</div>' +
    '<input type="hidden" data-key="imageGen.provider" />' +
    rowWhen('imageGen.provider:code', '<p class="hint">已生效：Ta 会直接写绘图代码把图画出来，不连任何服务。</p>') +
    '</div></div>'
}

function sectionLogs() {
  return '<div class="section"><h3>日志</h3><div class="body">' +
    rowNum('占用空间（MB）', 'logs.maxMB', '日志不落盘') +
    '</div></div>'
}

function sectionStickers() {
  return '<div class="section"><h3>表情库</h3><div class="body">' +
    rowSwitch('自动配表情', 'stickers.enabled') +
    rowSwitch('偷表情', 'stickers.steal', 'Ta收到你发的图/表情，会自己挑着收进库') +
    '<div class="row"><label>上传</label><div class="ctl"><label class="file-btn">选图（可多选）<input type="file" id="sticker-file" accept="image/*" multiple hidden /></label>' +
    '<span class="muted" style="font-size:12px">支持动图；也可以直接把图拖到输入框</span></div></div>' +
    '<div id="sticker-grid" class="sticker-grid-lg"></div></div></div>'
}

function sectionGuests() {
  return '<div class="section"><h3>客人</h3><div class="body">' +
    '<div class="row"><label>创建客人</label><div class="ctl">' +
    '<input type="text" id="g-u" placeholder="用户名（区分大小写）" style="max-width:190px" />' +
    '<input type="text" id="g-d" placeholder="称呼" style="max-width:100px" />' +
    '<select id="g-level"><option value="social">只聊天和空间</option><option value="full">完全权限</option></select>' +
    '<button class="primary small" id="g-create">创建</button></div></div>' +
    '<div id="guest-list"></div></div></div>'
}

function sectionAccount() {
  return '<div class="section"><h3>账号</h3><div class="body">' +
    '<div class="row"><label>修改当前账户密码</label><div class="ctl">' +
    '<input type="password" id="pw-old" placeholder="当前密码" style="max-width:150px" />' +
    '<input type="password" id="pw-new" placeholder="新密码（至少 6 位）" style="max-width:180px" />' +
    '<button class="ghost small" id="pw-save">改密码</button></div></div>' +
    '<div class="row"><label>退出登录</label><div class="ctl"><button class="danger small" id="logout">退出登录</button></div></div>' +
    '</div></div>'
}

function collectConfig() {
  const out = {}
  $$('#cfg-detail [data-key]').forEach((el) => {
    const wrap = el.closest('.when-wrap')
    if (wrap && getComputedStyle(wrap).display === 'none') return
    const key = el.dataset.key
    let v
    if (el.type === 'checkbox') v = el.checked
    else if (el.type === 'number') v = el.value === '' ? undefined : Number(el.value)
    else v = el.value
    if (v === undefined) return
    const parts = key.split('.')
    let o = out
    for (let i = 0; i < parts.length - 1; i++) { o[parts[i]] = o[parts[i]] || {}; o = o[parts[i]] }
    o[parts[parts.length - 1]] = v
  })
  return out
}

async function loadEdgeState() {
  const el = $('#edge-state')
  const btn = $('#edge-install')
  if (!el) return
  const r = await api('/api/voice/edge')
  const badge = document.querySelector('[data-edge-badge]')
  const mark = (t) => { if (badge) badge.textContent = t }
  if (!r.ok) { el.textContent = '查不到'; mark('查不到'); return }
  el.textContent = r.installed ? '已装好，可以直接用' : '还没装'
  mark(r.installed ? '已装' : '还没装')
  if (btn) {
    btn.textContent = r.installed ? '重装' : '安装'
    btn.onclick = async () => {
      btn.disabled = true
      el.textContent = '正在装，可能要几分钟…'
      const r2 = await api('/api/voice/edge', { method: 'POST' })
      btn.disabled = false
      toast(r2.ok ? '装好了' : (r2.reason || '没装上'), r2.ok ? '' : 'err')
      loadEdgeState()
    }
  }
}

function fmtSlider(el) {
  const v = Number(el.value)
  const unit = el.dataset.unit || ''
  if (!unit && Number(el.max) <= 1) return Math.round(v * 100) + '%'
  return String(Math.round(v)) + unit
}
function refreshSliders(root) {
  const box = root || document
  $$('input[type="range"][data-key]', box).forEach((el) => {
    const out = box.querySelector('[data-out="' + el.dataset.key + '"]')
    if (out) out.textContent = fmtSlider(el)
  })
}
document.addEventListener('input', (e) => {
  const t = e.target
  if (!t || t.type !== 'range' || !t.dataset.key) return
  const box = t.closest('#cfg-detail') || document
  const out = box.querySelector('[data-out="' + t.dataset.key + '"]')
  if (out) out.textContent = fmtSlider(t)
})

function bindCards(root, attr, key) {
  const hidden = root.querySelector('[data-key="' + key + '"]')
  root.querySelectorAll('[' + attr + ']').forEach((b) => {
    b.onclick = () => {
      const id = b.getAttribute(attr)
      if (hidden) hidden.value = id
      root.querySelectorAll('[' + attr + ']').forEach((x) => x.classList.toggle('on', x === b))
      applyWhen(root)
      if (key === 'voice.provider' && (id === 'edge' || id === 'auto')) loadEdgeState()
      // 直连服务小卡点选即时生效（主档卡的 PATCH 由 bindTtsMain/bindImgMain 处理）
      api('/api/config', { method: 'PATCH', body: setPath({}, key, id) }).then((r) => {
        if (r.ok) cfg = r.config
        else toast(r.reason || '没存上', 'err')
      })
    }
  })
}

// 主档卡通用处理：PATCH 一组键后重渲染当前设置详情。
function bindMainCards(root, attr, patchOf, after) {
  root.querySelectorAll('[' + attr + ']').forEach((b) => {
    b.onclick = () => {
      const id = b.getAttribute(attr)
      const body = patchOf(id)
      if (!body) return
      api('/api/config', { method: 'PATCH', body }).then((r) => {
        if (r.ok) {
          cfg = r.config
          toast('已生效')
          showCfgItem(window._curCfgItem)
          if (after) after(id)
        } else toast(r.reason || '没存上', 'err')
      })
    }
  })
}

function bindTtsCards(root) {
  // 主档四选一：关 / edgetts / win 语音 / 自定义接口
  bindMainCards(root, 'data-tts-main', (id) => {
    if (id === 'off') return { voice: { enabled: false } }
    if (id === 'edge') return { voice: { enabled: true, provider: 'edge' }, local: { tts: false } }
    if (id === 'windows') return { voice: { enabled: true, provider: 'windows' }, local: { tts: false } }
    if (id === 'custom') return { voice: { enabled: true, provider: 'custom' }, local: { tts: true } }
    return null
  }, (id) => { if (id === 'edge') loadEdgeState() })
  const btn = root.querySelector('#tts-test')
  if (btn) btn.onclick = async () => {
    const st = $('#tts-test-state')
    const box = $('#tts-test-text')
    btn.disabled = true
    if (st) st.textContent = '正在生成…'
    const r = await api('/api/voice/test', { method: 'POST', body: { text: box ? box.value : '' } })
    btn.disabled = false
    if (!r.ok) { if (st) st.textContent = r.reason || '没成'; return }
    if (st) st.textContent = '用的 ' + r.engine
    const a = $('#tts-test-audio')
    if (a) { a.src = 'data:' + r.mime + ';base64,' + r.data; const p = a.play(); if (p && p.catch) p.catch(() => {}) }
  }
}

function bindSectionEvents(box) {
  if (cfg) {
    box.querySelectorAll('[data-key]').forEach((el) => {
      const key = el.dataset.key
      const v = key.split('.').reduce((o, k) => (o == null ? o : o[k]), cfg)
      if (el.type === 'checkbox') {
        // stt 开关写的是字符串档位（'dsh'/'off'/'custom'），checked 语义 = 非 off
        if (el.dataset.sttToggle) el.checked = v !== 'off'
        else el.checked = Boolean(v)
      } else if (v != null) el.value = v
    })
    const ms = box.querySelector('#model-sel')
    if (ms) {
      const cur = cfg.model || {}
      ms.value = cur.provider && cur.model ? cur.provider + '::' + cur.model : '__default__'
    }
  }
  loadStickerGrid()
  loadGuests()
  loadEdgeState()
  loadAsrState()
  box.querySelectorAll('[data-tone]').forEach((b) => {
    b.onclick = () => {
      const kind = b.dataset.tone
      const key = kind === 'in' ? 'inVolume' : 'outVolume'
      const el = box.querySelector('[data-key="sound.' + key + '"]')
      if (el && cfg && cfg.sound) cfg.sound[key] = Number(el.value)
      playSound(kind)
    }
  })
  bindTtsCards(box)
  // 生图/STT 主档卡（关/代码画/自定义、关/dsh自带/自定义）；自定义档直接启用 local 槽
  bindMainCards(box, 'data-img-main', (id) => {
    if (id === 'off') return { imageGen: { enabled: false } }
    if (id === 'code') return { imageGen: { enabled: true, provider: 'code' }, local: { image: false } }
    if (id === 'custom') return { imageGen: { enabled: true, provider: 'custom' }, local: { image: true } }
    return null
  })
  bindMainCards(box, 'data-stt-main', (id) => {
    if (id === 'off') return { voice: { asr: 'off' } }
    if (id === 'dsh') return { voice: { asr: 'dsh' } }
    if (id === 'custom') return { voice: { asr: 'custom' }, local: { asr: true } }
    return null
  })
  refreshSliders(box)
  // 即时保存：模块开关/内嵌设置项，change 即 PATCH，不用点「保存设置」
  box.querySelectorAll('[data-instant]').forEach((el) => {
    el.addEventListener('change', () => {
      const key = el.dataset.key
      let v
      if (el.type === 'checkbox') {
        // stt 开关是字符串档位（dsh/off/custom），勾选=dsh、取消=off
        if (el.dataset.sttToggle) v = el.checked ? 'dsh' : 'off'
        else v = el.checked
      } else if (el.type === 'number') v = el.value === '' ? null : Number(el.value)
      else v = el.value
      if (v === null) return
      api('/api/config', { method: 'PATCH', body: setPath({}, key, v) }).then((r) => {
        if (r.ok) {
          cfg = r.config
          toast((el.type === 'checkbox' ? (v ? '开' : '关') : v) + ' 已生效')
          // 开关类立即重渲染当前页（主档卡/选中标记要跟着变）；滑条/输入不重渲染避免打断操作
          if (el.type === 'checkbox' || el.tagName === 'SELECT') showCfgItem(window._curCfgItem)
        } else {
          toast(r.reason || '没存上', 'err')
          if (el.type === 'checkbox') el.checked = !el.checked
        }
      })
    })
  })
  // 头像已移进「生命 → 人格 → 形象」（life.js renderPersona），设置里不再有头像绑定。
  $('#bg-file') && ($('#bg-file').onchange = uploadBackground)
  $('#bg-clear') && ($('#bg-clear').onclick = async () => { await api('/api/background', { method: 'POST', body: { data: '' } }); await loadConfig(); applyTheme(); toast('背景图清掉了') })
  $('#sticker-file') && ($('#sticker-file').onchange = uploadSticker)
}

async function uploadAvatar(e) {
  const f = e.target.files && e.target.files[0]
  e.target.value = ''
  if (!f) return
  const rd = new FileReader()
  rd.onload = async () => {
    const r = await api('/api/avatar', { method: 'POST', body: { data: String(rd.result), mime: f.type } })
    toast(r.ok ? '头像换好了' : (r.reason || '没换'), r.ok ? '' : 'err')
    if (r.ok) refreshAvatar()
  }
  rd.readAsDataURL(f)
}

async function uploadBackground(e) {
  const f = e.target.files && e.target.files[0]
  e.target.value = ''
  if (!f) return
  const rd = new FileReader()
  rd.onload = async () => {
    const r = await api('/api/background', { method: 'POST', body: { data: String(rd.result), mime: f.type } })
    if (r.ok) {
      bustBackground()
      const mode = $('#cfg-detail [data-key="theme.mode"]')
      if (mode && mode.value !== 'acrylic' && mode.value !== 'frosted') mode.value = 'acrylic'
      await saveConfig()
      toast('背景图设好了（已切到亚克力模式）')
    } else toast(r.reason || '没设上', 'err')
  }
  rd.readAsDataURL(f)
}

async function uploadSticker(e) {
  const files = Array.from((e.target.files || []))
  e.target.value = ''
  if (!files.length) return
  let ok = 0
  let skip = 0
  let last = ''
  const names = []
  for (const f of files) {
    if (f.size > 8 * 1024 * 1024) { skip++; continue }
    const data = await new Promise((resolve) => {
      const rd = new FileReader()
      rd.onload = () => resolve(String(rd.result).split(',')[1] || '')
      rd.onerror = () => resolve('')
      rd.readAsDataURL(f)
    })
    if (!data) { skip++; continue }
    const r = await api('/api/stickers/upload', { method: 'POST', body: { data, from: 'panel' } })
    if (r.ok) { ok++; if (r.item?.name) names.push(r.item.name) }
    else { skip++; last = r.reason || '' }
  }
  toast(ok ? (files.length > 1 ? `收进表情库 ${ok} 张` + (skip ? `，跳过 ${skip} 张` : '') : '收进表情库了') : (last || '没收成'), ok ? '' : 'err')
  const refresh = () => { if ($('#sticker-grid')) loadStickerGrid(); if ($('.sticker-picker')) { $('.sticker-picker').remove() } }
  refresh()
  setTimeout(refresh, 3000)
  setTimeout(refresh, 7000)
}

async function loadStickerGrid() {
  const grid = $('#sticker-grid')
  if (!grid) return
  const r = await api('/api/stickers')
  const items = (r.ok && r.items) || []
  if (!items.length) { grid.innerHTML = '<div class="muted" style="font-size:12px">还没有表情。上传几张，或者看到别人发的图点「收进表情库」。</div>'; return }
  grid.innerHTML = items.map((i) => '<div class="sticker-item"><img src="' + BASE + '/api/sticker/' + esc(i.md5) + '" alt="" />' +
    '<div class="sticker-name">' + esc(i.name || '没起名') + '</div>' +
    '<div class="sticker-acts"><button data-rename="' + esc(i.md5) + '">改名</button><button data-del-sticker="' + esc(i.md5) + '">删除</button></div></div>').join('')
  grid.onclick = async (e) => {
    const rn = e.target.closest('[data-rename]')
    if (rn) {
      const md5 = rn.dataset.rename
      const cur = items.find((x) => x.md5 === md5)
      inlineEditor(rn.closest('.sticker-item'), cur?.name || '', '起个名字', async (name) => {
        const r2 = await api('/api/stickers/' + md5, { method: 'PATCH', body: { name } })
        toast(r2.ok ? '改好了' : (r2.reason || '没改成'), r2.ok ? '' : 'err'); loadStickerGrid()
      })
      return
    }
    const dl = e.target.closest('[data-del-sticker]')
    if (dl) {
      const r2 = await api('/api/stickers/' + dl.dataset.delSticker, { method: 'DELETE' })
      toast(r2.ok ? '删了' : (r2.reason || '没删掉'), r2.ok ? '' : 'err'); loadStickerGrid()
    }
  }
}

function inlineEditor(host, value, placeholder, onSave) {
  const old = host.querySelector('.inline-edit')
  if (old) old.remove()
  const box = document.createElement('div')
  box.className = 'inline-edit'
  box.innerHTML = '<input type="text" /><button class="primary small">保存</button><button class="ghost small">取消</button>'
  host.appendChild(box)
  const input = box.querySelector('input')
  input.value = value || ''
  input.placeholder = placeholder || ''
  input.focus()
  input.select()
  const close = () => box.remove()
  box.querySelector('.ghost').onclick = close
  box.querySelector('.primary').onclick = async () => {
    const v = input.value.trim()
    close()
    await onSave(v)
  }
  input.onkeydown = (e) => { if (e.key === 'Enter') box.querySelector('.primary').click(); if (e.key === 'Escape') close() }
}

async function loadGuests() {
  const box = $('#guest-list')
  if (!box) return
  const create = $('#g-create')
  if (create) create.onclick = async () => {
    const username = ($('#g-u')?.value || '').trim()
    if (!username) return toast('先填个用户名', 'err')
    const r2 = await api('/api/guests', { method: 'POST', body: { username, displayName: ($('#g-d')?.value || '').trim() || username, level: $('#g-level')?.value || 'social' } })
    if (r2.ok) {
      toast('创建好了，一次性密码：' + r2.password)
      if (navigator.clipboard) navigator.clipboard.writeText(r2.password).catch(() => {})
      if ($('#g-u')) $('#g-u').value = ''
      if ($('#g-d')) $('#g-d').value = ''
      loadGuests()
    } else toast(r2.reason || '没建成', 'err')
  }
  const r = await api('/api/guests')
  const list = (r.ok && r.guests) || []
  if (!list.length) { box.innerHTML = '<div class="muted" style="font-size:12px;margin-top:8px">还没有客人。</div>'; return }
  box.innerHTML = list.map((g) => '<div class="guest-row"><span class="g-name">' + esc(g.displayName || g.username) + '</span>' +
    '<span class="muted" style="font-size:12px">@' + esc(g.username) + '</span>' +
    '<span class="spacer"></span>' +
    '<select data-glevel="' + esc(g.subject) + '"><option value="social"' + (g.level === 'social' ? ' selected' : '') + '>只聊天和空间</option><option value="full"' + (g.level === 'full' ? ' selected' : '') + '>完全权限</option></select>' +
    '<button class="ghost small" data-gpw="' + esc(g.subject) + '">重置密码</button>' +
    '<button class="danger small" data-gdel="' + esc(g.subject) + '">删除</button></div>').join('')
  box.onclick = async (e) => {
    const gp = e.target.closest('[data-gpw]')
    if (gp) {
      inlineEditor(gp.closest('.guest-row'), '', '新密码（至少 6 位）', async (pw) => {
        if (!pw) return
        const r2 = await api('/api/guests/' + gp.dataset.gpw, { method: 'PATCH', body: { password: pw } })
        toast(r2.ok ? '密码换了' : (r2.reason || '没换'), r2.ok ? '' : 'err')
      })
      return
    }
    const gd = e.target.closest('[data-gdel]')
    if (gd) {
      const r2 = await api('/api/guests/' + gd.dataset.gdel, { method: 'DELETE' })
      toast(r2.ok ? '删了' : (r2.reason || '没删掉'), r2.ok ? '' : 'err'); loadGuests()
    }
  }
  box.onchange = async (e) => {
    const sel = e.target.closest('[data-glevel]')
    if (!sel) return
    const r2 = await api('/api/guests/' + sel.dataset.glevel, { method: 'PATCH', body: { level: sel.value } })
    toast(r2.ok ? '改好了' : (r2.reason || '没改成'), r2.ok ? '' : 'err')
  }
}

function queryOf(name) {
  try { return new URL(location.href).searchParams.get(name) } catch { return null }
}

function applyTitle() {
  const site = (botState?.siteName || '').trim() || 'AuraLife'
  document.title = botState?.title || site
  const h1 = $('#gate-title')
  if (h1) h1.textContent = site
}

function applyFavicon() {
  const el = $('#favicon')
  if (el) el.href = BASE + '/icon.svg'
}

async function boot({ silent = false } = {}) {
  const deep = queryOf('token')
  if (deep) localStorage.setItem(TOKEN_KEY, deep)
  botState = await api('/api/state')
  if (!botState.ok) { showGate('login', '连不上服务'); return }
  me = botState.me
  applyTheme()
  applyTitle()
  applyFavicon()
  setAvatar($('#gate-logo'), false)
  if (botState.needSetup) { showGate('setup'); initWizard(); return }
  if (!me) { showGate('login'); bindLogin(); return }
  await enterApp()
  // Ta 改了名字/身份之后不用关页面：30s 轮询 /api/state，聊天页头部名字自动跟上
  setInterval(async () => {
    const r = await api('/api/state')
    if (!r || !r.ok) return
    botState = r
    const hn = $('#head-name')
    if (hn) hn.textContent = bot()
  }, 30000)
  const view = queryOf('view')
  if (view && NAVS.some((n) => n.id === view)) switchView(view)
  if (!silent) toast('欢迎回来' + (me.role === 'owner' ? '，' + ownerName() : me.name ? '，' + me.name : ''))
}

function bindLogin() {
  const form = $('#gate-form')
  form.onsubmit = async (e) => {
    e.preventDefault()
    await doLogin($('#g-username').value.trim(), $('#g-password').value)
  }
}

document.addEventListener('input', (e) => {
  const t = e.target
  if (t && t.tagName === 'TEXTAREA' && t.id === 'input') {
    t.style.height = 'auto'
    t.style.height = Math.min(140, t.scrollHeight) + 'px'
  }
})

boot()
