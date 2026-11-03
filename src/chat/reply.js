// ——回复解析：把模型输出拆成聊天消息项（AuraLife 自己的实现，2026-11 重写）——// 模型回复协议：<voice>…</voice> 语音、<sticker:标签> 表情、<poke/> 拍一拍、
// <reply:N> 引用（挂到下一条气泡）、![](url) 图片、||| 分隔多条气泡。
// 输出统一成 { kind: 'text'|'voice'|'sticker'|'image'|'poke', value, replyTo? }[]。

const SILENCE = '[沉默]'

// ——Markdown 的粗浅去除：聊天里不该出现格式标记 ——
const MD_PATTERNS = [
  [/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, '$1'],
  [/`([^`\n]+)`/g, '$1'],
  [/\*\*([^*\n]+)\*\*/g, '$1'],
  [/__([^_\n]+)__/g, '$1'],
  [/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1$2'],
  [/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 $2'],
]
const MD_LINES = [
  [/^#{1,6}\s+/gm, ''],
  [/^\s*[-*+]\s+/gm, ''],
  [/^\s*>\s?/gm, ''],
  [/[ \t]+$/gm, ''],
]

export function stripMarkdown(text) {
  let out = String(text || '')
  for (const [re, rep] of MD_PATTERNS) out = out.replace(re, rep)
  for (const [re, rep] of MD_LINES) out = out.replace(re, rep)
  return out.replace(/\n{3,}/g, '\n\n').trim()
}

// ——沉默判定：几种写法的「不接话」——
const SILENCE_FORMS = new Set([SILENCE, '［沉默］', '(沉默)', '（沉默）'])

export function isSilence(text) {
  const t = String(text || '').trim()
  return t === '' || SILENCE_FORMS.has(t)
}

// ——气泡上限：文字气泡最多 5 条，多的并进最后一条 ——
const MAX_BUBBLES = 5

function foldTextItems(items) {
  const textItems = items.filter((item) => item.kind === 'text')
  if (textItems.length <= MAX_BUBBLES) return items
  const firstKept = textItems.slice(0, MAX_BUBBLES - 1)
  const keep = new Set(firstKept)
  const mergedValue = textItems.slice(MAX_BUBBLES - 1).map((item) => item.value).join('\n')
  const merged = { kind: 'text', value: mergedValue }
  const result = []
  let mergedPlaced = false
  for (const item of items) {
    if (item.kind !== 'text' || keep.has(item)) result.push(item)
    else if (!mergedPlaced) {
      result.push(merged)
      mergedPlaced = true
    }
  }
  return result
}

// ——回复内嵌标记扫描：一次正则找出下一个标记，按标记类型产出消息项 ——
const MARKER_RE = /<poke\s*\/?>|<reply:\s*(\d+)\s*>|<voice>([\s\S]*?)<\/voice>|<sticker:([^>]+?)>(?:\s*<\/sticker>)?|!\[[^\]]*\]\(\s*([^)\s]+)\s*\)/g

// 纯文本段落（可能是好几行），拆成可独立发送的消息项，同时过滤「模型自我规划」碎语
const PLANNER_PREFIXES = /^(回复|答|接着回|然后(再)?加|不过要注意|这里第)/
const PLANNER_SOUNDS = /听不清具体内容|自然地接话即可|没转成文字，只听到声音/

function lineWorthKeeping(line) {
  const t = String(line || '').trim()
  if (!t || isSilence(t)) return false
  if (/[：:]$/.test(t) && t.length <= 80) return false // 「回复：」「我觉得可以用语音：」
  if (PLANNER_PREFIXES.test(t) && t.length <= 60) return false
  if (/^[\[【（(][^\]】）)]{0,80}[\]】）)]$/.test(t)) return false // 「（先想一下）」
  if (PLANNER_SOUNDS.test(t)) return false
  return true
}

function textToItems(value) {
  const cleaned = stripMarkdown(String(value || '').replace(/<\/?reply[^>]*>/g, ''))
  if (!cleaned || isSilence(cleaned)) return []
  const lines = splitLines(cleaned)
  return lines.filter(lineWorthKeeping).map((line) => ({ kind: 'text', value: line }))
}

export function parseReply(text) {
  const raw = String(text || '').trim()
  if (isSilence(raw)) return { silent: true, items: [] }

  const items = []
  let pendingReplyId = ''
  const attachPending = (insertedAt) => {
    if (pendingReplyId && items.length > insertedAt) {
      items[insertedAt].replyTo = pendingReplyId
      pendingReplyId = ''
    }
  }

  const handleBubble = (bubble) => {
    const segment = bubble.trim()
    if (!segment) return
    let consumed = 0
    let match
    while ((match = MARKER_RE.exec(segment)) !== null) {
      const before = segment.slice(consumed, match.index)
      const at = items.length
      items.push(...textToItems(before))
      attachPending(at)
      const mid = items.length
      const marker = match[0]
      if (marker.startsWith('<poke')) {
        if (!items.some((item) => item.kind === 'poke')) items.push({ kind: 'poke', value: '' })
      } else if (match[1] !== undefined) {
        pendingReplyId = match[1]
      } else if (match[2] !== undefined) {
        const spoken = stripMarkdown(match[2])
        if (spoken) items.push({ kind: 'voice', value: spoken })
      } else if (match[3] !== undefined) {
        const tag = match[3].trim()
        if (tag) items.push({ kind: 'sticker', value: tag })
      } else if (match[4] !== undefined) {
        items.push({ kind: 'image', value: match[4] })
      }
      attachPending(mid)
      consumed = MARKER_RE.lastIndex
    }
    const tail = items.length
    items.push(...textToItems(segment.slice(consumed)))
    attachPending(tail)
  }

  for (const bubble of raw.split('|||')) handleBubble(bubble)

  // 只有第一条 <reply:N> 生效，多出来的删掉
  let used = false
  for (const item of items) {
    if (!item.replyTo) continue
    if (used) delete item.replyTo
    used = true
  }

  if (!items.length) return { silent: true, items: [] }
  return { silent: false, items: foldTextItems(items) }
}

// ——拆分文字：有代码块或太长的不拆；列表味重的不拆 ——
function splitLines(text) {
  const t = String(text || '').trim()
  if (!t) return []
  if (t.includes('```') || t.length > 240) return [t]
  const lines = t.split(/\n+/).map((s) => s.trim()).filter(Boolean)
  if (lines.length <= 1) return lines
  const listLike = lines.filter((line) => /^(\d+[.、)]|[-*•·])/.test(line)).length
  if (listLike >= Math.ceil(lines.length / 2)) return [t]
  return lines
}

// ——打字感延时：按字数估时长，带随机抖动 ——
export function bubbleDelay(next = '', rand = Math.random) {
  if (typeof next === 'function') {
    rand = next
    next = ''
  }
  const length = String(next || '').length
  const estimated = 350 + length * 110 // 大约每秒 9 个字
  return Math.round(Math.min(4500, Math.max(700, estimated)) * (0.8 + rand() * 0.5))
}
