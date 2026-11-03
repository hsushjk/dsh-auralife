// life/alarm.js — 跨天自我唤醒：她自己设闹钟，到点主动来找你。
// 移植自 InquisiMind/digital-life 的 domain/lifecycle/alarms.py（timers 表 + fire_due_alarms）。
// auralife 版存 state.json.alarms（append + 标记 fired，不真删，可审计），
// 到期由 drive 的 60s 心跳扫描后 fire（主动搭话），而不是独立的调度线程。
// 多进程（审计）：所有「读-改-写」走 life.update（文件锁内串行），防止双进程重复响。

export function createAlarm({ life, log }) {
  // 设一个闹钟。同一 at（毫秒时间戳）只保留一个 pending，避免同一点重复响。
  function setAlarm(at, reason = '', payload = null) {
    return life.update((s) => {
      const t = Number(at)
      if (!Number.isFinite(t)) return { ok: false, message: '要一个有效的时间' }
      if (t <= Date.now()) return { ok: false, message: '时间已经过了' }
      const existing = s.alarms.find((a) => !a.fired && a.at === t)
      if (existing) {
        if (reason) existing.reason = String(reason).slice(0, 200)
        if (payload) existing.payload = payload
        return { ok: true, id: existing.id, deduped: true, alarm: existing }
      }
      const a = {
        id: `al${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
        at: t,
        reason: String(reason || '').slice(0, 200),
        payload: payload || null,
        fired: false,
        createdAt: Date.now(),
      }
      s.alarms.push(a)
      log?.info(`设闹钟：${new Date(t).toLocaleString('zh-CN', { hour12: false })} ${a.reason || ''}`)
      return { ok: true, id: a.id, alarm: a }
    })
  }

  // 扫到期的闹钟，返回并按时间升序标记 fired。drive 心跳里每次调一次。
  function fireDue(now = Date.now()) {
    return life.update((s) => {
      const due = s.alarms.filter((a) => !a.fired && a.at <= now).sort((a, b) => a.at - b.at)
      if (!due.length) return []
      for (const a of due) a.fired = true
      return due
    })
  }

  // 未响的闹钟（未来的），升序。
  function list(now = Date.now()) {
    const s = life.load()
    return s.alarms.filter((a) => !a.fired && a.at > now).sort((a, b) => a.at - b.at)
  }

  // 取消一个闹钟（标记 fired，不删数据）。
  function cancel(id) {
    return life.update((s) => {
      const a = s.alarms.find((x) => x.id === id && !x.fired)
      if (!a) return false
      a.fired = true
      return true
    })
  }

  return { setAlarm, fireDue, list, cancel }
}
