// memory/encode.js — 记忆 v2 的写入（编码）层。
//
// 两条管线（DESIGN-life.md §5.1）：
//   1. 事件分段：不按天、不按固定条数切，按「时间跳变 / 轮数上限」切出 episode。
//   2. 事实抽取：LLM 从一段原文里挑事实 → 版本链（supersedes）写入 + 来源监控（src）。
//
// 判重 0.85 + 实体/否定词保护在 similar.js；命中只 bumpHit、不动 t0。
import { askModel } from '../core/llm.js'
import { OWNER_ID } from '../chat/access.js'
import { isDup, isHardFact } from './similar.js'

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
      related.length
        ? '已经记得的事（#编号 是旧记忆的 id）：\n' + related.map((f) => `#${f.id} [${f.src}] ${f.aboutName ? '[' + f.aboutName + '] ' : ''}${f.text}`).join('\n') + '\n\n'
        : '',
      '只输出一个 JSON 对象：{"summary":"这段发生了什么，一两句，无人称省略主语也行","facts":[{"op":"add","text":"…","about":"小明","about_id":"guest-1","src":"told","conf":0.6}]}。',
      'about 写这件事是关于谁的名字，about_id 写那个人的用户标识（owner/guest-N），不知道就不写。没有值得记的 facts 就输出空数组。',
    ].join('\n')

    const out = await askModel(dsh, {
      cfg,
      system,
      text: (summary ? '上一版摘要：' + summary + '\n\n' : '') + transcript,
      maxTokens: 1500,
      temperature: 0.2,
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
      const conf = Math.max(0, Math.min(1, Number(x.conf) ?? 0.5))

      const op = String(x.op || 'add')
      const targetId = String(x.id || '').replace(/^#/, '')
      const target = targetId ? store.findFact(targetId) : null

      if ((op === 'update' || op === 'outdated') && target) {
        const nf = store.supersede(target.id, { text, subj: subj || target.subj, aboutName: x.about || target.aboutName || '', src, conf, chatId, archived: isHardFact({ text, src, conf }) })
        superseded++
        supersededIds.push(nf.id)
        log.info(`记忆更新：「${target.text.slice(0, 40)}」→「${text.slice(0, 40)}」(${op})`)
        continue
      }

      // add：先判重（0.85 + 实体/否定词保护）
      const dup = nowFacts.find((f) => isDup({ text, subj }, f))
      if (dup) {
        store.bumpHit(dup.id)
        skipped++
        continue
      }
      const fact = store.addFact({ text, subj, aboutName: String(x.about || ''), src, conf, chatId, archived: isHardFact({ text, src, conf }), ev: [] })
      added++
      addedIds.push(fact.id)
      log.info(`新记忆 [${src}]：${text.slice(0, 60)}`)
    }
    return { added, addedIds, superseded, supersededIds, summary: newSummary, skipped }
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
      for (const fid of [...(r.addedIds || []), ...(r.supersededIds || [])]) store.linkEvidence(fid, ep.id)
      episodes.push(ep)
    }
    return { episodes, facts: { added, superseded, addedIds, supersededIds } }
  }

  return { extractFacts, encodeSegment }
}
