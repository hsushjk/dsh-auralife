import { dataDir, readJson, writeJson } from './store.js'

export const DEFAULTS = {
  enabled: true,
  setupDone: false,
  ownerName: '主人',
  botName: 'AuraLife',
  siteName: '',
  pageTitle: '',
  web: { host: '0.0.0.0', port: 2332 },
  model: { provider: '', model: '', reasoningEffort: 'low' },

  // 回复节奏（需求）：连发合并强制开（多消息合并成一条回），
  // 只暴露两项：waitSec 停顿几秒再回（留出发多消息的时间）、
  // waitTypingSec 最多等几秒（对方一直输入中最多等这么久就先回）。maxSec 内置在 hub.js。
  merge: { waitSec: 2.5, waitTypingSec: 5 },

  // 上下文兜底0 = 自动读 DSH 平台的窗口（session 事件里带 contextWindow），
  // 平台读不到就按模型名查表。手动填 >0 时以手动为准（用户可自行填 1M 之类）。
  chat: { contextWindow: 0 },

  logs: { maxMB: 2 },

  theme: { mode: 'follow', background: '' },
  imageGen: {
    enabled: false,

    provider: 'openai',
    baseUrl: '',
    apiKey: '',
    model: '',
    size: '1024x1024',
    stylePrompt: '',
    steps: 25,
    cfgScale: 7,
    sampler: 'DPM++ 2M Karras',
    negativePrompt: '',
    ownerOnly: true,
  },

  persona: { current: 'dafeiyu' },
  voice: {
    enabled: false,
    provider: 'auto',
    ttsBaseUrl: '',
    ttsApiKey: '',
    ttsModel: 'tts-1',
    ttsVoice: 'alloy',
    engine: 'auto',
    cosyvoice: { url: 'http://127.0.0.1:50000', mode: 'sft', spkId: '中文女', instruct: '', sampleRate: 22050 },
    gptsovits: { url: 'http://127.0.0.1:9880', refAudio: '', promptText: '', promptLang: 'zh', textLang: 'zh' },
    http: { urlTemplate: '' },
    voice: 'zh-CN-XiaoyiNeural',
    rate: '+0%',
    pitch: '+0Hz',
    asr: false,

    asrLanguage: 'zh',
  },
  stickers: {
    enabled: true,
    caption: true,
    steal: true,
  },
  diary: {
    enabled: true,
    visibility: 'all',
  },
  local: { tts: false, image: false, asr: false },

  azoneSocial: {
    enabled: true,
    replyOwn: true,
  },

  memory: { enabled: true },

  // 统一自驱：由 pressure 驱动，开口节奏内置（life/drive.js DRIVE_BUILTIN）。
  drive: { enabled: true },

  // 身体（体力）：纯作息驱动，消耗/恢复速率内置（life/energy.js ENERGY_BUILTIN）。
  energy: { enabled: true },

  // 聊天记录原文保留天数用户可改；记忆事实永久留，不受影响。
  history: { keepDays: 30 },

  // 模块化（DESIGN-modular.md §2）：life 内部运行参数全内置，config 只留开关与 bridge 技术接入。
  chemistry: { enabled: true },
  wishes: { enabled: true },
  self: { enabled: true },
  alarm: { enabled: true },
  organs: { enabled: true },
  sound: {
    enabled: true,
    onIncoming: true,
    onSend: true,
    incoming: 'ding',
    outgoing: 'pop',
    inVolume: 0.6,
    outVolume: 0.5,
    incomingUrl: '',
    outgoingUrl: '',
  },
  tabs: {},
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)

function deepMerge(base, over) {
  if (!isObj(over)) return structuredClone(base)
  const out = structuredClone(base)
  for (const [k, v] of Object.entries(over)) {
    if (isObj(v) && isObj(out[k])) out[k] = deepMerge(out[k], v)
    else if (v !== undefined) out[k] = v
  }
  return out
}

const num = (v, d, lo, hi) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d
}
const bool = (v, d) => (typeof v === 'boolean' ? v : d)
const hhmm = (v, d) => (/^\d{1,2}:\d{2}$/.test(String(v)) ? String(v) : d)

export function normalize(raw) {
  const c = deepMerge(DEFAULTS, raw)
  c.enabled = bool(c.enabled, true)
  c.setupDone = bool(c.setupDone, false)
  c.pledge = bool(c.pledge, false) // 初始化第一步的承诺（不开播圈钱、不污染社区）
  c.ownerName = String(c.ownerName || '主人')
  c.botName = String(c.botName || 'AuraLife')
  delete c.botTag // 自称/口头禅已废除（需求 5）
  c.siteName = String(c.siteName || '').slice(0, 40)
  c.pageTitle = String(c.pageTitle || '').slice(0, 60)

  c.web.port = Math.round(num(c.web.port, 2332, 1, 65535))
  c.web.host = String(c.web.host || '0.0.0.0')
  // 思考强度 off/low/high/max 之外允许任意自定义值（接入其它平台时按其文档填）
  if (typeof c.model.reasoningEffort !== 'string' || !c.model.reasoningEffort.trim()) c.model.reasoningEffort = 'low'
  // 回退主题重排——恢复 acrylic + frosted 双玻璃主题；只留「背景亮度」调节（默认 100=不处理）
  if (!['follow', 'light', 'dark', 'acrylic', 'frosted'].includes(c.theme.mode)) c.theme.mode = 'follow'
  c.theme.background = String(c.theme.background || '')
  c.theme.acrylic = isObj(c.theme.acrylic) ? c.theme.acrylic : {}
  c.theme.acrylic.brightness = num(c.theme.acrylic.brightness, 100, 0, 100)
  c.merge.waitSec = num(c.merge.waitSec, 2.5, 0, 30)
  c.merge.waitTypingSec = num(c.merge.waitTypingSec, 5, 0, 60)
  delete c.merge.enabled // 连发合并强制开（需求）
  delete c.merge.maxSec // 内置 hub.js MERGE_MAX_SEC
  c.chat = isObj(c.chat) ? c.chat : {}
  c.chat.contextWindow = num(c.chat.contextWindow, 0, 0, 10000000)
  const snd = c.sound
  snd.onIncoming = bool(snd.onIncoming, true)
  snd.onSend = bool(snd.onSend, false)
  snd.inVolume = num(snd.inVolume ?? snd.volume, 0.5, 0, 1)
  snd.outVolume = num(snd.outVolume ?? snd.volume, 0.5, 0, 1)
  delete snd.volume
  const TONES = ['ding', 'pop', 'bubble', 'chime', 'custom', 'none']
  if (!TONES.includes(snd.incoming)) snd.incoming = 'ding'
  if (!TONES.includes(snd.outgoing)) snd.outgoing = 'pop'
  snd.incomingUrl = String(snd.incomingUrl || '').slice(0, 500)
  snd.outgoingUrl = String(snd.outgoingUrl || '').slice(0, 500)
  if (!c.logs || typeof c.logs !== 'object') c.logs = { maxMB: 2 }
  c.logs.maxMB = num(c.logs.maxMB, 2, 0.2, 50)
  c.voice.enabled = bool(c.voice.enabled, false)
  // STT 三档——off=关 / dsh=宿主自带（SenseVoice）/ custom=自定义接口（local/asr.mjs）。
  // 旧配置 voice.asr 是布尔（true=用 dsh），迁移成 'dsh' / 'off'。
  const asrOld = c.voice.asr
  c.voice.asr = asrOld === 'custom' ? 'custom' : asrOld === true || asrOld === 'dsh' ? 'dsh' : 'off'

  if (!['auto', 'openai', 'edge', 'windows', 'local', 'cosyvoice', 'gptsovits', 'http', 'custom'].includes(c.voice.provider)) c.voice.provider = 'auto'
  c.voice.ttsBaseUrl = String(c.voice.ttsBaseUrl || '')
  c.voice.ttsModel = String(c.voice.ttsModel || 'tts-1')
  c.voice.ttsVoice = String(c.voice.ttsVoice || 'alloy')

  delete c.voice.asrProvider
  delete c.voice.asrBaseUrl
  delete c.voice.asrApiKey
  delete c.voice.asrModel
  if (!['auto', 'edge', 'windows', 'cosyvoice', 'gptsovits', 'http'].includes(c.voice.engine)) c.voice.engine = 'auto'
  c.voice.cosyvoice.sampleRate = num(c.voice.cosyvoice.sampleRate, 22050, 8000, 48000)
  if (!['sft', 'instruct'].includes(c.voice.cosyvoice.mode)) c.voice.cosyvoice.mode = 'sft'
  c.stickers.steal = bool(c.stickers.steal, true)
  c.diary.visibility = c.diary.visibility === 'self' ? 'self' : 'all'
  for (const k of ['tts', 'image', 'asr']) c.local[k] = bool(c.local[k], false)
  delete c.local.song // 翻唱接口删除，旧残留键清掉
  const q = c.azoneSocial
  q.enabled = bool(q.enabled, true)
  q.replyOwn = bool(q.replyOwn, true)

  const dr = c.drive
  dr.enabled = bool(dr.enabled, true)
  const en = c.energy
  en.enabled = bool(en.enabled, true)
  delete c.speakUp
  delete c.selfDrive
  // 模块化：life 内部参数全内置，config 只留模块开关（DESIGN-modular.md §2/§3）。
  for (const k of ['chemistry', 'wishes', 'self', 'alarm', 'organs']) {
    c[k] = isObj(c[k]) ? c[k] : {}
    c[k].enabled = bool(c[k].enabled, true)
  }
  c.sound = isObj(c.sound) ? c.sound : {}
  c.sound.enabled = bool(c.sound.enabled, true)
  // §3：以下参数已内置进各模块，旧 config.json 里残留的键一律删掉（不删会误导）。
  for (const k of ['timesPerDay', 'windowStart', 'windowEnd', 'minGapMinutes', 'minChars', 'maxChars']) delete c.diary[k]
  delete c.mood // 心情已删情绪归三激素管，旧残留键整体清掉
  for (const k of ['recallCount', 'dailyConsolidate', 'consolidateTimes']) delete c.memory[k]
  for (const k of ['maxPerDay', 'quietFrom', 'quietTo', 'idleMinutes', 'minGapMinutes', 'pressureThreshold']) delete c.drive[k]
  for (const k of ['costPerRequest', 'recoverPerMinute']) delete c.energy[k]
  delete c.energy.balance
  for (const k of ['autoChance', 'autoMaxChars']) delete c.voice[k]
  for (const k of ['autoChance', 'maxPerHour', 'maxLibrary']) delete c.stickers[k]
  delete c.azoneSocial.maxPerDay
  // 聊天记录保留天数用户可改3-3650 天，默认 30。
  c.history = isObj(c.history) ? c.history : {}
  c.history.keepDays = num(c.history.keepDays, 30, 3, 3650)
  delete c.imagegen // 早期版本的小写残留键，与 imageGen 并存会造成开关状态不一致
  c.imageGen.enabled = bool(c.imageGen.enabled, false)
  c.imageGen.ownerOnly = bool(c.imageGen.ownerOnly, true)
  if (!['openai', 'sdwebui', 'comfyui', 'local', 'code', 'custom'].includes(c.imageGen.provider)) c.imageGen.provider = 'openai'
  if (!/^\d{3,4}x\d{3,4}$/.test(String(c.imageGen.size))) c.imageGen.size = '1024x1024'
  c.imageGen.steps = num(c.imageGen.steps, 25, 1, 150)
  c.imageGen.cfgScale = num(c.imageGen.cfgScale, 7, 0, 30)
  c.imageGen.negativePrompt = String(c.imageGen.negativePrompt || '')
  return c
}

const SECRETS = [['imageGen', 'apiKey'], ['voice', 'ttsApiKey']]

export function loadConfig() {
  const raw = readJson(FILE(), {})
  return normalize(raw)
}

export function saveConfig(cfg) {
  const c = normalize(cfg)
  writeJson(FILE(), c)
  return c
}

export function publicConfig(cfg) {
  const c = structuredClone(cfg)
  for (const [g, k] of SECRETS) {
    c[g][`${k}Set`] = Boolean(c[g][k])
    c[g][k] = ''
  }
  return c
}

export function mergeFromPanel(current, incoming) {
  const next = deepMerge(current, incoming || {})
  for (const [g, k] of SECRETS) {
    const v = incoming?.[g]?.[k]
    if (v === null) next[g][k] = ''
    else if (v === undefined || v === '') next[g][k] = current[g][k]
    delete next[g][`${k}Set`]
  }
  return normalize(next)
}

const FILE = () => dataDir('config.json')
