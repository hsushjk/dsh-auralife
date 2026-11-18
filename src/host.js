import { existsSync, statSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs'
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
import { createSleep } from './life/sleep.js'
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
  // 配置落盘串行队列：内存 cfg 立即生效（热生效语义不变），磁盘写入排队执行。
  // 多进程下 config.json 读-改-写必须进锁；更重要的是**不能在锁内拿本进程启动时的旧快照整份覆盖**——
  // 锁只防并发，防不了「A 进程拿着 10 分钟前的内存 cfg、把 B 进程刚保存的设置整份盖回去」。
  // 正确做法：锁内重新读盘 → 把本次 patch 合并到最新磁盘内容 → 落盘 → 用落盘结果回写内存。
  let configSaveChain = Promise.resolve()
  const setConfig = (patch) => {
    cfg = mergeFromPanel(cfg, patch) // 本进程立即生效
    maxLogMB = Number(cfg.logs?.maxMB) || 2
    configSaveChain = configSaveChain
      .then(() => withFileLock('config', () => {
        const disk = loadConfig()
        const merged = mergeFromPanel(disk, patch)
        saveConfig(merged)
        return merged
      }, { staleMs: 5000, timeoutMs: 8000 }))
      .then((merged) => {
        cfg = merged
        maxLogMB = Number(cfg.logs?.maxMB) || 2
      })
      .catch((error) => { log.warn('配置保存失败：' + (error?.message || error)) })
    return configSaveChain
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
  const bootstrap = createBootstrap({ dsh: ctx, getConfig, log: logger.child('organs'), audit: organHost.audit })
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
        // 临时 wav 用完即删：识别成功、失败、超时都要清，别在 data 目录里越攒越多。
        try {
          const out = await local.call('asr', { file, log: logger.child('local') })
          const text = String(typeof out === 'string' ? out : out?.text || out?.transcript || '').trim()
          if (!text) throw new Error('没听清（识别结果为空）')
          return text
        } finally {
          try { unlinkSync(file) } catch (error) {}
        }
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
  let sleep = null

  const hub = createHub({
    dsh: ctx,
    getConfig,
    log: logger.child('chat'),
    stickers,
    tts,
    // 睡眠是硬状态：hub 里判「睡着时被找」要用（#25），getter 延迟取避免循环依赖。
    sleepStage: () => sleep,
    energy: () => energy,
    // #7：身体状态（体力/激素/睡眠）不进会话级缓存的能力清单，每轮说话时现取现拼，
    // 避免 DSH 侧把 systemPrompt.context 的 text() 按会话缓存后一直用旧快照。
    dynamicContext: () => {
      try { return [energy.contextLine(), chemistry.contextLine?.(), sleep?.contextLine?.()].filter(Boolean).join('\n') } catch { return '' }
    },
    buildTools: (where) => {
      // 内置工具 + 她自己长出来的器官注册的工具（器官闭环：能力不只出现在清单，还能真被调用）。
      const base = buildTools({ hub, getConfig, setConfig, stickers, azone, memory, imageGen, drive, wishes, life, self, chemistry, alarm, listModels, organHost, saveAvatar: (b64, mime) => { writeFileSync(dataDir('avatar'), Buffer.from(b64, 'base64')); writeFileSync(dataDir('avatar.mime'), String(mime || 'image/png')) } }, where)
      // #4：器官是她的私房能力，只挂给主人本人；客人即使被开了 full 也拿不到（改人格/写记忆的桶只对主人开）。
      if (where.level === 'full' && where.chat?.userId === OWNER_ID) {
        for (const def of organHost.toolDefs()) {
          try { base.push(defineTool(def)) } catch (error) { log.warn('器官工具注册出错：' + error.message) }
        }
      }
      return base
    },
    contextProviders: [
      // 能力清单是静态的，可以随会话缓存；身体状态改走 dynamicContext 每轮注入（#7）。
      ({ chat }) => (chat.system ? '' : (organHost.capabilityLine?.() || '')),
      ({ chat, sessionId }) => (chat.system ? '' : memory.contextFor(chat, sessionId)),
    ],
    onActivity: (a) => {
      if (a.kind === 'in' && a.text) {
        // 内分泌确定性路径：词表命中即改，不依赖 LLM 判断。
        // 真人尺度：急性应激（被凶）皮质醇快速跳 +12 内、血清素 −2；奖赏（被夸）多巴胺相位性尖峰 +10 内、血清素 +1。
        // 被感谢是社会性接纳，是血清素的核心来源（+2）。
        try {
          const d = scoreText(a.text)
          if (d < -3) chemistry.event({ cortisol: Math.min(8, -d / 3), serotonin: -1 }, '被凶了一句').catch(() => {})
          else if (d > 3) chemistry.event({ dopamine: Math.min(6, d / 3), serotonin: 1 }, '被夸了一句').catch(() => {})
          if (/谢谢|多谢|感谢|辛苦/.test(a.text)) chemistry.event({ serotonin: 2, dopamine: 1 }, '被感谢了').catch(() => {})
        } catch (error) {}
      }
      if (a.kind === 'in') life.touch('interaction').catch(() => {})
      // #37：主人消息要把「上次被看见」落盘，其它模块（azone 日记/冷落检测）靠它跨进程、跨重启判断。
      // #4：只认主人本人，跟 level 无关——客人被开了 full 也不算「主人看见」。
      if (a.kind === 'in' && a.userId === OWNER_ID) life.touch('seen').catch(() => {})

      // 主人一说话，「被冷落」窗口就打破（她主动搭话有人理了）。
      if (a.kind === 'in') { try { drive.clearSpoke() } catch {} }

      if (a.kind === 'out' && a.reply && !String(a.chatId).startsWith('system:')) {
        const speakUp = String(a.userText || '').startsWith('【系统提醒')
        const ownerName = life.load().identity?.ownerName || cfg.ownerName || '主人'
        // 社交情绪 → 内分泌（三激素共同记录）：每轮聊完由 LLM 判这一轮的影响，直接喂激素，
        // 不再存心情数值（mood 已删）。±5 死区：轻微波动不算身体应激，避免每轮打分把皮质醇顶到 100。
        judgeChem({ dsh: ctx, getConfig, life, userText: a.userText, reply: a.reply, who: a.userId === OWNER_ID ? ownerName : '对方', origin: speakUp ? 'speak-up' : 'user' })
          .then((r) => {
            // #35：confidence 终于被读了——规则命中是 0.6，模型自己没把握（<0.4）的结果不采信。
            if (!r || Math.abs(r.delta) < 5) return
            if (r.confidence != null && r.confidence < 0.4) return
            if (r.delta < 0) chemistry.event({ cortisol: Math.min(6, -r.delta / 2), serotonin: -1 }, '这轮聊得不好').catch(() => {})
            else chemistry.event({ dopamine: Math.min(5, r.delta / 2), serotonin: 1 }, '这轮聊得开心').catch(() => {})
            // #38：情绪够重的一轮留个「有感而发」的由头，下次日记触发时能带着它写。
            if (Math.abs(r.delta) >= 8) {
              try { azone?.noteEvent?.(`刚才那轮${r.delta > 0 ? '聊得很开心' : '聊得有点难受'}：${String(r.reason || '').slice(0, 80)}`) } catch (error) {}
              // #13：聊得重的一轮，也让她想一想「这段关系里我是什么样的人」。
              if (a.userId === OWNER_ID) { try { maybeReflectSelf('聊得重') } catch (error) {} }
            }
          })
          .catch(() => {})
        // #6/#13：主人聊了几轮，让她有机会从最近这段对话里长一点自我认知（内部 6 小时节流）。
        if (a.userId === OWNER_ID) { try { maybeReflectSelf('主人这一轮') } catch (error) {} }
        // P5：从她的话里自动长出执念（只收「明确表示未知/查不到」且「不是讲道理」的句子）。
        // #34：缺口收割要有来源判断——只认主人会话里她自己说的话；客人把话带偏后种下的执念会烧她的自驱。
        // chatId 记来源，wishes.add 内部按归一化文本判重（不再只跟 open 完全同字比）。
        try {
          const ownerTurn = a.userId === OWNER_ID
          if (ownerTurn) {
            const gap = findGapSentence(a.reply)
            if (gap) {
              wishes.add(gap, { baseTension: 80, tensionRate: 5, chatId: a.chatId })
                .then((w) => { if (w) log.info('长出执念：「' + gap + '」') })
                .catch((error) => log.warn('种执念失败：' + (error?.message || error)))
            }
          }
        } catch (error) {}
        // S1 器官自举：Ta 明确说「我做不了 X」/「我给自己捏了个 X」→ 生成器官，落盘立即生效。
        // 只允许主人会话触发：客人把 Ta 带偏后让她自己写器官往外传文件，是沙箱要防的核心风险之一；
        // 客人会话命中缺口只记审计、不自举（不改变对客人的回复，只是不落盘器官）。
        try {
          const capGap = capabilityGapText(a.reply)
          const ownerTurn = a.userId === OWNER_ID
          if (capGap && !bootstrappedGaps.has(capGap)) {
            if (!ownerTurn) {
              organHost.audit.append({ event: 'bootstrap_skip', reason: 'guest-chat', chatId: a.chatId, userId: a.userId || '', gap: capGap.slice(0, 120) })
            } else {
              bootstrappedGaps.add(capGap)
              if (bootstrappedGaps.size > 100) bootstrappedGaps.clear()
              organHost.audit.append({ event: 'bootstrap', chatId: a.chatId, gap: capGap.slice(0, 120) })
              bootstrap.bootstrap(capGap)
                .then(() => organHost.loadSelfMade().catch(() => {})) // 落盘后立刻扫进清单，不用重启 DSH
                .catch((error) => {
                  log.warn('器官自举失败：' + (error?.message || error))
                  organHost.audit.append({ event: 'bootstrap_failed', gap: capGap.slice(0, 120), error: String(error?.message || error).slice(0, 200) })
                })
            }
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
  drive = createDrive({ getConfig, hub, log: logger.child('drive'), life, wishes, memory, chemistry, self: () => self, alarm: () => alarm, dsh: ctx, isMuted: () => false, emit: (type, payload) => web.emit(type, payload), sleep: () => sleep, energy: () => energy })

  // #6/#13：自我不只靠记忆重放长——聊得深/情绪重的时候，她也会想一想「我是什么样的人」。
  // 节流：6 小时内最多反省一次，且同时只跑一个（模型调用不能把聊天卡住）。
  let selfReflectAt = 0
  let selfReflecting = false
  async function maybeReflectSelf(reason) {
    if (selfReflecting) return
    if (Date.now() - selfReflectAt < 6 * 3600_000) return
    // #13a：先把时间记上——模型回「没有新东西」或反省失败也算跑过一次，
    // 不然之后每轮主人消息都会白烧一次模型。跨进程用 state.self.lastReflectAt 兜底。
    selfReflecting = true
    selfReflectAt = Date.now()
    try {
      const s0 = life.load()
      if (Date.now() - (Number(s0.self?.lastReflectAt) || 0) < 6 * 3600_000) return
      const recent = hub.recentChat(OWNER_ID, 8)
      if (!recent || recent.length < 3) return
      // 先占住跨进程节流位，再调模型（模型挂住也不会让别的进程再来一次）。
      await life.update((s) => { s.self = { ...(s.self || {}), lastReflectAt: Date.now() } })
      const r = await self.consider({ recent, chemistry: chemistry.peek(), now: Date.now() })
      if (r && r.merged) {
        log.info(`自我认知更新（${reason}）：${String(JSON.stringify(r.extracted)).slice(0, 160)}`)
      }
    } catch (error) {
      log.warn('自我反省失败：' + (error?.message || error))
    } finally {
      selfReflecting = false
    }
  }

  // 睡眠/梦（#18 #24 #25）：硬状态进 state.json（跨进程可见），梦在睡眠 1/3、2/3 处各做一次。
  sleep = createSleep({
    life,
    energy,
    chemistry,
    dsh: ctx,
    getConfig,
    log: logger.child('sleep'),
    memory: () => memory,
    drive: () => drive,
    notify: async (text) => {
      const owner = life.load().identity?.ownerName || cfg.ownerName || '主人'
      await hub.pushToSession({ chatId: OWNER_ID, userId: OWNER_ID, nickname: owner }, [{ type: 'text', text }], '')
    },
    writeDiary: async (opts) => { try { await azone?.writeDiary?.(opts || {}) } catch (error) {} },
  })

  ctx.effect(() => {
    const off = ctx.on('session/event', (session, event) => {
      let handled
      try {
        // 捕获 DSH 平台真实上下文窗口（request/context 事件带 contextWindow，dsh-context 面板显示 1M 就是它）
        if (event) {
          const w = Number(event.contextWindow ?? event.data?.contextWindow)
          if (Number.isFinite(w) && w > 0) hub.setLiveWindow(w, event.model ?? event.data?.model)
        }
        handled = hub.onSessionEvent(session, event)
      } catch (error) {
        log.warn('会话事件处理出错：', error.message)
        return
      }
      // onSessionEvent 现在可能异步落盘（历史补丁/会话映射），失败也要接住，不能变成 unhandled rejection。
      if (handled && typeof handled.catch === 'function') handled.catch((error) => log.warn('会话事件处理出错：' + (error?.message || error)))
    })
    return () => { try { if (typeof off === 'function') off() } catch (error) {} }
  }, 'auralife: 盯会话')

  // P4 情绪劫持（移植自 digital-life-core index.ts:5316-5329 的 agent/request 钩子）：
  // llm/stream 的请求已冻结不能改采样，唯一能改 temperature 的是 agent/request（waterfall）。
  // 只在心情明显低落/高涨时覆盖温度，其余返回原值，不碰正常回复；reasoning 类模型不支持 temperature，跳过。
  ctx.effect(() => {
    const off = ctx.on('agent/request', async (_payload, next) => {
      const current = await next()
      try { energy.spend().catch(() => {}) } catch {} // 每次模型请求消耗一点血条
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
  // 睡眠/梦：进/出静默期、drowsy 回睡、睡眠 1/3、2/3 处做梦。
  ctx.effect(() => ctx.interval(safe(whenReady(() => sleep.tick()), '睡眠/梦'), 60_000), 'auralife: 睡眠/梦')
  ctx.effect(() => ctx.interval(safe(whenReady(() => drive.tick()), '自驱'), 60_000), 'auralife: 自驱')
  ctx.effect(() => ctx.interval(safe(whenReady(async () => {
    // 跨天自我唤醒：扫她自己设的闹钟，到点逐个 fire（主动搭话）。
    // 两段式（#31）：认领 → 发成功才 markFired；发失败 failFired 退避重试（最多 2 次），不再永久丢提醒。
    const due = await alarm.fireDue()
    for (const a of due) {
      try {
        const sent = await drive.fireAlarm(a)
        if (sent) await alarm.markFired(a.id)
        else await alarm.failFired(a.id, '没发出去')
      } catch (e) {
        log.warn('闹钟唤醒出错：', e.message)
        await alarm.failFired(a.id, e.message).catch(() => {})
      }
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
        // #37：主人最后说话时间不能只看进程内存（重启归零会误判「没人理」）；用落盘的 life.lastSeenAt 兜底。
        const lastOwner = Math.max(Number(hub.lastOwnerChatAt) || 0, Number(life.load()?.life?.lastSeenAt) || 0)
        if (lastOwner < d.lastSpokeAt) {
          chemistry.event({ cortisol: 4, serotonin: -4, dopamine: -2 }, '主动搭话没人理').catch(() => {})
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

  web.register(ctx, { hub, azone, stickers, memory, drive, imageGen, listModels, azoneSocial, logger, asrInfo: tts.asrInfo, rebindPort: () => web.listenPort(), self, life, wishes, organHost, chemistry, energy, alarm, sleep, hostInfo })

  ctx.effect(() => {
    web.listenPort()
    return () => { try { web.closePort() } catch (error) {} }
  }, 'auralife: 固定入口')

  return { hub, stickers, azone, memory, drive, sleep, getConfig, setConfig, logger }
}
