import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import { dataDir, readJson, writeJson, lockAndRun } from '../core/store.js'

const usersFile = () => dataDir('users.json')
const sessionsFile = () => dataDir('web-sessions.json')
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000

function hashPassword(pw, salt) {
  return scryptSync(String(pw), salt, 64).toString('hex')
}

function loadUsers() {
  return readJson(usersFile(), () => ({ owner: null, guests: {} }))
}
function saveUsers(u) {
  writeJson(usersFile(), u)
}

function loadSessions() {
  return readJson(sessionsFile(), () => ({}))
}
function saveSessions(s) {
  writeJson(sessionsFile(), s)
}

// #8：web-sessions.json 以前是 load→改→save 整份无锁写，两个进程同时登录/登出会互相盖掉。
// 写操作统一进锁（读保持同步：writeJson 是原子替换，读到的永远是完整文件）。
const SESSIONS_LOCK = { staleMs: 10000, timeoutMs: 8000 }
async function updateSessions(mutator) {
  return lockAndRun('web-sessions', () => {
    const s = loadSessions()
    const out = mutator(s)
    saveSessions(s)
    return out
  }, SESSIONS_LOCK)
}

// #8 同一族：users.json 以前也是 loadUsers() 改完 saveUsers() 整份裸写，
// 两个进程同时建客人/改权限会互相盖掉。所有写操作统一进锁。
const USERS_LOCK = { staleMs: 10000, timeoutMs: 8000 }
async function updateUsers(mutator) {
  return lockAndRun('web-users', () => {
    const u = loadUsers()
    const out = mutator(u)
    saveUsers(u)
    return out
  }, USERS_LOCK)
}

export function needSetup() {
  return !loadUsers().owner
}

export async function setupOwner({ username, password }) {
  if (!username || !password) return { ok: false, reason: '用户名和密码都不能为空' }
  if (String(password).length < 6) return { ok: false, reason: '密码至少 6 位' }
  return updateUsers((u) => {
    if (u.owner) return { ok: false, reason: '已经有主人了' }
    const salt = randomBytes(16).toString('hex')
    u.owner = {
      subject: 'owner',
      role: 'owner',
      username: String(username),
      salt,
      hash: hashPassword(password, salt),
      createdAt: Date.now(),
    }
    return { ok: true }
  })
}

export function verify(username, password) {
  const u = loadUsers()
  const candidates = [u.owner, ...Object.values(u.guests || {})].filter(Boolean)
  const acc = candidates.find((a) => a.username === String(username))
  if (!acc) return null
  const h = hashPassword(password, acc.salt)
  if (h.length !== acc.hash.length) return null
  if (!timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(acc.hash, 'hex'))) return null
  return acc
}

export async function issueSession(account) {
  const token = randomUUID()
  await updateSessions((s) => {
    s[token] = {
      subject: account.subject,
      role: account.role,
      level: account.level || (account.role === 'owner' ? 'full' : 'social'),
      at: Date.now(),
    }
  })
  return token
}

export function sessionUser(token) {
  if (!token) return null
  const s = loadSessions()
  const rec = s[token]
  if (!rec) return null
  if (Date.now() - rec.at > SESSION_TTL_MS) {
    // #8：过期清理是写操作，异步进锁做；读接口本身保持同步。
    updateSessions((d) => { delete d[token] }).catch(() => {})
    return null
  }
  return rec
}

export async function dropSession(token) {
  if (!token) return
  await updateSessions((s) => { delete s[token] }).catch(() => {})
}

export function ownerInfo() {
  const o = loadUsers().owner
  if (!o) return null
  return { subject: 'owner', role: 'owner', username: o.username }
}

export function listGuests() {
  return Object.values(loadUsers().guests || {}).map((g) => ({
    subject: g.subject,
    role: g.role,
    id: g.id,
    username: g.username,
    displayName: g.displayName,
    note: g.note,
    level: g.level || 'social',
  }))
}

function nextGuestId(u) {
  const ids = Object.values(u.guests || {}).map((g) => g.id).filter((n) => Number.isFinite(n))
  // 单调递增、永不复用：删光客人再建也不回到 guest-1（否则新客人会继承前一个人的
  // 聊天记录/媒体/事实——chatId 就是 subject）。
  const max = ids.length ? Math.max(...ids) : 0
  return Math.max(Number(u.guestSeq) || 0, max) + 1
}

export async function createGuest({ username, displayName, note }) {
  if (!username) return { ok: false, reason: '用户名不能为空' }
  return updateUsers((u) => {
    if (!u.owner) return { ok: false, reason: '还没有主人' }
    const id = nextGuestId(u)
    const subject = 'guest-' + id
    const password = randomBytes(4).toString('hex')
    const salt = randomBytes(16).toString('hex')
    u.guestSeq = id
    u.guests[subject] = {
      subject,
      role: 'guest',
      id,
      username: String(username),
      displayName: String(displayName || username),
      note: String(note || ''),
      // 默认只聊天。完全权限是主人事后手动点开的白名单，不在创建时一把全开（#44）。
      level: 'social',
      salt,
      hash: hashPassword(password, salt),
      createdAt: Date.now(),
    }
    return { ok: true, subject, id, username: String(username), password }
  })
}

// 改权限要立刻作用到已登录的会话，否则客人要等重新登录才生效。
async function syncSessionLevels(subject, level) {
  // #8：拿不到锁就「整份读改写」是更糟的行为——正好会把别的进程刚写进去的会话盖回去。
  // 这里失败就抛出去，由调用方把「没同步成功」如实报给面板（而不是吞掉显示成功）。
  await updateSessions((s) => {
    for (const rec of Object.values(s)) {
      if (rec && rec.subject === subject) rec.level = level
    }
  })
}

export async function updateGuest(subject, { displayName, note, username, password, level, confirm } = {}) {
  // #4：给客人开完全权限要二次确认（前端 confirm 后带 confirm:true），防误点一键开总闸。
  if (level === 'full' && confirm !== true) return { ok: false, reason: '给客人完全权限需要二次确认' }
  if (password && String(password).length < 6) return { ok: false, reason: '密码至少 6 位' }
  // #8：改客人资料/权限也是整份写，进锁；会话 level 在锁外同步（另一把锁）。
  const out = await updateUsers((u) => {
    const g = u.guests[subject]
    if (!g) return { ok: false, reason: '没有这个客人' }
    if (displayName !== undefined) g.displayName = String(displayName)
    if (note !== undefined) g.note = String(note)
    if (username !== undefined && username !== '') g.username = String(username)
    if (level === 'full' || level === 'social') g.level = level
    if (password) {
      g.salt = randomBytes(16).toString('hex')
      g.hash = hashPassword(password, g.salt)
    }
    return { ok: true, level: g.level }
  })
  if (out.ok && (level === 'full' || level === 'social')) {
    try {
      await syncSessionLevels(subject, out.level)
    } catch (error) {
      // 资料/权限已经存进 users.json 了，但已登录会话还是旧档位：如实告诉面板，
      // 让它提示「请再点一次重试」，而不是显示成功让人以为生效了。
      return { ok: false, reason: '权限已保存，但已登录的会话没同步（别的进程正在写会话）：' + (error?.message || error) + '；请再点一次重试' }
    }
  }
  const { level: _ignored, ...rest } = out
  return rest
}

export async function changePassword(subject, oldPassword, newPassword) {
  if (!newPassword) return { ok: false, reason: '新密码不能为空' }
  if (String(newPassword).length < 6) return { ok: false, reason: '密码至少 6 位' }
  // #8：改密码也是整份写，进锁，避免和别的写操作互相覆盖。
  return updateUsers((u) => {
    const acc = subject === 'owner' ? u.owner : u.guests?.[subject]
    if (!acc) return { ok: false, reason: '没有这个账号' }
    const h = hashPassword(oldPassword, acc.salt)
    if (h.length !== acc.hash.length || !timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(acc.hash, 'hex'))) {
      return { ok: false, reason: '旧密码不对' }
    }
    acc.salt = randomBytes(16).toString('hex')
    acc.hash = hashPassword(newPassword, acc.salt)
    return { ok: true }
  })
}

export async function deleteGuest(subject) {
  if (!loadUsers().guests?.[subject]) return { ok: false, reason: '没有这个客人' }
  // 先清会话、再删用户：反过来的话，会话写失败会留下「指向不存在客人」的孤儿会话。
  try {
    await updateSessions((s) => {
      for (const [k, v] of Object.entries(s)) if (v.subject === subject) delete s[k]
    })
  } catch (error) {
    return { ok: false, reason: '清理这个客人的登录会话失败：' + (error?.message || error) }
  }
  try {
    return await updateUsers((u) => {
      if (!u.guests) return { ok: true }
      delete u.guests[subject]
      return { ok: true }
    })
  } catch (error) {
    return { ok: false, reason: '删除客人失败：' + (error?.message || error) }
  }
}

export function displayNameOf(subject) {
  const u = loadUsers()
  if (subject === 'owner') return u.owner?.username || '主人'
  const g = u.guests?.[subject]
  return g?.displayName || g?.username || subject
}
