// memory/similar.js — 字面相似度与判重（记忆 v2 共用，recall/encode 都依赖）。
//
// 判重阈值从 0.6 提到 0.85，并加「实体保护」+「否定词保护」：
//   - 实体保护：主语（subj）不同就不算重复；
//   - 否定词保护：一条含否定、另一条不含，判为「矛盾」而不是「重复」，
//     矛盾走 supersedes 版本链，不能静默合并。
const STOP = new Set('的了是我你他她它们在有和就不也都很吗吧呢啊呀哦嗯这那个一上下来去说要会能着过'.split(''))

export function tokenize(text) {
  const out = []
  const s = String(text || '').toLowerCase()
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

export const DEDUP_THRESHOLD = 0.85

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

// 判断是否重复：字面近 + 同实体 + 否定一致
export function isDup(a, b) {
  if (!a?.text || !b?.text) return false
  if (similarity(a.text, b.text) < DEDUP_THRESHOLD) return false
  if (!sameEntity(a, b)) return false
  return isNegation(a.text) === isNegation(b.text)
}

// 是否是「承诺/约定/雷点」类硬事实（进 archive 硬档）
export function isHardFact(f) {
  if (f.src === 'manual' || f.src === 'told') return true
  if ((f.conf ?? 0) >= 0.6) return true
  return /(答应|约定|承诺|说好|记得|别忘了|以后|保证|不许|别在|雷|底线|讨厌|忌讳)/.test(String(f.text || ''))
}
