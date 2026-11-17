// —— 数据目录与 JSON 持久化（AuraLife 自己写的实现，2026-11 重写）——// 所有可写数据都放在 DSH 的插件数据目录下：
//   <DSH_HOME>/plugins-data/auralife/…（可用 AURALIFE_DATA_DIR 覆盖，测试用）
import { readFileSync, writeFileSync, mkdirSync, unlinkSync, openSync, closeSync, existsSync, renameSync, copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

const osHome = () => process.env.DSH_HOME || join(homedir(), '.dsh')

let cachedBase = null
function pluginDataBase() {
  if (cachedBase === null) cachedBase = process.env.AURALIFE_DATA_DIR || join(osHome(), 'plugins-data', 'auralife')
  return cachedBase
}

export function dataDir(...segments) {
  return join(pluginDataBase(), ...segments)
}

// 数字兜底：Number(x) ?? 默认值 挡不住 NaN（NaN 不是 nullish），
// 缺字段/脏数据时会算出 NaN 并一路污染排序与持久化。统一用这个。
export function numOr(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

export function ensureDir(target) {
  mkdirSync(target, { recursive: true })
  return target
}

// 读取 JSON。文件不存在 → fallback（值或工厂函数）。
// 文件在但内容不是合法 JSON = 损坏：把原件挪成 <file>.corrupt-<时间戳> 留证，
// 下次写盘会落一份新的——杜绝「读不到 → 用默认值 → 写回 → 连坏数据一起抹掉」。
export function readJson(file, fallback) {
  const resolveFallback = () => (typeof fallback === 'function' ? fallback() : fallback)
  let parsed
  try {
    let raw = readFileSync(file, 'utf8')
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1) // 去 BOM
    parsed = JSON.parse(raw)
    return parsed
  } catch (err) {
    const missing = err && (err.code === 'ENOENT' || err.code === 'EISDIR')
    if (!missing) {
      const snapshot = `${file}.corrupt-${Date.now()}`
      try {
        renameSync(file, snapshot)
      } catch {
        try { copyFileSync(file, snapshot) } catch { /* 连备份都做不了，就算了 */ }
      }
      console.warn(`[auralife] readJson 发现损坏文件，已备份到 ${snapshot}`)
    }
    return resolveFallback()
  }
}

export function writeJson(file, value) {
  ensureDir(dirname(file))
  const staging = `${file}.staging-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  writeFileSync(staging, JSON.stringify(value, null, 2), 'utf8')
  try {
    renameSync(staging, file) // 同目录 rename = 原子替换
  } catch (err) {
    try { unlinkSync(staging) } catch { /* 清理失败不影响主流程 */ }
    throw err
  }
}

export { existsSync }

// —— 跨进程互斥锁——
// DSH 会为每个会话进程各加载一份插件，同一批数据文件会被多个进程同时「读-改-写」。
// 锁实现：locks/<name>.lock.json 的原子创建（openSync 的 'wx' 模式：文件已存在必失败，跨平台原子）。
// 持有者把 {pid, at, token} 写进锁文件；崩溃没释放的锁超过 staleMs 会被下一位抢占。
// 等锁用 await sleep 让出事件循环（同步自旋 Atomics.wait 会把整个 DSH 进程卡住几秒）。
// fn 可以是同步函数也可以是 async 函数：返回值原样返回，抛错原样抛出，
// 但无论走哪条路，心跳 interval 和锁文件都在 finally 里释放。
const lockFileFor = (name) => dataDir('locks', `${name}.lock.json`)
const lockSleep = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, Math.max(0, ms)); t.unref?.() })

// 抢一次锁：成功返回 fd；被别的进程持有返回 null（顺手清掉超过 staleMs 的僵尸锁）。
function tryAcquireFileLock(lockFile, staleMs) {
  try {
    return openSync(lockFile, 'wx')
  } catch (err) {
    if (err.code !== 'EEXIST') throw err
    try {
      const owner = JSON.parse(readFileSync(lockFile, 'utf8'))
      const abandoned = !owner || Date.now() - (owner.at || 0) > staleMs
      if (abandoned) unlinkSync(lockFile)
    } catch {
      try { unlinkSync(lockFile) } catch { /* 别人刚好拿走 */ }
    }
    return null
  }
}

export async function withFileLock(name, fn, opts = {}) {
  const { staleMs = 15000, timeoutMs = 8000, spinMs = 15 } = opts
  const lockFile = lockFileFor(name)
  const giveUpAt = Date.now() + timeoutMs
  const token = `${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  ensureDir(dirname(lockFile))
  let fd = null
  let waitMs = spinMs
  for (;;) {
    fd = tryAcquireFileLock(lockFile, staleMs)
    if (fd !== null) break
    const left = giveUpAt - Date.now()
    if (left <= 0) {
      throw new Error(`withFileLock: 拿不到锁 ${name}（${Math.round(timeoutMs / 1000)} 秒超时，可能别的进程卡死）`)
    }
    // 关键：异步等锁。以前是 Atomics.wait 同步自旋，一次锁冲突能冻住整个事件循环 8 秒。
    await lockSleep(Math.min(waitMs, left))
    waitMs = Math.min(250, Math.round(waitMs * 1.8))
  }
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now(), token }), 'utf8')
  } finally {
    closeSync(fd)
  }
  // 心跳：长任务（几秒钟以上的 LLM 调用）里定期刷新 at，防止被别的进程当死锁抢走。
  // release 校验持有者：锁被抢走后旧持有者不能误删新持有者的锁文件。
  let heart = null
  if (staleMs > 2000) {
    heart = setInterval(() => {
      try { writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: Date.now(), token }), 'utf8') } catch { /* 锁已被抢走，心跳失败就失败 */ }
    }, Math.max(500, Math.floor(staleMs / 3)))
    try { heart.unref?.() } catch { /* 无所谓 */ }
  }
  try {
    return await fn()
  } finally {
    if (heart) clearInterval(heart)
    try {
      const owner = JSON.parse(readFileSync(lockFile, 'utf8'))
      if (owner && owner.token === token) unlinkSync(lockFile)
    } catch { /* 已释放 */ }
  }
}
