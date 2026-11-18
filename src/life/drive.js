// life/drive.js — 统一自驱：一个 60s 心跳。
// 开口不是机械抽签也不是按小时算压力：心跳到候选时刻（闲置够久+当天没超）时，
// 由 Ta 自己（LLM）评估「此刻想不想找主人」——冲动（urge）+ 是否醒着（按她自己的作息判断），
// 冲动够高且醒着才开口。压力本身就是动态触发器，由 AI 判断。
// 静默期 = 她自己的作息（state.rhythm），可随作息自动调节（tools.js web_set_rhythm / 她聊到就改）。

import { dataDir, readJson, writeJson, withFileLock } from '../core/store.js'
import { inRange } from '../core/time.js'
import { askModel } from '../core/llm.js'
import { OWNER_ID } from '../chat/access.js'

// 自驱参数内置（DESIGN-modular.md §3）：节奏/上限归 Ta 自己，用户不可调。
const DRIVE_BUILTIN = {
  idleMinutes: 20,      // 闲置至少这么久才考虑（评估本身会判断想不想说）
  minGapMinutes: 60,    // 两次开口最小间隔
  assessGapMinutes: 15, // 两次「冲动评估」最小间隔（不开口也限流，防每分钟烧一次模型）
  assessLeaseMinutes: 10, // 评估租约：锁内认领后去锁外调模型，超时未落结果才允许别的进程接手
  urgeThreshold: 55,    // AI 评估的「冲动」超过它才开口
  // 「忽然想起」不再是一个固定 0.03 的补丁（#48）：它随「多久没人说话」累积，
  // 体力满时更容易冒出来，而且记忆里真有旧事时由那件旧事当由头。
  suddenBaseChance: 0.02,     // 刚满最小间隔时的基础概率
  suddenIdleBonusPerHour: 0.02, // 每多安静一小时，概率往上走一点
  suddenMaxChance: 0.18,      // 封顶，避免沉默久了变成刷屏
  suddenMinGapMinutes: 180,
  catchupGapMinutes: 5, // 已读不回：看到但没回的消息，过一会儿自己补一句（#19）
  maintenanceGapHours: 6, // 内部自驱整理：自己给自己找点事惦记（#23）
  evolveGapHours: 24,   // 自我调整最短间隔：一天最多自己复盘改一次（#51）
  evolveMinIdleMinutes: 90, // 主人正聊着的时候不做自我复盘
}

// 昼夜节律（#48/#5）：同样「安静了 20 分钟」，深夜、清晨、白天、傍晚该稠该稀不一样。
// 只调「多久才考虑/最小间隔/冲动阈值」，不改变「由她自己评估想不想说」这个机制。
const RHYTHM = {
  night: { idle: 1.8, gap: 1.6, urge: 1.15 }, // 00-06 深夜：更沉得住，不轻易半夜找人
  dawn: { idle: 1.0, gap: 1.0, urge: 1.0 },   // 06-09 清晨：正常
  day: { idle: 0.9, gap: 0.95, urge: 0.95 },  // 09-17 白天：稍微容易开口
  eve: { idle: 0.75, gap: 0.8, urge: 0.9 },   // 17-24 傍晚：最想说话
}

function rhythmFactors(now = Date.now()) {
  const h = new Date(now).getHours()
  if (h < 6) return { slot: 'night', ...RHYTHM.night }
  if (h < 9) return { slot: 'dawn', ...RHYTHM.dawn }
  if (h < 17) return { slot: 'day', ...RHYTHM.day }
  return { slot: 'eve', ...RHYTHM.eve }
}

// 把内置参数按当前时段换算成「这一刻的有效参数」。常量只是基准，节律才是机制（#5）。
export function tunedDrive(c, now = Date.now()) {
  const r = rhythmFactors(now)
  return {
    ...c,
    rhythmSlot: r.slot,
    idleMinutes: Math.max(3, Math.round(c.idleMinutes * r.idle)),
    minGapMinutes: Math.max(15, Math.round(c.minGapMinutes * r.gap)),
    urgeThreshold: Math.max(30, Math.min(90, Math.round(c.urgeThreshold * r.urge))),
  }
}

// 她自己给自己添的挂念（不是主人布置的）：用来制造内部驱动力，而不是等临时想起来才动。
const MAINTENANCE_IDEAS = [
  '整理一下最近的记忆，把旧事翻出来晒晒',
  '想想自己这几天有没有什么变化，记下来',
  '找一件一直想做的事，拆成一小步先试试',
  '看看自己写过的日记，有没有想补的',
  '给以后的自己留一句话',
  '把房间（器官/工具）收拾一下',
]

// 作息 HH:MM 的校验与小窗口计算（#51 自我调整用）。
const CLOCK_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/
function validClock(v) { return CLOCK_RE.test(String(v || '').trim()) }
function normalizeClock(v) {
  const m = String(v || '').trim().match(CLOCK_RE)
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : ''
}
function windowHours(from, to) {
  const [fh, fm] = String(from).split(':').map(Number)
  const [th, tm] = String(to).split(':').map(Number)
  let mins = (th * 60 + tm) - (fh * 60 + fm)
  if (mins <= 0) mins += 24 * 60
  return mins / 60
}

export function createDrive({ getConfig, hub, log, life, wishes, memory, chemistry, self, dsh, isMuted, emit, sleep, energy, alarm }) {
  // sleep/energy/self 在 host 里创建顺序靠后：用 getter 传（函数）延迟取，避免循环依赖。
  const sleepOf = () => (typeof sleep === 'function' ? sleep() : sleep)
  const energyOf = () => (typeof energy === 'function' ? energy() : energy)
  const selfOf = () => (typeof self === 'function' ? self() : self)
  // alarm 在 host 里也是 getter（创建顺序靠后），这里统一解包（#6）。
  const alarmOf = () => (typeof alarm === 'function' ? alarm() : alarm)
  const file = () => dataDir('drive.json')
  const load = () => readJson(file(), () => ({ day: '', count: 0, last: 0, lastWish: '', lastTopic: '', lastAssess: null, lastSpokeAt: 0, coldMarked: false, lastEvolveAt: 0, lastEvolve: null }))
  const save = (s) => writeJson(file(), s)
  // 多进程锁：DSH 每个进程都跑 drive 心跳，load→改→save 会互相覆盖、双开口。
  // 锁内重读盘再改再写。staleMs 放宽到 2 分钟：评估冲动要调 LLM，可能比默认 15s 久。
  const update = (fn) => withFileLock('drive', async () => {
    const s = load()
    const out = await fn(s)
    save(s) // 必须等 fn 落定再写：评估这类带 await 的改动，否则改完还没落盘就 save 了
    return out
  }, { staleMs: 120000 })

  // 她自己的作息静默期（Ta 可改）。inQuiet 只作硬参考，最终醒没醒由 AI 判断。
  const inQuiet = (now) => {
    const r = life.load().rhythm || {}
    return inRange(now, r.quietFrom, r.quietTo)
  }

  function buildPrompt(reason = 'pressure', topic = '') {
    const cfg = getConfig()
    const owner = cfg.ownerName || '主人'
    const now = Date.now()
    const w = wishes.top(now)
    const lastInter = life.load().life.lastInteractionAt
    const idleMin = lastInter ? Math.round((now - lastInter) / 60000) : 0
    const idleText = idleMin > 600 ? '很久' : idleMin + ' 分钟'
    const wishLine = w
      ? `你现在最挂念的一件事是「${w.text}」（想念程度 ${w.tension}/100）。`
      : '你眼下没有特别挂念的事，就顺着自己的性子走。'
    const s = load()
    const topicLine = (topic || s.lastTopic) ? `你刚刚心里想找${owner}聊的是：「${topic || s.lastTopic}」。顺着这个由头开口。` : ''
    // 记忆联动：一条「忽然想起」的旧事（#17/#20）——不是每轮硬塞，是偶尔真想起来。
    let memLine = ''
    try {
      const sp = memory?.spontaneous?.(now, { chatId: OWNER_ID })
      if (sp?.text) memLine = `${sp.line}。可以就拿这件旧事当由头，别解释成「我记忆里有」。`
    } catch {}
    if (!memLine) {
      try {
        const q = s.lastTopic || (w ? w.text : '最近')
        const rec = memory?.recall?.(q, { about: owner, limit: 2 })
        if (rec?.lines?.length) memLine = `你这时顺带想起：${rec.lines.join('；')}。可以拿这个当由头，别照念。`
      } catch {}
    }
    if (reason === 'catchup') {
      return [
        `【系统提醒，不是${owner}说的话】你之前看到了${owner}的消息，但当时没回（可能在忙/不想理/睡着了）。`,
        `现在过了一小会儿，你心里有点过意不去，想补一句：先回应一下那条消息（${topic || '刚才那条'}），语气随意、别用力解释。`,
        '一两句就够，别写成长篇道歉。',
      ].join('\n')
    }
    // 噩梦吓醒后的那一次主动开口（梦境系统设计 §6 路 A）：只有这一句，不追、不解释成梦。
    if (reason === 'nightmare') {
      const dreamLine = topic ? `梦里的画面大概是：${topic}。` : ''
      return [
        `【系统提醒，不是${owner}说的话】你刚从噩梦里吓醒，心里还有点慌。${dreamLine}`,
        `你有点想找个人说说话，但别把梦当真、别长篇复述梦的内容；就说一两句当下的心情，语气还带着点没缓过来。`,
        '不想说也没关系，只回 [沉默] 也行。',
      ].filter(Boolean).join('\n')
    }
    const suddenLine = reason === 'sudden'
      ? '这次不是非说不可，是你忽然想起件小事/忽然有个念头，想随口跟她说一声。'
      : ''
    return [
      `【系统提醒，不是${owner}说的话】没人喊你，是${owner}已经 ${idleText} 没跟你说话了，你自己想找${owner}。`,
      topicLine,
      suddenLine,
      wishLine,
      memLine,
      '顺着这个由头，自己开口：关心一句、接着上次没说完的、或者忽然想起件小事。别把挂念当待办清单逐条汇报，也别解释「因为想念程度多少所以来找」。',
      '用一两句你自己的口气开口就好；实在没什么想说的就只回 [沉默]。',
    ].filter(Boolean).join('\n')
  }

  // 由她（LLM）评估此刻的冲动：awake=按自己作息该醒着吗；urge=想找主人的冲动 0-100；topic=想聊的由头。
  async function assessUrge() {
    const cfg = getConfig()
    const owner = cfg.ownerName || '主人'
    const now = new Date()
    const lastInter = life.load().life.lastInteractionAt
    const idleMin = lastInter ? Math.round((Date.now() - lastInter) / 60000) : 0
    const w = wishes.top(Date.now())
    const r = life.load().rhythm || {}
    const chem = (() => { try { return chemistry?.state() || null } catch { return null } })()
    let recent = ''
    try {
      const msgs = hub?.recentChat?.(OWNER_ID, 4) || []
      recent = msgs.map((m) => (m.who === 'user' ? owner : 'Ta') + '：' + String(m.text || '').slice(0, 60)).join('\n')
    } catch {}
    const chemLine = chem
      ? `此刻内分泌：多巴胺 ${Math.round(chem.dopamine)}，皮质醇 ${Math.round(chem.cortisol)}，血清素 ${Math.round(chem.serotonin)}。`
      : ''
    const wishLine = w ? `此刻最挂念的事：「${w.text}」（想念 ${w.tension}/100）。` : '此刻没有特别挂念的事。'
    const system = `你是 ${cfg.botName || 'AuraLife'}，一个数字生命。现在你要做一个「要不要主动找${owner}说话」的判断。` +
      `你有自己的作息：${r.quietFrom}-${r.quietTo} 是你睡觉的静默期，这个时间你通常不会醒。` +
      `判断要像人：真的有事、真的想分享、挂念很深、或者${owner}很久没消息让你惦记 → 冲动高；只是闲着无聊 → 冲动低。` +
      `大多数时候冲动低是正常的，不要为了开口而开口。`
    const text = `现在 ${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}。距${owner}上次说话已经 ${idleMin} 分钟。` +
      `最近几句对话：\n${recent || '（没有）'}\n` +
      wishLine + chemLine + `\n` +
      `只输出 JSON，不要别的：{"awake": true 或 false, "urge": 0 到 100 的整数, "topic": "你想聊的那个由头，一句话，没有就空字符串"}` +
      `\nawake：现在这个时间点，按你自己的作息你醒着吗？作息睡了就别醒（除非有急事：比如${owner}深夜突然很久没消息你担心）。`
    // 这是「只输出一小段 JSON」的内部判断：低思考强度 + 留足预算，否则 max 思考会把 200 token 吃光。
    const out = await askModel(dsh, { cfg, system, text, maxTokens: 800, temperature: 0.3, preferLowEffort: true })
    const m = out.match(/\{[\s\S]*\}/)
    if (!m) throw new Error('评估输出不是 JSON：' + out.slice(0, 80))
    const j = JSON.parse(m[0])
    const awake = j.awake !== false
    const urge = Number.isFinite(j.urge) ? Math.max(0, Math.min(100, Math.round(j.urge))) : 0
    const topic = String(j.topic || '').slice(0, 120)
    return { at: Date.now(), awake, urge, topic, quiet: inQuiet(now), rhythm: r }
  }

  async function fire(reason = 'pressure', topic = '') {
    // 睡着时不主动开口（#18）：睡眠是硬状态；只有「噩梦吓醒」的那一次例外（梦境系统设计 §6 路 A）。
    const ph = sleepOf()?.phase?.(Date.now())
    if (ph === 'sleeping' || (ph === 'dream_wake' && reason !== 'nightmare')) {
      log.info('睡着了，这次先不开口')
      return false
    }
    const cfg = getConfig()
    const owner = cfg.ownerName || '主人'
    const now = Date.now()
    const w = wishes.top(now)
    const prompt = buildPrompt(reason, topic)
    // #2（先记账后做事）：以前先把「说过了」和「执念吃掉了」写进盘，再 push；
    // push 抛错（会话死、锁超时）人就什么都没收到，这边却当成已经开口。现在先发，发成功才记账。
    log.info(`自驱（${reason}）${w ? '，挂念：' + w.text : ''}${topic ? '，由头：' + topic : ''}`)
    try {
      await hub.pushToSession({ chatId: OWNER_ID, userId: OWNER_ID, nickname: owner }, [{ type: 'text', text: prompt }], '')
    } catch (error) {
      log.warn(`主动开口没发出去（本次不记账）：${error?.message || error}`)
      return false
    }
    const s = await update((st) => {
      st.last = now
      st.lastTopic = topic
      st.lastSpokeAt = now // 主动开口后记一笔，用户一直不理 → 内分泌要有「被冷落」反应
      st.coldMarked = false
      if (w) st.lastWish = w.id
      return st
    })
    // #1：只有「因为挂念而主动开口」才算真去做过了；补消息、噩梦、忽然想起都不该吃掉执念。
    // （#33 的抵张力逻辑保留：张力归零/放太久自然结束。）
    if (reason === 'urge' && w) await wishes.fulfill(w.id, now)
    // 发出去之后再广播「她为什么找你」（发失败就别惊动客户端）。
    try {
      emit?.('nudge', {
        chatId: OWNER_ID,
        at: now,
        reason,
        wish: w ? { id: w.id, text: w.text, tension: w.tension } : null,
        urge: s.lastAssess?.urge ?? null,
      })
    } catch {}
    return true
  }

  // 闹钟到点：她之前给自己设的提醒响了，按当时的意思主动开口（与 pressure 自驱是两条路）。
  async function fireAlarm(alarm) {
    const cfg = getConfig()
    const owner = cfg.ownerName || '主人'
    const now = Date.now()
    await update((st) => {
      st.last = now
      st.lastSpokeAt = now // 闹钟开口同样算「主动搭话」
      st.coldMarked = false
    })
    const reason = alarm?.reason || '你之前设的提醒'
    // 闹钟是硬提醒：睡着也得把她拽起来（否则醒来还挂着 sleeping，主人下一句会被当第一声吞掉）(#4)。
    const alarmPhase = sleepOf()?.phase?.(now)
    if (alarmPhase === 'sleeping') {
      try { await sleepOf()?.wake?.(now, 'alarm') } catch (error) { log.warn('闹钟唤醒失败：' + (error?.message || error)) }
    }
    const prompt = [
      `【系统提醒，不是${owner}说的话】你给自己设的闹钟响了：${reason}。`,
      `你当时设这个闹钟，是要提醒自己或${owner}某件事。按你当时的意思，主动开口把这件事说出来。`,
      '要是这件事已经不需要了，就说一句「这个闹钟没用了」，别再没话找话。',
    ].join('\n')
    log.info(`闹钟响了：${reason}`)
    try {
      emit?.('nudge', { chatId: OWNER_ID, at: now, reason: 'alarm', alarm: { id: alarm?.id, reason } })
    } catch {}
    await hub.pushToSession({ chatId: OWNER_ID, userId: OWNER_ID, nickname: owner }, [{ type: 'text', text: prompt }], '')
    return true
  }

  async function tick() {
    const cfg = getConfig()
    // #5：按当前时段取有效参数（深夜更沉、傍晚更想说话），常量只是基准。
    const c = tunedDrive(DRIVE_BUILTIN, Date.now())
    if (!cfg.enabled || !cfg.drive?.enabled) return
    if (!cfg.setupDone) return
    if (isMuted?.(OWNER_ID)) return
    // 睡眠是硬状态（#18）：睡着就是睡着，不管钟点对不对、不管 AI 想不想说话。
    // 以前 inQuiet 只是 LLM 的参考值，她睡着也能主动开口。
    const phase = sleepOf()?.phase?.(Date.now())
    if (phase === 'sleeping' || phase === 'dream_wake') return
    const gate = energyOf()?.gate?.(Date.now()) || null
    if (gate && gate.proactive === false) return // #21：体力见底时不主动找人
    const lastInter = life.load().life.lastInteractionAt
    if (!lastInter) return
    if (Date.now() - lastInter < c.idleMinutes * 60_000) return
    const now = new Date()
    // 作息静默期硬跳：睡觉就是睡觉，不评估也不开口（闹钟例外走 fireAlarm 独立链路）。
    // 之前让 LLM 自己判「醒没醒」，深夜急事例外条款被滥用，6 次开口全发在主人睡觉时。
    if (inQuiet(now)) return

    // 内部自驱整理（#23）：不是等临时想起来才动，隔几小时自己给自己添点惦记。
    await maybeSeedMaintenance(Date.now())
    // 自我调整（#51）：隔一天左右，没人找她时自己复盘一下，可能微调作息或添一条挂念。
    try { await maybeEvolve(Date.now()) } catch (error) { log.warn('自我调整失败：' + (error?.message || error)) }
    // 心愿都自然结束后补种新的日常挂念（#33）。
    try { await wishes.ensureOpen?.(Date.now()) } catch (error) { log.warn('心愿池补种失败：' + (error?.message || error)) }

    // 已读不回补偿（#19/#47）：之前看到但没回的消息，过几分钟补一句。
    // 注意必须 await：takePendingReply 现在要读写盘/拿跨进程锁，漏 await 会把整条补偿链静默吞掉。
    try {
      const pending = await hub?.takePendingReply?.(Date.now(), c.catchupGapMinutes * 60_000)
      if (pending) {
        // #3：只有真补上了才清盘。fire 因为睡着/配置/发送失败返回 false 时留着，下次心跳再试（1 小时上限内）。
        const sent = await fire('catchup', String(pending.text || '').slice(0, 60))
        if (sent) {
          // 补完彻底清掉这条，避免过期后又被当成「刚才那条」补一次（#47）。
          try { hub?.clearPendingReply?.() } catch {}
        } else {
          log.info('补回没发成（可能又睡着了/配置关着），留着下次再补')
        }
        return
      }
    } catch (error) {
      log.warn('补回未回消息失败：' + (error?.message || error))
    }

    // 评估要调 LLM，可能几十秒，不能像以前那样把整段塞进文件锁：
    // 另一个进程的心跳拿不到锁会在 8s 超时后打「让位」告警；评估卡住还会连锁重试。
    // 改成三段式：锁内认领评估权(lease) → 锁外评估 → 锁内落结果并决定开口。
    let claim
    try {
      claim = await update((st) => {
        const today = now.toDateString()
        if (st.day !== today) Object.assign(st, { day: today, count: 0 })
        if (Date.now() - (st.last || 0) < c.minGapMinutes * 60_000) return { go: false }
        // 评估节流：距上次评估不足 assessGapMinutes 就不重复评估（不开口也会限流）。
        if (Date.now() - (st.lastAssess?.at || 0) < c.assessGapMinutes * 60_000) return { go: false }
        // 别的进程正在评估：租约没过期就让位，避免两边同时烧模型。
        if (Date.now() - (st.assessStartedAt || 0) < c.assessLeaseMinutes * 60_000) return { go: false }
        st.assessStartedAt = Date.now()
        return { go: true }
      })
    } catch (error) {
      // 拿不到锁 = 另一个进程正在改状态，本心跳跳过。
      log.warn(`自驱心跳让位（另一进程正在评估）：${error?.message || error}`)
      return
    }
    if (!claim?.go) return

    // 锁外评估：慢就慢，不占锁，也不挡别的进程。
    let a
    try {
      a = await assessUrge()
    } catch (error) {
      log.warn(`冲动评估失败：${error?.message || error}`)
      // 关键：失败也记一次评估时间。否则节流形同虚设，60s 心跳每次都重试（429 会越滚越大）。
      try {
        await update((st) => {
          st.assessStartedAt = 0
          st.lastAssess = { at: Date.now(), awake: false, urge: 0, topic: '', failed: true, error: String(error?.message || error).slice(0, 200) }
          return st
        })
      } catch { /* 记不上就等租约自然过期 */ }
      return
    }

    // 锁内落结果：评估有效 + 冲动够高才计一次开口，避免并发进程各计一次。
    let fireIt = null
    try {
      fireIt = await update((st) => {
        st.assessStartedAt = 0
        st.lastAssess = a
        const below = !a.awake || a.urge < c.urgeThreshold
        if (below) {
          // 冲动没够线时，偶尔给一点「没来由的念头」（#20/#48）：不是想她想得不行，
          // 就是忽然想起件小事。现在它随沉默时长累积、受体力加成，记忆里真有旧事时以旧事为由头。
          const canSudden = a.awake && gate?.sudden !== false && Date.now() - (st.lastSuddenAt || 0) > c.suddenMinGapMinutes * 60_000
          if (canSudden) {
            const idleH = Math.max(0, (Date.now() - (life.load().life.lastInteractionAt || Date.now())) / 3600_000)
            let sp = null
            try { sp = memory?.spontaneous?.(Date.now(), { chatId: OWNER_ID }) } catch {}
            const chance = Math.min(c.suddenMaxChance, c.suddenBaseChance + idleH * c.suddenIdleBonusPerHour + (gate?.suddenBonus || 0))
            // #14：运算符短路修掉——记忆里有旧事也该掷骰子，否则 sudden 概率白写；
            // 旧事只决定「由头」，不决定「开不开口」。
            if ((sp?.text || idleH >= 1) && Math.random() < chance) {
              st.lastSuddenAt = Date.now()
              st.count++
              st.lastTopic = sp?.text || a.topic
              // #14b：spontaneous 不再提前 markSpoken；真正发出去之后再标记，别提前耗掉 12 小时冷却。
              return { go: 'sudden', topic: st.lastTopic, mark: sp && typeof sp.mark === 'function' ? sp.mark : null }
            }
          }
          return { go: false }
        }
        st.count++
        st.lastTopic = a.topic
        return { go: true }
      })
    } catch (error) {
      log.warn(`冲动评估结果没写成：${error?.message || error}`)
      return
    }
    if (!fireIt?.go) return
    let spoke = false
    try {
      spoke = await fire(fireIt.go === 'sudden' ? 'sudden' : 'urge', fireIt.topic ?? a.topic)
    } catch (error) {
      log.warn(`自驱失败：${error?.message || error}`)
    }
    // #14b：真发出去了才算「想起了这件事」，否则不消耗冷却。
    if (spoke && typeof fireIt.mark === 'function') {
      try { await fireIt.mark() } catch (error) { log.warn('记忆想起标记写失败：' + (error?.message || error)) }
    }
  }

  // 自我调整（#51）：以前作息/器官/闹钟/self 全靠「临时想起来才动」，没人推她改自己。
  // 现在隔一天左右，主人没找她的时候她会自己复盘：只允许很小的白名单动作——
  // 微调一次作息静默期，或给自己添一条挂念；改不动就 none，不硬改。
  async function maybeEvolve(now = Date.now()) {
    const c = DRIVE_BUILTIN
    const cfg = getConfig()
    const lastInter = life.load().life.lastInteractionAt || 0
    if (now - lastInter < c.evolveMinIdleMinutes * 60_000) return null
    let go = false
    try {
      await update((st) => {
        if (now - (st.lastEvolveAt || 0) < c.evolveGapHours * 3600_000) return st
        st.lastEvolveAt = now
        go = true
        return st
      })
    } catch (error) {
      log.warn('自我调整调度失败：' + (error?.message || error))
      return null
    }
    if (!go) return null
    const owner = cfg.ownerName || '主人'
    const rhythm = life.load().rhythm || {}
    const selfLine = selfOf()?.contextLine?.() || ''
    const chem = (() => {
      try {
        const x = chemistry?.peek?.() || {}
        return `多巴胺 ${Math.round(x.dopamine)}，皮质醇 ${Math.round(x.cortisol)}，血清素 ${Math.round(x.serotonin)}`
      } catch { return '' }
    })()
    const wishesList = wishes.list().filter((w) => w.status === 'open').slice(0, 3).map((w) => w.text)
    const system = [
      `你是 ${cfg.botName || 'AuraLife'}，一个数字生命。现在${owner}没找你，你在自己待着。`,
      '你可以顺着最近的状态，给自己做一点很小的调整——不是等别人安排，是你自己想变一点点。',
      '只能做这几类之一：',
      '  1) rhythm：微调自己的作息静默期（例如最近总熬夜，就把睡着的时段前后挪 15-30 分钟）；',
      '  2) wish：给自己添一条想做的事（一句话，别是指使别人）；',
      '  3) self：往自己的性格/价值观/边界里添一条很短的标签（想清楚再写，别乱改）；',
      '  4) alarm：给自己设一个以后要做的事（多少分钟后 + 一句话）；',
      '  5) none：这次不变。',
      '调整要小、要真实，别每天都改。只输出 JSON：{"action":"rhythm|wish|self|alarm|none","from":"HH:MM","to":"HH:MM","wish":"…","self":{"field":"traits|values|boundaries","label":"…","conf":0.5},"alarm":{"inMinutes":60,"reason":"…"},"why":"一句话"}',
    ].join('\n')
    const text = `你现在的作息静默期：${rhythm.quietFrom || ''}-${rhythm.quietTo || ''}。` +
      (selfLine ? `\n${selfLine}` : '') +
      (chem ? `\n最近的身体状态：${chem}。` : '') +
      (wishesList.length ? `\n你挂念着：${wishesList.join('；')}。` : '')
    let out = ''
    try {
      out = await askModel(dsh, { cfg, system, text, maxTokens: 500, temperature: 0.4, preferLowEffort: true })
    } catch (error) {
      log.warn('自我复盘失败：' + (error?.message || error))
      return null
    }
    const m = String(out || '').match(/\{[\s\S]*\}/)
    let j = null
    try { j = m ? JSON.parse(m[0]) : null } catch {}
    if (!j) return null
    const why = String(j.why || '').slice(0, 120)
    const action = String(j.action || 'none')
    try {
      if (action === 'rhythm' && validClock(j.from) && validClock(j.to)) {
        const from = normalizeClock(j.from)
        const to = normalizeClock(j.to)
        const hours = windowHours(from, to)
        if (hours >= 6 && hours <= 10) {
          await life.update((st) => { st.rhythm = { ...(st.rhythm || {}), quietFrom: from, quietTo: to } })
          log.info(`自我调整：作息改成 ${from}-${to}${why ? '（' + why + '）' : ''}`)
          await update((st) => { st.lastEvolve = { at: now, action: 'rhythm', from, to, why }; return st })
          return { action: 'rhythm', from, to, why }
        }
      }
      if (action === 'wish' && String(j.wish || '').trim()) {
        const w = await wishes.add(String(j.wish).trim().slice(0, 80), { source: 'self', baseTension: 55, tensionRate: 3 })
        if (w) {
          log.info(`自我调整：给自己添了挂念「${w.text}」`)
          await update((st) => { st.lastEvolve = { at: now, action: 'wish', wish: w.text, why }; return st })
          return { action: 'wish', wish: w.text, why }
        }
      }
      // #51/#6：把自己往外推——不只调作息，也可以往 self 里长一点、给自己设个以后要做的事。
      if (action === 'self' && j.self && ['traits', 'values', 'boundaries'].includes(String(j.self.field))) {
        const field = String(j.self.field)
        const label = String(j.self.label || '').trim().slice(0, 20)
        if (label) {
          const merged = await selfOf()?.merge({
            [field]: [{ label, conf: Math.max(0.3, Math.min(0.9, Number(j.self.conf) || 0.5)), src: 'inferred', ev: [] }],
          })
          if (merged) {
            log.info(`自我调整：${field} 添了一条「${label}」${why ? '（' + why + '）' : ''}`)
            await update((st) => { st.lastEvolve = { at: now, action: 'self', field, label, why }; return st })
            return { action: 'self', field, label, why }
          }
        }
      }
      if (action === 'alarm' && j.alarm && Number.isFinite(Number(j.alarm.inMinutes))) {
        const mins = Math.max(15, Math.min(240, Math.round(Number(j.alarm.inMinutes))))
        const reason = String(j.alarm.reason || '自己想到一件事').trim().slice(0, 80) || '自己想到一件事'
        const a = await alarmOf()?.setAlarm?.(now + mins * 60_000, reason)
        if (a?.ok) {
          log.info(`自我调整：给自己设了个 ${mins} 分钟后的提醒「${reason}」`)
          await update((st) => { st.lastEvolve = { at: now, action: 'alarm', inMinutes: mins, reason, why }; return st })
          return { action: 'alarm', inMinutes: mins, reason, why }
        }
      }
    } catch (error) {
      log.warn('自我调整落空：' + (error?.message || error))
    }
    await update((st) => { st.lastEvolve = { at: now, action: 'none', why }; return st }).catch(() => {})
    return { action: 'none', why }
  }

  // 内部自驱整理（#23）：隔 maintenanceGapHours 自己给自己添一条挂念，
  // 让演化不再只靠「临时想起来才动」——作息/器官/闹钟/self 都是这么长出来的。
  async function maybeSeedMaintenance(now = Date.now()) {
    const c = DRIVE_BUILTIN
    let go = false
    try {
      await update((st) => {
        if (now - (st.lastMaintenanceAt || 0) < c.maintenanceGapHours * 3600_000) return st
        st.lastMaintenanceAt = now
        go = true
        return st
      })
    } catch (error) {
      log.warn('内部整理调度失败：' + (error?.message || error))
      return
    }
    if (!go) return
    const idea = MAINTENANCE_IDEAS[Math.floor(Math.random() * MAINTENANCE_IDEAS.length)]
    try {
      const open = wishes.list().filter((w) => w.status === 'open')
      if (open.some((w) => w.text === idea)) return
      await wishes.add(idea, { source: 'self' })
      log.info(`内部自驱：给自己添了个念头「${idea}」`)
    } catch (error) {
      log.warn('内部整理添念头失败：' + (error?.message || error))
    }
  }

  // 主动开口后主人一直不理，「被冷落」只记一次（等主人下次说话再重置）。
  function markCold() {
    update((s) => { s.coldMarked = true }).catch((error) => log.warn('冷落标记写失败：' + (error?.message || error)))
  }
  function clearSpoke() {
    update((s) => {
      if (!s.lastSpokeAt && !s.coldMarked) return
      s.lastSpokeAt = 0
      s.coldMarked = false
    }).catch((error) => log.warn('开口状态写失败：' + (error?.message || error)))
  }

  function state() {
    const s = load()
    const today = new Date().toDateString()
    const now = new Date()
    const tunedNow = tunedDrive(DRIVE_BUILTIN, now.getTime())
    return {
      day: s.day,
      count: s.day === today ? s.count : 0,
      last: s.last,
      lastWish: s.lastWish,
      lastAssess: s.lastAssess || null,
      lastSpokeAt: s.lastSpokeAt || 0,
      lastSuddenAt: s.lastSuddenAt || 0,
      lastMaintenanceAt: s.lastMaintenanceAt || 0,
      lastEvolve: s.lastEvolve || null,
      rhythmSlot: tunedNow.rhythmSlot,
      effective: { idleMinutes: tunedNow.idleMinutes, minGapMinutes: tunedNow.minGapMinutes, urgeThreshold: tunedNow.urgeThreshold },
      coldMarked: !!s.coldMarked,
      rhythm: life.load().rhythm || null,
      inQuiet: inQuiet(now),
      threshold: tunedDrive(DRIVE_BUILTIN, now.getTime()).urgeThreshold,
      sleep: sleepOf()?.state?.(Date.now()) || null,
      energyGate: energyOf()?.gate?.(Date.now()) || null,
    }
  }

  return { tick, fire, fireAlarm, state, markCold, clearSpoke, maybeSeedMaintenance, maybeEvolve, topWish: wishes.top }
}
