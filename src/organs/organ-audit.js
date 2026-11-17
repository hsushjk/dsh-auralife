// 器官审计（organ-audit）：谁在什么时候加载/卸载/调工具/联网/读写/借模型/自举了器官。
//
// 目的不是拦截（拦截靠 guard + worker 隔离 + 白名单），而是「事后能查」：
// 出问题时能定位到具体器官、具体动作、具体参数（截断），然后卸掉它。
// 落盘：<dataDir>/organs/audit.jsonl，一行一条 JSON；超过 2MB 轮转成 audit.jsonl.1。
import { appendFileSync, existsSync, readFileSync, renameSync, statSync } from 'node:fs'
import { dataDir, ensureDir } from '../core/store.js'

const MAX_BYTES = 2 * 1024 * 1024
const MAX_READ = 200

export const clip = (value, n = 300) => {
  let s
  if (typeof value === 'string') s = value
  else {
    try { s = JSON.stringify(value) } catch { s = String(value) }
  }
  s = String(s ?? '')
  return s.length > n ? s.slice(0, n) + '…' : s
}

export function createOrganAudit({ log = console } = {}) {
  const file = () => dataDir('organs', 'audit.jsonl')

  function rotateIfNeeded() {
    try {
      if (!existsSync(file())) return
      if (statSync(file()).size <= MAX_BYTES) return
      renameSync(file(), file() + '.1')
    } catch (error) {
      log.warn('器官审计轮转失败：' + (error?.message || error))
    }
  }

  function append(entry) {
    try {
      ensureDir(dataDir('organs'))
      const record = { ts: Date.now(), ...entry }
      appendFileSync(file(), JSON.stringify(record) + '\n')
      rotateIfNeeded()
      return record
    } catch (error) {
      log.warn('器官审计写入失败：' + (error?.message || error))
      return null
    }
  }

  function list({ limit = 100 } = {}) {
    try {
      if (!existsSync(file())) return []
      const keep = Math.max(1, Math.min(MAX_READ, Number(limit) || 100))
      const lines = readFileSync(file(), 'utf8').split('\n').filter(Boolean).slice(-keep)
      const out = []
      for (const line of lines) {
        try { out.push(JSON.parse(line)) } catch { /* 跳过坏行 */ }
      }
      return out
    } catch (error) {
      log.warn('器官审计读取失败：' + (error?.message || error))
      return []
    }
  }

  return { append, list, file }
}