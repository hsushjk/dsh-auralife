// memory/encode.js — 记忆 v2 的写入（编码）层。
//
// 两条管线（DESIGN-life.md §5.1）：
//   1. 事件分段：不按天、不按固定条数切，按「时间跳变 / 轮数上限」切出 episode。
//   2. 事实抽取：LLM 从一段原文里挑事实 → 版本链（supersedes）写入 + 来源监控（src）。
//
// 判重 0.85 + 实体/否定词保护在 similar.js；命中只 bumpHit、不动 t0。
import { askModel } from '../core/llm.js'
import { numOr } from '../core/store.js'
import { OWNER_ID } from '../chat/access.js'
import { isDup, isHardFact, normalizeText } from './similar.js'

// 时间跳变阈值（毫秒）：超过这个间隔视为两个事件
export const GAP_MS = 30 * 60 * 1000
// 一个事件最多多少「轮」（一轮 = 一条用户消息）
export const MAX_TURNS = 10

// 纯函数：把消息流切成事件片段。
// msgs: [{ id, t, who, uid, text }]（t 升序）
export function segment(msgs, { gapMs = GAP_MS, maxTurns = MAX_TURNS } = {}) {
  const out = []
  let cur = []
  let turns = 0
  let prevT = null
  for (const m of msgs || []) {
    const gap = prevT != null && m.t - prevT >= gapMs
    const over = turns >= maxTurns
    if (cur.length && (gap || over)) {
      out.push(cur)
      cur = []
      turns = 0
    }
    cur.push(m)
    if (m.who !== 'bot') turns++
    prevT = m.t
  }
  if (cur.length) out.push(cur)
  return out
}

// 一段消息里的人：uid -> 出现次数（owner 排最前）
export function peopleOf(msgs) {
  const count = new Map()
  for (const m of msgs) {
    if (m.who === 'bot') continue
    const uid = m.uid || m.who || '?'
    count.set(uid, (count.get(uid) || 0) + 1)
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1]).map(([uid]) => uid)
}

function lineOf(m, names = {}) {
  if (m.who === 'bot') return '我：' + (m.text || '')
  const uid = m.uid || m.who || ''
  const label = names[uid] ? `${names[uid]}(${uid})` : (uid ? `${m.who}(${uid})` : m.who)
  return `${label}：${m.text || ''}`
}

function parseArr(out) {
  const m = String(out || '').match(/\[[\s\S]*\]/)
  if (!m) return []
  try { return JSON.parse(m[0]) } catch { return [] }
}

export function createEncode({ dsh, getConfig, store, log = console }) {
  // 从一段已格式化的聊天文本里抽事实，写版本链。
  // 返回 { added, superseded, summary, skipped }
  async function extractFacts(chatId, transcript, { people = [], summary = '' } = {}) {
    const cfg = getConfig()
    const current = store.currentFacts()
    // 相关候选：同 people 的事实 + 粗字面匹配（这里只按 subj 过滤，语义召回在 recall.js）
    const subjSet = new Set(people.map(String))
    const related = current.filter((f) => subjSet.has(f.subj)).slice(-40)

    const system = [
      '你帮一个叫「AuraLife」的聊天角色整理长期记忆。下面是一段聊天/记录，说话人后面括号里是用户标识（owner 是主人，guest-N 是客人）。',
      '挑出以后值得记住的事实：别人的名字/称呼、喜好、讨厌、身份、近况和重要经历、约定、关系变化。不要记寒暄、日常琐事、一次性问答；不要记 AuraLife 自己的人设和喜好，只记关于别人、以及你们之间的事。每条一句话，主语写清楚是谁。',
      `其中 ${OWNER_ID} 是它的${cfg.ownerName || '主人'}。`,
      '',
      '每条事实必须带 src（来源）：',
      '  "told"     —— 对方明确说出口的（喜好/身份/近况/约定）；',
      '  "inferred" —— 你从上下文推测出来的，不是对方原话；',
      '  "self_did" —— AuraLife 自己做过或答应过的事（承诺）；',
      '  "imagined" —— 你猜的、没根据的。拿不准就写 "inferred"，不要写 imagined。',
      '',
      '每条还要带 op：',
      '  "add"      —— 全新事实；',
      '  "update"   —— 对某条旧记忆的补充/更准确说法，"id" 填旧编号、"text" 写合并后的完整说法；',
      '  "outdated" —— 旧记忆过时/被推翻（以前喜欢现在不喜欢、换工作、分手），"id" 填旧编号、"text" 写现在的新事实。',
      '拿不准是不是矛盾就当 add；和旧记忆重复、没新信息的不要输出。',
      '',
      '每条还要带 kind（事实类型，尽量由你判断，不靠关键词猜；拿不准写 knowledge）：',
      '  "state"      —— 现在才知道、以后会被现实推翻的状态（在忙/在不在、进度、身体状况、最近在做什么）；',
      '  "preference" —— 稳定的喜好/讨厌/习惯/底线（爱吃什么、受不了什么、忌口）；',
      '  "memory"     —— 你们之间发生过的事、她做过或答应过的事；',
      '  "knowledge"  —— 一般已知信息（名字、身份、关系）。',
      '',
      related.length
        ? '已经记得的事（#编号 是旧记忆的 id）：\n' + related.map((f) => `#${f.id} [${f.src}] ${f.aboutName ? '[' + f.aboutName + '] ' : ''}${f.text}`).join('\n') + '\n\n'
        : '',
      '只输出一个 JSON 对象：{"summary":"这段发生了什么，一两句，无人称省略主语也行","facts":[{"op":"add","text":"…","about":"小明","about_id":"guest-1","src":"told","conf":0.6,"kind":"preference"}]}。',
      'about 写这件事是关于谁的名字，about_id 写那个人的用户标识（owner/guest-N），不知道就不写。没有值得记的 facts 就输出空数组。',
    ].join('\n')

    const out = await askModel(dsh, {
      cfg,
      system,
      text: (summary ? '上一版摘要：' + summary + '\n\n' : '') + transcript,
      maxTokens: 1500,
      temperature: 0.2,
      preferLowEffort: true, // 只输出内部 JSON：别让思考 token 吃光正文预算
    })

    const obj = String(out || '').match(/\{[\s\S]*\}/)
    let parsed = null
    try { parsed = obj ? JSON.parse(obj[0]) : null } catch {}
    if (!parsed || !Array.isArray(parsed.facts)) {
      log.warn('事实抽取：模型没输出可解析的 JSON，跳过')
      return { added: 0, superseded: 0, summary: '', skipped: 0 }
    }

    const newSummary = String(parsed.summary || '').trim().slice(0, 200)
    const nowFacts = store.currentFacts()
    let added = 0
    let superseded = 0
    let skipped = 0
    const addedIds = []
    const supersededIds = []

    for (const x of parsed.facts.slice(0, 12)) {
      if (!x || !x.text) continue
      const text = String(x.text).trim().slice(0, 200)
      if (!text) continue
      // 不记她自己的人设
      if (/^(我|AuraLife)/.test(String(x.about || '')) || String(x.about || '') === 'AuraLife') continue

      const id = String(x.about_id ?? '').trim()
      const subj = /^[a-z][\w-]*$/.test(id) ? id : (chatId && chatId !== 'azone' ? chatId : '')
      const src = ['told', 'inferred', 'self_did', 'imagined'].includes(String(x.src)) ? String(x.src) : 'inferred'
      const conf = Math.max(0, Math.min(1, numOr(x.conf, 0.5)))
      // 事实类型交给抽取模型判断（#2）：正则只能兜底，猜错了没有纠正入口。
      const kind = ['state', 'preference', 'knowledge', 'memory'].includes(String(x.kind || '')) ? String(x.kind) : ''

      const op = String(x.op || 'add')
      // 判重/改写的范围跟 fact 的 chatId 对齐（#18）：客人会话里说的话不能并进/覆盖主人的事实，
      // chatId 为空的事实算「全局共享」，两边都能碰。
      const scope = String(chatId || '')
      const inScope = (f) => {
        if (!f) return false
        const fc = String(f.chatId || '')
        return fc === scope || fc === '' || scope === ''
      }
      const targetId = String(x.id || '').replace(/^#/, '')
      const target = targetId ? store.findFact(targetId) : null

      if ((op === 'update' || op === 'outdated') && target && inScope(target)) {
        const nf = await store.supersede(target.id, { text, subj: subj || target.subj, aboutName: x.about || target.aboutName || '', src, conf, kind: kind || target.kind, chatId: target.chatId || scope, archived: isHardFact({ text, src, conf }) })
        superseded++
        supersededIds.push(nf.id)
        log.info(`记忆更新：「${target.text.slice(0, 40)}」→「${text.slice(0, 40)}」(${op})`)
        continue
      }

      // add：先判重（0.85 + 实体/否定词保护），范围限定在当前 chatId 可见的事实里（#18）
      const dup = nowFacts.find((f) => inScope(f) && isDup({ text, subj }, f))
      if (dup) {
        // 同一件事但新说法更具体时不能只 bumpHit 把细节丢光（复查 #9）：
        // 新句明显更长 → 走 supersede 合并进版本链；否则照旧只记命中。
        const oldText = String(dup.text || '')
        if (text.length > oldText.length + 4 && normalizeText(text) !== normalizeText(oldText)) {
          const nf = await store.supersede(dup.id, { text, subj: subj || dup.subj, aboutName: String(x.about || dup.aboutName || ''), src, conf, kind: kind || dup.kind, chatId: dup.chatId || scope, tags: dup.tags, archived: isHardFact({ text, src, conf }) })
          superseded++
          supersededIds.push(nf.id)
          log.info(`记忆合并：「${oldText.slice(0, 40)}」→「${text.slice(0, 40)}」`)
          continue
        }
        // 模型给了明确类型、旧记忆是兜底猜的 → 顺手纠正（#2：猜错了没人纠正）。
        if (kind && kind !== 'knowledge' && (dup.kind || 'knowledge') === 'knowledge' && dup.kind !== kind) {
          try { await store.setFactKind(dup.id, kind) } catch (error) {}
        }
        await store.bumpHit(dup.id)
        skipped++
        continue
      }
      const fact = store.addFact({ text, subj, aboutName: String(x.about || ''), src, conf, kind, chatId, archived: isHardFact({ text, src, conf }), ev: [] })
      added++
      addedIds.push(fact.id)
      log.info(`新记忆 [${src}]：${text.slice(0, 60)}`)
    }
    return { added, addedIds, superseded, supersededIds, summary: newSummary, skipped }
  }

  // #2（结构性）：历史里 kindSrc='heuristic' 的事实是正则猜出来的类型，交给模型批量纠正。
  // 只改类型、不动内容；拿不准的条目跳过，下次再试。每类每天最多一次（由 v2 节流调用）。
  async function fixKinds({ limit = 20 } = {}) {
    let list = []
    try {
      const cap = Math.max(1, Math.min(50, Number(limit) || 20))
      list = store.currentFacts().filter((f) => f && f.kindSrc === 'heuristic').slice(0, cap)
    } catch { return 0 }
    if (!list.length) return 0
    const rows = list.map((f, i) => `${i + 1}. ${f.text}`).join('\n')
    const system = [
      '你在帮一个长期记忆库给事实分类。每条记忆归到四类之一：',
      '  state —— 会过期的状态（在不在、版本多少、还没做、修好没）；',
      '  preference —— 偏好/口味/习惯（喜欢什么、讨厌什么、爱吃什么）；',
      '  memory —— 她做过/答应过/经历过的事（承诺、经历）；',
      '  knowledge —— 关于人和世界的稳定事实（名字、关系、职业、住址、重要日期）。',
      '只输出 JSON：{"kinds":[{"n":1,"kind":"preference"},{"n":2,"kind":"knowledge"}]}；拿不准的条目不输出。',
    ].join('\n')
    const out = await askModel(dsh, { cfg: getConfig(), system, text: rows, maxTokens: 800, temperature: 0.1, preferLowEffort: true })
    const m = String(out || '').match(/\{[\s\S]*\}/)
    let parsed = null
    try { parsed = m ? JSON.parse(m[0]) : null } catch {}
    if (!parsed || !Array.isArray(parsed.kinds)) return 0
    let changed = 0
    for (const item of parsed.kinds) {
      const f = list[Number(item && item.n) - 1]
      const kind = String((item && item.kind) || '')
      if (!f || !['state', 'preference', 'knowledge', 'memory'].includes(kind)) continue
      try { if (await store.setFactKind(f.id, kind)) changed++ } catch (error) {}
    }
    return changed
  }

  // 把一个 chatId 的一段原文消息编码成 episode + facts。
  // msgs: [{ id, t, who, uid, text }]（升序）
  async function encodeSegment(chatId, msgs, { names = {} } = {}) {
    const talk = (msgs || []).filter((m) => m.text && !String(m.text).startsWith('【系统'))
    if (!talk.length) return { episodes: [], facts: { added: 0, superseded: 0 } }

    const segs = segment(talk)
    const episodes = []
    let added = 0
    let superseded = 0
    const addedIds = []
    const supersededIds = []
    // 情绪锚点：心情已删，moodIn/moodOut 暂记 null（schema 保留，等情绪数据源再定）。
    for (const s of segs) {
      const people = peopleOf(s)
      const transcript = s.map((m) => lineOf(m, names)).join('\n')
      const r = await extractFacts(chatId, transcript, { people })
      added += r.added
      superseded += r.superseded
      if (Array.isArray(r.addedIds)) addedIds.push(...r.addedIds)
      if (Array.isArray(r.supersededIds)) supersededIds.push(...r.supersededIds)
      const ep = store.addEpisode({
        t0: s[0].t,
        t1: s[s.length - 1].t,
        chatId,
        people,
        moodIn: null,
        moodOut: null,
        raw: { fromId: s[0].id, toId: s[s.length - 1].id }, // 只存区间指针，原文不复制
        summary: r.summary,
        tags: [],
        salience: 0.5,
      })
      // 证据链：这段事件里抽到的事实挂到本 episode（情绪锚点召回靠 ev → episode.moodOut）
      for (const fid of [...(r.addedIds || []), ...(r.supersededIds || [])]) await store.linkEvidence(fid, ep.id)
      episodes.push(ep)
    }
    return { episodes, facts: { added, superseded, addedIds, supersededIds } }
  }

  return { extractFacts, encodeSegment, fixKinds }
}
