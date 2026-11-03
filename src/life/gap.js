// 缺口自动检测 —— 移植自 digital-life-core index.ts:1482-1785 的缺口收割器。
//
// 纪律（digital-life-core v0.9.21 踩出来的，逐条照抄）：
//   1. 只收「明确表示未知 / 查不到」的句子（UNKNOWN_RE / INQUIRY_RE），
//      「我打算去做」是待办，归自驱线，不进缺口池——两条线混一池会废。
//   2. 只收「不是讲道理」的句子（EXPOSITORY_RE 过滤感慨/解释）。
//   3. 自指（谈机制本身）直接忽略（SELF_REFERENCE_RE）。
//   4. 先洗排版，只取最长一句，截 maxLen。
//
// 这是纯函数，不碰任何状态；找到的句子由调用方决定怎么种执念。

const SELF_REFERENCE_RE = new RegExp(
  [
    '执念', '心结', '内省', '唤醒', '潜意识', '自驱', '缺口', '闭环', '收割', '张力',
    '状态文件', 'state\\.json', '系统提醒', 'auralife', '记忆机制', '记忆库',
  ].join('|'),
  'i',
)

// 明确的行动意图（第一人称）。这里不再作为「够格当执念」的入口——v0.9.21 已删，
// 只保留给 pickCandidate 判断「这段文本是不是在说事」。
const INTENT_RE = new RegExp(
  [
    '我(要|想|会|去|来|打算|准备|计划|试着|尝试|试试|查|搜|找|看看|得|必须|应该|需)',
    '让我', '提醒我', '帮我(查|找|看|试)', '回头我', '待会我', '等会我', '下次我', '改天我',
  ].join('|'),
  'i',
)

// 认知性探究：她打算去「弄明白」一件事。这是「真执念」的定义形状——她就靠这个发芽。
// 与待办的分界在动词是不是认知性的（想知道/查/弄明白 = 认知；做/同步/整理 = 执行）。
const INQUIRY_RE = new RegExp(
  [
    '我[^，。；！？]{0,3}(想知道|想查|想弄明白|想搞清楚|想搞清|想弄懂|想确认|想了解|想核实|查一下|查查|查查看)',
  ].join('|'),
  'i',
)

// 她明确表示「这件事我不知道/查不到」：必须是「我 + 否定式未知动词」，锚定第一人称，
// 避免「你不知道…」这种讲道理被误收。
const UNKNOWN_RE = new RegExp(
  [
    '我[^，。；！？]{0,4}(不知道|不晓得|不清楚|不明白|不了解|不确定|没找到|没有找到|找不到|查不到|搜不到|没查到|查不出来|搞不清|弄不清|说不上来|想不出来|想不起来|想不起|记不清|记不住|忘了|忘记|忘记了|没记住|无法知道|无法确认|无法确定|无从得知)',
  ].join('|'),
  'i',
)

// 纯理论解释 / 纯感慨的标记：哪怕句子同时挂着「不知道」，也是讲道理，不收。
const EXPOSITORY_RE = new RegExp(
  [
    '意味着', '差别在于', '也就是说', '换句话说', '这说明', '之所以', '因此', '总的来说',
    '总之', '区别在于', '某种意义上', '某种程度上', '另一方面', '与此同时', '一直以来',
    '话说回来', '问题在于', '关键在于', '现在的差别', '当时那', '那一行', '这类',
    '我等了', '我一直在', '我一直', '其实是因为', '说到这个', '顺带', '顺便',
  ].join('|'),
  'i',
)

function splitSentences(text) {
  return text
    .split(/[。！？!?\n]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

/** 洗完之后是否还剩下「有意义的内容」：不能只有符号、数字或一两个字。 */
function isMeaningful(text) {
  if (text.length < 4) return false
  const letters = text.replace(/[^\p{L}\p{N}]/gu, '')
  return letters.length >= 3
}

/** 去掉 Markdown / 表格 / 列表排版，只留「人话」。 */
function stripMarkdown(text) {
  return text
    .replace(/^\s*\|?[\s:|-]*-{2,}[\s:|-]*\|?\s*$/gm, ' ')
    .replace(/^[\s>]*#{1,6}\s*/gm, '')
    .replace(/^\s*\|/gm, '')
    .replace(/\|\s*$/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s*[○•>→\-*·]\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function hasUnknownClaim(text) {
  return !!text && UNKNOWN_RE.test(text)
}

function isExpository(text) {
  return !!text && EXPOSITORY_RE.test(text)
}

function isSelfReferential(text) {
  return !!text && SELF_REFERENCE_RE.test(text)
}

/** 从一句（或一行表格）里挑出那个真正说事的片段，排版在这一步被剥掉。 */
function pickCandidate(raw) {
  if (raw.includes('|')) {
    let bestCell = ''
    for (const cell of raw.split('|')) {
      const cleaned = stripMarkdown(cell)
      if (!isMeaningful(cleaned)) continue
      if (hasUnknownClaim(cleaned) || INQUIRY_RE.test(cleaned)) {
        if (cleaned.length > bestCell.length) bestCell = cleaned
      }
    }
    return bestCell || null
  }
  const cleaned = stripMarkdown(raw)
  if (!isMeaningful(cleaned)) return null
  return cleaned
}

/** 闸一：这句话够格当一条执念吗？只收「明确表示未知」且「不是讲道理」。 */
function isGapWorthy(sentence) {
  if (!sentence) return false
  const claimsUnknown = hasUnknownClaim(sentence) || INQUIRY_RE.test(sentence)
  if (!claimsUnknown) return false
  return !isExpository(sentence)
}

/**
 * 从她的一轮回复里找出够格当执念的那句话。
 * 返回 null 表示这一轮没有表达「我想弄明白却弄不明白」。
 */
export function findGapSentence(text, maxLen = 100) {
  if (!text) return null
  let best = ''
  for (const raw of splitSentences(text)) {
    const candidate = pickCandidate(raw)
    if (!candidate) continue
    if (isSelfReferential(candidate)) continue
    if (!isGapWorthy(candidate)) continue
    // 取最长一句：短句往往只是「不知道。」这种无信息量的残句。
    if (candidate.length > best.length) best = candidate
  }
  if (!best) return null
  return best.slice(0, maxLen).replace(/[\s，,、；;:：]+$/, '')
}
