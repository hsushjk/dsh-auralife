import { dataDir } from './store.js'
import { redact } from './redact.js'

const RING = 500
const LEVELS = ['debug', 'info', 'warn', 'error']
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024

export function createLogger({ dsh, getMaxBytes = () => DEFAULT_MAX_BYTES } = {}) {
  const ring = []
  const listeners = new Set()
  let ringBytes = 0
  let dropped = 0

  function trim() {
    const max = Math.max(64 * 1024, Number(getMaxBytes()) || DEFAULT_MAX_BYTES)
    while (ring.length > 1 && ringBytes > max) {
      ringBytes -= sizeOf(ring.shift())
      dropped++
    }
    while (ring.length > RING) {
      ringBytes -= sizeOf(ring.shift())
      dropped++
    }
  }

  function write(level, area, message) {
    const text = redact(message)
    const d = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    const entry = { t: d.getTime(), time: `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`, level, area, text }
    ring.push(entry)
    ringBytes += sizeOf(entry)
    trim()
    try {
      const fn = level === 'error' ? dsh?.logger?.error : level === 'warn' ? dsh?.logger?.warn : dsh?.logger?.info
      if (level !== 'debug') fn?.call(dsh.logger, `auralife[${area}]: ${text}`)
    } catch (error) {}
    for (const l of listeners) {
      try { l(entry) } catch (error) {}
    }
    return entry
  }

  // child 可以继续链下去：logger.child('organs').child('clock') → area 拼成 organs:clock。
  // （此前 child 返回的对象没有 child 方法，organ-host 的 apiFor 调 logger.child() 会抛
  // 「logger.child is not a function」，导致器官热加载全部失败。）
  function child(area) {
    const c = {}
    for (const lv of LEVELS) c[lv] = (...args) => write(lv, area, args.map(fmt).join(' '))
    c.child = (sub) => child(area + ':' + sub)
    return c
  }

  return {
    child,
    recent(limit = 200, filter = {}) {
      return ring
        .filter((e) => (!filter.level || LEVELS.indexOf(e.level) >= LEVELS.indexOf(filter.level)) && (!filter.area || e.area === filter.area))
        .slice(-limit)
    },
    onEntry(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    clear() {
      const n = ring.length
      ring.length = 0
      ringBytes = 0
      dropped = 0
      return n
    },
    stats() {
      return { count: ring.length, bytes: ringBytes, dropped }
    },
  }
}

function fmt(v) {
  if (v instanceof Error) return v.message
  if (typeof v === 'string') return v
  try { return JSON.stringify(v) } catch (error) { return String(v) }
}

function sizeOf(entry) {
  return 64 + (entry.text ? entry.text.length * 2 : 0)
}
