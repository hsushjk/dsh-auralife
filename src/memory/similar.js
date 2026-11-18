// memory/similar.js — 字面相似度与判重（记忆 v2 共用，recall/encode 都依赖）。
//
// 判重阈值从 0.6 提到 0.85，并加「实体保护」+「否定词保护」：
//   - 实体保护：主语（subj）不同就不算重复；
//   - 否定词保护：一条含否定、另一条不含，判为「矛盾」而不是「重复」，
//     矛盾走 supersedes 版本链，不能静默合并。
const STOP = new Set('的了是我你他她它们在有和就不也都很吗吧呢啊呀哦嗯这那个一上下来去说要会能着过'.split(''))

// 近义归一（#1）：同一件事的不同说法先折叠成同一个规范词，判重/召回不再只认字面。
// 只收「说法不同、意思几乎不差」的词；改性格/指代人的词绝不收，避免把两个人拼成一条。
const CANON = [
  [/减肥|节食|瘦身|减重|控糖|控制饮食|管住嘴/g, '减肥'],
  [/用餐|进餐|吃东西|吃饭/g, '吃饭'],
  [/喜爱|偏爱|钟爱|喜欢/g, '喜欢'],
  // 「爱喝咖啡」和「喜欢喝咖啡」是同一偏好；避开「爱人/爱情/爱好」这些名词（#1）。
  [/爱(?![人情感好])/g, '喜欢'],
  [/厌恶|反感|受不了|不喜欢|讨厌/g, '讨厌'],
  [/高兴|快乐|愉快|开心/g, '开心'],
  [/伤心|难过|不开心|低落|沮丧/g, '难过'],
  [/愤怒|恼火|发火|生气/g, '生气'],
  [/恐惧|害怕|怕/g, '害怕'],
  [/上班|打工|工作|干活/g, '工作'],
  [/入睡|去睡|睡了|睡觉/g, '睡觉'],
  [/疲惫|疲劳|乏|累/g, '累'],
  [/忙碌|没空|忙/g, '忙'],
  [/薪水|工资|收入|赚的钱/g, '钱'],
]
// 时间修饰词本身不构成新信息：「最近在减肥」和「在减肥」是同一件事。
const TEMPORAL = /最近|这几天|这段时间|这阵子|现在|目前|一直|这两天/g

// 规范形：近义折叠 + 去时间词。判重、MMR、注入去重都先过它。
export function canonicalize(text) {
  let s = String(text || '').toLowerCase()
  for (const [re, to] of CANON) s = s.replace(re, to)
  s = s.replace(TEMPORAL, '')
  return s
}

export function tokenize(text) {
  const out = []
  // 先做近义归一（#1），再切 token：这样「减肥/节食」这类同义说法会落到同一组词上。
  const s = canonicalize(String(text || '').toLowerCase())
  for (const m of s.matchAll(/[a-z0-9_]{2,}|[一-鿿]+/g)) {
    const w = m[0]
    if (/^[a-z0-9_]+$/.test(w)) { out.push(w); continue }
    if (w.length === 1) { if (!STOP.has(w)) out.push(w); continue }
    for (let i = 0; i < w.length - 1; i++) out.push(w.slice(i, i + 2))
  }
  return out
}

// Jaccard（字符 bigram 集合）
export function similarity(a, b) {
  const A = new Set(tokenize(a))
  const B = new Set(tokenize(b))
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const t of A) if (B.has(t)) inter++
  return inter / (A.size + B.size - inter)
}

// 归一化：去标点/空白/大小写，避免「今天吃了火锅。」和「今天吃了火锅」被判成两条。
export function normalizeText(text) {
  // 先近义归一，再去标点/空白/大小写：换种说法的同一件事也落到同一个字符串上。
  return canonicalize(text).replace(/[\s，。！？；：、,.!?;:'"“”‘’（）()【】\[\]…—\-~·<>《》]+/g, '')
}

// 包含度：短的那条有多少比例被长的那条覆盖（应对「加了点修饰语的同一件事」）。
export function containment(a, b) {
  const A = new Set(tokenize(a))
  const B = new Set(tokenize(b))
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const t of A) if (B.has(t)) inter++
  return inter / Math.min(A.size, B.size)
}

// 判重阈值：短句放宽（字面几乎一样才算），长句用 Jaccard + 包含度双条件。
// 0.85 太严——同一件事换个说法（「主人在减肥」/「主人最近在减肥，不吃晚饭」）就漏判，
// 结果同一件事反复记、重复占提示预算（#13）。
export const DEDUP_THRESHOLD = 0.78
const SHORT_TEXT_LEN = 14

const NEG = /(不|没|别|无|否|拒绝|讨厌|不会|不再|停止|戒|取消|收回|反悔)/

export function isNegation(text) {
  return NEG.test(String(text || ''))
}

// 实体保护：两边都有明确主语且不同 → 不算重复
export function sameEntity(a, b) {
  const sa = String(a?.subj ?? a?.about ?? '')
  const sb = String(b?.subj ?? b?.about ?? '')
  if (sa && sb) return sa === sb
  return true // 有一边缺主语，保守视为同一实体（交给阈值判断）
}

// 判断是否重复：归一化后字面近 + 同实体 + 否定一致。
// 否定不一致绝不合并：那是「矛盾」，要走 supersedes 版本链。
export function isDup(a, b) {
  if (!a?.text || !b?.text) return false
  if (!sameEntity(a, b)) return false
  if (isNegation(a.text) !== isNegation(b.text)) return false
  const na = normalizeText(a.text)
  const nb = normalizeText(b.text)
  if (!na || !nb) return false
  if (na === nb) return true
  const sim = similarity(na, nb)
  const con = containment(na, nb)
  const short = Math.min(na.length, nb.length) <= SHORT_TEXT_LEN
  if (short) return sim >= 0.66 || con >= 0.85
  // 长句在近义归一之后，Jaccard 0.7 / 包含度 0.78 就足够判重（#1：「主人在减肥」vs「主人最近在节食」）。
  return sim >= 0.7 || (con >= 0.78 && sim >= 0.55)
}

// 事实类型推断：状态型（会被现实推翻、必须能复审）/ 偏好型（稳定）/ 一般知识。
// 状态型和偏好型以前混存，导致 bug 事实记下就是硬档 0.9、从出生就没资格被复审（#15）。
// 注意别太宽：「问题/现在/已经/目前/状态」这种词在偏好句里太常见（复查 #8），只留真正暗示「可被现实推翻」的词。
const STATE_RE = /(bug|报错|错误|版本|更新|升级|在不在|开着|关着|装了|卸了|坏了|修好|到期|续费|上线|部署|还没|回滚|发布|生效|修了|搞定)|\bv?\d+\.\d+/i
const PREF_RE = /(喜欢|讨厌|爱吃|不爱|受不了|最爱|偏爱|习惯|忌讳|底线|雷点|害怕|想要)/

export function isStateful(text) {
  return STATE_RE.test(String(text || ''))
}

export function inferKind(text, src = '') {
  const s = String(text || '')
  if (STATE_RE.test(s)) return 'state'
  if (PREF_RE.test(s)) return 'preference'
  if (src === 'self_did' || src === 'imagined') return 'memory'
  return 'knowledge'
}

// 是否是「承诺/约定/雷点」类硬事实（进 archive 硬档）
export function isHardFact(f) {
  if (f.src === 'manual' || f.src === 'told') return true
  if ((f.conf ?? 0) >= 0.6) return true
  return /(答应|约定|承诺|说好|记得|别忘了|以后|保证|不许|别在|雷|底线|讨厌|忌讳)/.test(String(f.text || ''))
}
