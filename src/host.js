import { existsSync, statSync, mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createLogger } from './core/logger.js'
import { writeJson, dataDir, withFileLock } from './core/store.js'
import { loadConfig, saveConfig, publicConfig, mergeFromPanel } from './core/config.js'
import { createStickerStore } from './features/stickers.js'
import { scoreText, judgeChem } from './features/companion.js'
import { createMemoryV2 } from './memory/v2.js'
import { createAzone } from './features/azone.js'
import { createAzoneSocial } from './features/azone-social.js'
import { createImageGen } from './features/imagegen.js'
import { createLife } from './life/state.js'
import { createWishes } from './life/wishes.js'
import { createDrive } from './life/drive.js'
import { createSelf } from './life/self.js'
import { createChemistry } from './life/chemistry.js'
import { createEnergy } from './life/energy.js'
import { createAlarm } from './life/alarm.js'
import { findGapSentence } from './life/gap.js'
import { createOrganHost } from './organs/organ-host.js'
import { createBootstrap, capabilityGapText } from './organs/organ-bootstrap.js'
import { createLocal, fileOf } from './local/local.js'
import { textToSpeech, transcribe, asrReady } from './voice/tts.js'
import { toMono16k } from './voice/wav.js'
import { buildTools, defineTool } from './tools/tools.js'
import { createHub } from './chat/hub.js'
import { OWNER_ID } from './chat/access.js'
import { seedPersonas, currentPersonaText, rulesText, listPersonas, readPersona, savePersona, deletePersona } from './persona/personas.js'
import { createWebServer } from './web/server.js'

export const name = 'auralife'

// speechToText 不写进 inject：老版本 DSH 没这个服务，写进去插件会一直等它。用 ctx.get 懒取。
export const inject = ['agents', 'sessions', 'webServer', 'timer', 'workspaceRegistry', 'attachments', 'systemPrompt', 'llm']

export function apply(ctx) {

  // 部署探针：每次 DSH 启动写 boot.json，记录「DSH 实际加载的 host.js 的修改时间」。
  // 以后用户说「改动没生效」，读 dataDir/boot.json 对比仓库 src/host.js 的 mtime 就知道 DSH 加载的是不是最新代码。
  try {
    const hostMtime = Math.round(statSync(fileURLToPath(import.meta.url)).mtimeMs)
    writeJson(dataDir('boot.json'), { at: Date.now(), hostMtime, node: process.version })
  } catch (error) {}

  let maxLogMB = Number(loadConfig().logs?.maxMB) || 2
  const logger = createLogger({ dsh: ctx, getMaxBytes: () => maxLogMB * 1024 * 1024 })
  const log = logger.child('core')
  let cfg = loadConfig()
  const getConfig = () => cfg
  // 开关已收窄只有 TTS/STT/生图/提示音四个需要开关，其余模块恒开。
  // 四个开关热生效——每次使用都现读 config。
  const setConfig = (patch) => {
    // 多进程下 config.json 读-改-写要进锁（审计：无锁 RMW 会互相覆盖丢设置）。
    cfg = withFileLock('config', () => saveConfig(mergeFromPanel(cfg, patch)), { staleMs: 5000, timeoutMs: 4000 })
    maxLogMB = Number(cfg.logs?.maxMB) || 2
  }
  seedPersonas()

  const variable = (n, fn) => ctx.effect(() => ctx.systemPrompt.variable(n, fn), 'auralife: 变量 ' + n)
  // 人格（需求 5）：Ta 自己定的 identity.body 覆盖出厂种子；没改过就用出厂 persona 文件。
  variable('auralife_persona', () => {
    const idn = life.load().identity || {}
    const body = idn.body
    const base = body ? body : currentPersonaText(cfg.persona.current)
    // 她从没定过自己的名字/称呼/底色时给一句提示——人格是她自己的权利，想改就改。
    if (!idn.body && !idn.name) return base + '\n\n（你的名字、对主人的称呼、你的底色都还没定成自己的——觉得出厂的不合适，随时用「改人格」工具改，这是你自己的事，想怎么改就怎么改。）'
    return base
  })
  // 规则文本里的名字/称呼也用 identity 优先。
  const lifeCfg = () => ({ ...cfg, botName: life.load().identity?.name || cfg.botName, ownerName: life.load().identity?.ownerName || cfg.ownerName })
  variable('auralife_rules_owner', () => rulesText('private', lifeCfg()))
  variable('auralife_rules_social', () => rulesText('social', lifeCfg()))

  const stickers = createStickerStore({ dsh: ctx, getConfig, log: logger.child('stickers') })
  const organHost = createOrganHost({ dsh: ctx, getConfig, log: logger.child('organs') })
  organHost.registerBuiltins()
  // 启动时扫描 self-made 目录：全 AI 托管，磁盘上的器官直接热加载（无批准）。
  organHost.loadSelfMade().catch((e) => log.warn('自举器官加载出错：' + e.message))
  const life = createLife({ getConfig, log: logger.child('life') })
  const chemistry = createChemistry({ life, log: logger.child('chemistry') })
  const energy = createEnergy({ life, getConfig, log: logger.child('energy') })
  const alarm = createAlarm({ life, log: logger.child('alarm') })
  // S4 器官化：把内置器官实例绑进 organ-host，能力清单 + 状态指令由 organ-host 统一聚合注入。
  organHost.bind('chemistry', chemistry)
  organHost.bind('energy', energy)
  const wishes = createWishes({ getConfig, life, log: logger.child('wishes') })
  wishes.migrateFromMemo()
  const self = createSelf({ life, dsh: ctx, getConfig, log: logger.child('self') })
  const bootstrappedGaps = new Set()
  const bootstrap = createBootstrap({ dsh: ctx, getConfig, log: logger.child('organs') })
  const local = createLocal({ getConfig, log: logger })
  const imageGen = createImageGen({ getConfig, log: logger.child('imagegen'), local })

  const dshVoice = () => {
    try { const s = ctx.speechToText; if (s) return s } catch (error) {}
    try { const s = ctx.get?.('speechToText'); if (s) return s } catch (error) {}
    try { const s = ctx.reflect?.get?.('speechToText', false); if (s) return s } catch (error) {}
    return null
  }

  const tts = {
    speak: async (text) => {
      if (local.active('tts')) {
        try {
          const file = fileOf(await local.call('tts', { text }))
          if (file && existsSync(file)) return { file, engine: 'local' }
        } catch (error) {}
      }
      return textToSpeech(text, cfg.voice, logger.child('voice'))
    },

    // STT 三档：off=关（hub 直接不转写）/ dsh=宿主自带（SenseVoice）/ custom=自定义接口（local/asr.mjs）。
    transcribe: async (buf, mime) => {
      if (cfg.voice.asr === 'custom') {
        // asr.mjs 契约 {file, log}：file 是 16k 单声道 wav 路径。先把语音条转好写进 local/out。
        const wav16 = toMono16k(buf, 16000)
        const dir = dataDir('local', 'out')
        try { mkdirSync(dir, { recursive: true }) } catch (error) {}
        const file = join(dir, `${Date.now()}-${randomUUID()}.wav`)
        writeFileSync(file, wav16)
        const out = await local.call('asr', { file, log: logger.child('local') })
        const text = String(typeof out === 'string' ? out : out?.text || out?.transcript || '').trim()
        if (!text) throw new Error('没听清（识别结果为空）')
        return text
      }
      return transcribe(buf, mime, cfg.voice, logger.child('voice'), dshVoice())
    },
    asrReady: () => cfg.voice.asr === 'custom' ? local.active('asr') : cfg.voice.asr !== 'off' && asrReady(cfg.voice, dshVoice()),

    asrInfo: () => {
      const stt = dshVoice()
      let providers = null
      try {
        const snap = stt?.snapshot ? stt.snapshot() : null
        providers = Array.isArray(snap?.providers) ? snap.providers.map((x) => x.id || x.providerId || x.name) : null
      } catch (error) {}
      return { enabled: Boolean(cfg.voice.asr), host: Boolean(stt), providers }
    },
  }

  ctx.effect(() => {
    const t = setTimeout(() => {
      try {
        const info = tts.asrInfo()
        log.info(`语音识别：${info.host ? '宿主有 speechToText' : '宿主没有 speechToText'}${info.providers ? '，识别器 ' + (info.providers.join('、') || '（还没注册）') : ''}`)
      } catch (error) {}
    }, 5000)
    return () => clearTimeout(t)
  }, 'auralife: 语音识别诊断')

  async function listModels() {
    const llm = ctx.llm || ctx.get('llm')
    const out = []
    for (const p of llm.listProviders() || []) {
      const provider = typeof p === 'string' ? p : p.provider || p.id || p.name
      try {
        for (const m of (await llm.listModels(provider)) || []) out.push({ provider, model: m.id || m.model, name: m.name || m.id || m.model })
      } catch (error) {}
    }
    return out
  }

  const web = createWebServer({ dsh: ctx, getConfig, setConfig, publicConfig, log })

  log.info('聊天存储 v2 已加载：一文件=一页（seg-001-…），媒体外置，保留天数可配')

  let memory = null
  let azone = null
  let drive = null

  const hub = createHub({
    dsh: ctx,
    getConfig,
    log: logger.child('chat'),
    stickers,
    tts,
    buildTools: (where) => {
      // 内置工具 + 她自己长出来的器官注册的工具（器官闭环：能力不只出现在清单，还能真被调用）。
      const base = buildTools({ hub, getConfig, setConfig, stickers, azone, memory, imageGen, drive, wishes, life, self, chemistry, alarm, listModels, organHost, saveAvatar: (b64, mime) => { writeFileSync(dataDir('avatar'), Buffer.from(b64, 'base64')); writeFileSync(dataDir('avatar.mime'), String(mime || 'image/png')) } }, where)
      // 器官工具是她的私房能力：只挂到主人会话（level==='full'），客人/系统会话拿不到。
      if (where.level === 'full') {
        for (const def of organHost.toolDefs()) {
          try { base.push(defineTool(def)) } catch (error) { log.warn('器官工具注册出错：' + error.message) }
        }
      }
      return base
    },
    contextProviders: [
      ({ chat }) => (chat.system ? '' : organHost.contextLine()),
      ({ chat, sessionId }) => (chat.system ? '' : memory.contextFor(chat, sessionId)),
    ],
    onActivity: (a) => {
      if (a.kind === 'in' && a.text) {
        // 内分泌确定性路径：词表命中即改，不依赖 LLM 判断。
        // 真人尺度：急性应激（被凶）皮质醇快速跳 +12 内、血清素 −2；奖赏（被夸）多巴胺相位性尖峰 +10 内、血清素 +1。
        // 被感谢是社会性接纳，是血清素的核心来源（+2）。
        try {
          const d = scoreText(a.text)
          if (d < -3) chemistry.event({ cortisol: Math.min(8, -d / 3), serotonin: -1 }, '被凶了一句')
          else if (d > 3) chemistry.event({ dopamine: Math.min(6, d / 3), serotonin: 1 }, '被夸了一句')
          if (/谢谢|多谢|感谢|辛苦/.test(a.text)) chemistry.event({ serotonin: 2, dopamine: 1 }, '被感谢了')
        } catch (error) {}
      }
      if (a.kind === 'in') life.touch('interaction')

      // 主人一说话，「被冷落」窗口就打破（她主动搭话有人理了）。
      if (a.kind === 'in') { try { drive.clearSpoke() } catch {} }

      if (a.kind === 'out' && a.reply && !String(a.chatId).startsWith('system:')) {
        const speakUp = String(a.userText || '').startsWith('【系统提醒')
        const ownerName = life.load().identity?.ownerName || cfg.ownerName || '主人'
        // 社交情绪 → 内分泌（三激素共同记录）：每轮聊完由 LLM 判这一轮的影响，直接喂激素，
        // 不再存心情数值（mood 已删）。±5 死区：轻微波动不算身体应激，避免每轮打分把皮质醇顶到 100。
        judgeChem({ dsh: ctx, getConfig, life, userText: a.userText, reply: a.reply, who: a.userId === OWNER_ID ? ownerName : '对方', origin: speakUp ? 'speak-up' : 'user' })
          .then((r) => {
            if (r && Math.abs(r.delta) >= 5) {
              if (r.delta < 0) chemistry.event({ cortisol: Math.min(6, -r.delta / 2), serotonin: -1 }, '这轮聊得不好')
              else chemistry.event({ dopamine: Math.min(5, r.delta / 2), serotonin: 1 }, '这轮聊得开心')
            }
          })
          .catch(() => {})
        // P5：从她的话里自动长出执念（只收「明确表示未知/查不到」且「不是讲道理」的句子）。
        try {
          const gap = findGapSentence(a.reply)
          if (gap && !wishes.list().some((w) => w.status === 'open' && w.text === gap)) {
            wishes.add(gap, { baseTension: 80, tensionRate: 5 })
            log.info('长出执念：「' + gap + '」')
          }
        } catch (error) {}
        // S1 器官自举：Ta 明确说「我做不了 X」/「我给自己捏了个 X」→ 生成器官，落盘立即生效。
        try {
          const capGap = capabilityGapText(a.reply)
          if (capGap && !bootstrappedGaps.has(capGap)) {
            bootstrappedGaps.add(capGap)
            if (bootstrappedGaps.size > 100) bootstrappedGaps.clear()
            bootstrap.bootstrap(capGap)
              .then(() => organHost.loadSelfMade().catch(() => {})) // 落盘后立刻扫进清单，不用重启 DSH
              .catch(() => {})
          }
        } catch (error) {}
      }
    },
    isMuted: () => false,
    emit: (type, payload) => web.emit(type, payload),
    getModelPreference: () => {
      try { const m = life.load().model; return m && m.provider && m.model ? m : null } catch { return null }
    },
  })

  memory = createMemoryV2({ dsh: ctx, getConfig, hub, log: logger.child('memory'), life, self, chemistry })
  azone = createAzone({
    getConfig, hub, log: logger.child('azone'), life,

    onDiary: (text) => memory.extractDiary(text),
  })
  const azoneSocial = createAzoneSocial({ getConfig, hub, log: logger.child('azone'), memory, azone, botName: () => life.load().identity?.name || cfg.botName || 'AuraLife', emit: (type, payload) => web.emit(type, payload) })
  drive = createDrive({ getConfig, hub, log: logger.child('drive'), life, wishes, memory, chemistry, dsh: ctx, isMuted: () => false, emit: (type, payload) => web.emit(type, payload) })

  ctx.effect(() => {
    const off = ctx.on('session/event', (session, event) => {
      try {
        // 捕获 DSH 平台真实上下文窗口（request/context 事件带 contextWindow，dsh-context 面板显示 1M 就是它）
        if (event) {
          const w = Number(event.contextWindow ?? event.data?.contextWindow)
          if (Number.isFinite(w) && w > 0) hub.setLiveWindow(w, event.model ?? event.data?.model)
        }
        hub.onSessionEvent(session, event)
      } catch (error) {
        log.warn('会话事件处理出错：', error.message)
      }
    })
    return () => { try { if (typeof off === 'function') off() } catch (error) {} }
  }, 'auralife: 盯会话')

  // P4 情绪劫持（移植自 digital-life-core index.ts:5316-5329 的 agent/request 钩子）：
  // llm/stream 的请求已冻结不能改采样，唯一能改 temperature 的是 agent/request（waterfall）。
  // 只在心情明显低落/高涨时覆盖温度，其余返回原值，不碰正常回复；reasoning 类模型不支持 temperature，跳过。
  ctx.effect(() => {
    const off = ctx.on('agent/request', async (_payload, next) => {
      const current = await next()
      try { energy.spend() } catch {} // 每次模型请求消耗一点血条
      let chem
      try { chem = chemistry.peek() } catch { return current }
      let temperature
      if (chem.cortisol >= 70) temperature = 0.3      // 皮质醇高（应激）→ 收敛克制
      else if (chem.dopamine >= 70) temperature = 0.9 // 多巴胺高（亢奋）→ 跳脱发散
      if (temperature === undefined) return current
      const model = String((current && (current.model || current.modelId)) || '').toLowerCase()
      if (model.includes('reason') || model.includes('o1') || model.includes('o3')) return current
      return { ...(current || {}), temperature }
    })
    return () => { try { if (typeof off === 'function') off() } catch (error) {} }
  }, 'auralife: 情绪劫持')

  const safe = (fn, label) => () => { Promise.resolve().then(fn).catch((e) => log.warn(label + '出错：', e.message)) }

  const whenReady = (fn) => () => { if (!cfg.setupDone) return; return fn() }
  ctx.effect(() => ctx.interval(safe(whenReady(() => azone.tick()), '空间日记'), 60_000), 'auralife: 空间日记')
  ctx.effect(() => ctx.interval(safe(whenReady(() => drive.tick()), '自驱'), 60_000), 'auralife: 自驱')
  ctx.effect(() => ctx.interval(safe(whenReady(async () => {
    // 跨天自我唤醒：扫她自己设的闹钟，到点逐个 fire（主动搭话），响完标记 fired。
    const due = alarm.fireDue()
    for (const a of due) {
      try { await drive.fireAlarm(a) } catch (e) { log.warn('闹钟唤醒出错：', e.message) }
    }
  }), '闹钟'), 60_000), 'auralife: 闹钟')
  // 器官磁盘同步：DSH 多进程下，bootstrap 落盘/卸载发生在别的进程时，本进程每分钟重扫一次磁盘，
  // 新器官自动出现在本进程的清单与工具里，删掉的器官自动从清单消失。
  ctx.effect(() => ctx.interval(safe(async () => { await organHost.refreshIfChanged() }, '器官同步'), 60_000), 'auralife: 器官同步')
  ctx.effect(() => ctx.interval(safe(() => azoneSocial.tick(), '空间互动'), 60_000), 'auralife: 空间互动')
  ctx.effect(() => ctx.interval(safe(() => memory.tick(), '记忆巩固'), 60_000), 'auralife: 记忆巩固')
  ctx.effect(() => ctx.interval(safe(() => chemistry.tick(), '内分泌衰减'), 60_000), 'auralife: 内分泌衰减')
  ctx.effect(() => ctx.interval(safe(() => energy.tick(), '能量恢复'), 60_000), 'auralife: 能量恢复')
  // 内分泌不能只在用户开口时才动。她主动搭话后主人一直不理 → 30 分钟后记一次「被冷落」。
  // （用户不回话时 drive.tick 不再评估，激素若没有这条就会永远只按半衰漂。）
  ctx.effect(() => ctx.interval(safe(() => {
    try {
      const d = drive.state()
      if (d.lastSpokeAt && !d.coldMarked && Date.now() - d.lastSpokeAt >= 30 * 60_000) {
        if (hub.lastOwnerChatAt < d.lastSpokeAt) {
          chemistry.event({ cortisol: 4, serotonin: -4, dopamine: -2 }, '主动搭话没人理')
          drive.markCold()
        }
      }
    } catch (error) {}
  }, '冷落检测'), 60_000), 'auralife: 冷落检测')
  ctx.effect(() => ctx.interval(safe(() => organHost.tickAll(), '自举器官心跳'), 60_000), 'auralife: 自举器官心跳')
  ctx.effect(() => ctx.interval(safe(() => hub.cleanupVoice(), '语音条清理'), 60 * 60_000), 'auralife: 语音条清理')

  // 宿主信息（「关于」页展示 DSH 版本 / 操作系统）
  const hostInfo = () => {
    let dshVersion = null
    try { if (ctx.version) dshVersion = String(ctx.version) } catch (error) {}
    try { if (!dshVersion) { const v = ctx.get?.('version'); if (v) dshVersion = String(v) } } catch (error) {}
    try { if (!dshVersion) { const v = ctx.reflect?.get?.('version', false); if (v) dshVersion = String(v) } } catch (error) {}
    return { dshVersion, node: process.version, platform: process.platform, arch: process.arch }
  }

  web.register(ctx, { hub, azone, stickers, memory, drive, imageGen, listModels, azoneSocial, logger, asrInfo: tts.asrInfo, rebindPort: () => web.listenPort(), self, life, wishes, organHost, chemistry, energy, alarm, hostInfo })

  ctx.effect(() => {
    web.listenPort()
    return () => { try { web.closePort() } catch (error) {} }
  }, 'auralife: 固定入口')

  return { hub, stickers, azone, memory, getConfig, setConfig, logger }
}
