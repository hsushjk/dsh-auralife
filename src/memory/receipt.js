// memory/receipt.js — 写完读回三态回执（模仿 digital-life-core 的 saved: found/missing/unknown）。
//
// 动机：旧的 memory.js 写记忆是「调完 LLM 就当写进去了」，没有自证；
// digital-life-core 的教训是「器官热重载时 saveStore 静默空转却仍回 ok:true」，
// 导致 7 场梦只有 1 场真落盘。所以每次写完，必须把 id 读回来确认。
//
// 三态：
//   found   —— 声称写入的每条事实都能按 id 读回；
//   missing —— 有 id 读不回来（真丢了）；
//   unknown —— 拿不到 id 清单，无法判断（老式纯文本库/上游没交回清单）。

export function createReceipt({ store, log = console }) {
  // 按 id 逐条读回。store 的 append 会失效缓存，所以 findFact 会重新读盘。
  function verifyFacts(ids) {
    const found = []
    const missing = []
    for (const id of ids || []) {
      if (store.findFact(id)) found.push(id)
      else missing.push(id)
    }
    return { found, missing }
  }

  // 审计一次写入的 claim（encode 的返回：added/addedIds/superseded/supersededIds/summary）
  function audit(claim) {
    const ids = [...(claim?.addedIds || []), ...(claim?.supersededIds || [])]
    const nClaims = (claim?.added || 0) + (claim?.superseded || 0)
    if (!ids.length) {
      // 拿不到 id 清单：声称写了但无法核对 → unknown；没写 → found（空操作也算成功）
      return nClaims
        ? { state: 'unknown', found: [], missing: [], detail: 'no ids returned' }
        : { state: 'found', found: [], missing: [], detail: 'nothing to verify' }
    }
    const { found, missing } = verifyFacts(ids)
    const state = missing.length ? 'missing' : 'found'
    if (missing.length) log.warn(`回执 missing：${missing.length} 条事实没读回来`)
    return { state, found, missing, detail: `${found.length}/${ids.length} verified` }
  }

  return { verifyFacts, audit }
}
