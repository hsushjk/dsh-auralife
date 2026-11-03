import { readFileSync, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { VERSION } from '../core/version.js'
import { listPersonas } from '../persona/personas.js'
import { edgeInstalled, installEdge, PYENV_DIR, textToSpeech } from '../voice/tts.js'
import { createRouter } from './router.js'
import * as sessionRoutes from './routes/session.js'
import * as chatRoutes from './routes/chat.js'
import * as azoneRoutes from './routes/azone.js'
import * as mediaRoutes from './routes/media.js'
import * as memoryRoutes from './routes/memory.js'
import * as voiceRoutes from './routes/voice.js'
import * as settingsRoutes from './routes/settings.js'
import * as debugRoutes from './routes/debug.js'
import {
  needSetup, setupOwner, verify, issueSession, sessionUser, dropSession,
  ownerInfo, listGuests, createGuest, updateGuest, deleteGuest, displayNameOf, changePassword,
} from './auth.js'

const ROOT = fileURLToPath(new URL('../../public/', import.meta.url))
const PREFIX = '/auralife'
const SSE_HEARTBEAT_MS = 25e3
// 前端缓存破坏（「发文件还是不行」排查）：入口资源带进程启动版本号，
// DSH 重启 = URL 变化 = 浏览器必然重新拉取，不再吃到旧页面/旧 JS。
const FRONT_VER = Date.now()

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(typeof body === 'string' ? body : JSON.stringify(body))
}

function json(res, body) { send(res, 200, body) }

function readBody(req, maxBytes = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    let done = false
    const fail = (e) => { if (!done) { done = true; reject(e) } }
    req.on('data', (c) => {
      const buf = typeof c === 'string' ? Buffer.from(c) : c
      size += buf.length
      if (size > maxBytes) { req.pause(); fail(new Error('请求体太大')) }
      else chunks.push(buf)
    })
    req.on('end', () => {
      if (done) return
      done = true
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}) } catch (e) { reject(e) }
    })
    req.on('error', fail)
  })
}

function tokenOf(req) {
  const h = req.headers || {}
  const auth = h.authorization || h.Authorization || ''
  if (String(auth).startsWith('Bearer ')) return String(auth).slice(7).trim()
  const cookie = h.cookie || h.Cookie || ''
  const m = String(cookie).match(/(?:^|;\s*)oc_s=([^;]+)/)
  return m ? m[1] : null
}

function stripDataUrl(s) {
  const v = String(s || '').trim()
  const i = v.indexOf(',')
  return i >= 0 && v.startsWith('data:') ? v.slice(i + 1) : v
}

export function createWebServer({ dsh, getConfig, setConfig, publicConfig, log, getConfigForRoutes }) {
  const clients = new Set()
  const router = createRouter()
  let boundDeps = null

  function emit(type, payload) {
    const data = JSON.stringify({ type, ...payload })
    for (const c of clients) {
      if (c.chatId && payload.chatId && c.chatId !== payload.chatId) continue
      try { c.res.write(`data: ${data}\n\n`) } catch {}
    }
  }

  function chatIdOf(subject) { return String(subject) }

  function requireUser(req, res) {
    const me = sessionUser(tokenOf(req))
    if (!me) { json(res, { ok: false, reason: '没登录' }); return null }
    return me
  }

  function requireOwner(req, res) {
    const me = requireUser(req, res)
    if (!me) return null
    if (me.role !== 'owner') { json(res, { ok: false, reason: '只有主人能这么做' }); return null }
    return me
  }

  function buildContext(deps) {
    return {
      json, send, readBody, tokenOf, stripDataUrl, chatIdOf, requireUser, requireOwner,
      dsh, getConfig, setConfig, publicConfig, log, VERSION, MIME, ROOT,
      listModels: deps.listModels || (async () => null),
      listPersonas,
      needSetup, setupOwner, verify, issueSession, sessionUser, dropSession,
      ownerInfo, listGuests, createGuest, updateGuest, deleteGuest, displayNameOf, changePassword,
      edgeInstalled, installEdge, PYENV_DIR, textToSpeech,
      deps,
    }
  }

  let routesReady = false
  function buildRoutes(deps) {
    if (routesReady) return
    const ctx = buildContext(deps)
    for (const mod of [sessionRoutes, chatRoutes, azoneRoutes, mediaRoutes, memoryRoutes, voiceRoutes, settingsRoutes, debugRoutes]) {
      mod.register(router, ctx)
    }
    routesReady = true
  }

  async function handleApi(req, res, pathname, url, deps) {
    buildRoutes(deps)
    const method = String(req.method || 'GET').toUpperCase()
    const p = pathname.slice(PREFIX.length + 1)
    const route = router.match(method, p)
    if (!route) return json(res, { ok: false, reason: '不认识这个接口：' + p })
    return await route.handler(req, res, url, p)
  }

  function serveStatic(req, res, pathname) {
    const rel = pathname === PREFIX || pathname === PREFIX + '/' ? 'index.html' : pathname.slice(PREFIX.length + 1)
    if (rel.includes('..') || rel.includes('\\')) return send(res, 403, 'no')
    const file = join(ROOT, rel)
    if (!existsSync(file) || !statSync(file).isFile()) return send(res, 404, 'not found', 'text/plain; charset=utf-8')
    const ext = (file.match(/\.[a-z0-9]+$/i) || ['.html'])[0].toLowerCase()
    let buf = readFileSync(file)
    if (ext === '.html') {
      // index.html 入口资源挂版本号，模块子文件随入口刷新（模块图 URL 不变但 no-store 保证重验）
      buf = Buffer.from(buf.toString('utf8')
        .replace('src="app.js"', 'src="app.js?v=' + FRONT_VER + '"')
        .replace('href="app.css"', 'href="app.css?v=' + FRONT_VER + '"'))
    }
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'content-length': buf.length, 'cache-control': 'no-store' })
    res.end(buf)
  }

  function handleStream(req, res, url) {
    const me = sessionUser(url.searchParams.get('token'))
    if (!me) return send(res, 401, { ok: false, reason: '没登录' })
    const chatId = chatIdOf(me.subject)
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.write(': connected\n\n')
    const client = { res, chatId }
    clients.add(client)
    const heartbeat = setInterval(() => { try { res.write(': ping\n\n') } catch {} }, SSE_HEARTBEAT_MS)
    req.on('close', () => { clearInterval(heartbeat); clients.delete(client) })
  }

  function handleRequest(deps, { root = false } = {}) {
    return async (req, res) => {
      try {
        const url = new URL(String(req.url || '/'), 'http://auralife.local')
        let pathname = url.pathname
        if (root) {
          if (pathname === PREFIX || pathname.startsWith(PREFIX + '/')) {
            return send(res, 404, 'not found: 固定端口只认根路径（/），不要加 /auralife 前缀', 'text/plain; charset=utf-8')
          }
          pathname = PREFIX + (pathname.startsWith('/') ? pathname : '/' + pathname)
        }
        if (!pathname.startsWith(PREFIX)) return send(res, 404, 'not found', 'text/plain; charset=utf-8')
        if (pathname === PREFIX + '/api/stream') return handleStream(req, res, url)
        if (pathname.startsWith(PREFIX + '/api/')) return await handleApi(req, res, pathname, url, deps)
        return serveStatic(req, res, pathname)
      } catch (e) {
        try { json(res, { ok: false, message: String((e && e.message) || e) }) } catch {}
      }
    }
  }

  function register(ctx, deps) {
    boundDeps = deps
    buildRoutes(deps)
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: PREFIX,
      handler: handleRequest(deps),
    }), 'auralife: 网页')
  }

  let own = null
  let ownPort = 0
  let ownHost = ''

  function listenPort(port) {
    if (!boundDeps) return { ok: false, reason: '还没装好' }
    const conf = getConfig().web || {}
    const wantPort = Math.round(Number(port) || conf.port || 2332)
    const wantHost = String(conf.host || '0.0.0.0').trim() || '0.0.0.0'
    if (own && ownPort === wantPort && ownHost === wantHost) return { ok: true, port: ownPort, host: ownHost, url: `http://127.0.0.1:${ownPort}/` }
    if (own) { try { own.close() } catch {} own = null; ownPort = 0; ownHost = '' }
    const srv = createServer(handleRequest(boundDeps, { root: true }))
    srv.on('error', (e) => {
      log.warn(`固定入口 ${wantHost}:${wantPort} 没起来：${(e && e.message) || e}`)
      own = null
      ownPort = 0
      ownHost = ''
    })
    srv.listen(wantPort, wantHost, () => {
      own = srv
      ownPort = wantPort
      ownHost = wantHost
      const shown = wantHost === '0.0.0.0' || wantHost === '::' ? '127.0.0.1（或本机局域网 IP）' : wantHost
      log.info(`固定入口 http://${shown}:${wantPort}/`)
    })
    return { ok: true, port: wantPort, host: wantHost }
  }

  return {
    emit,
    register,
    listenPort,
    closePort: () => { if (own) { try { own.close() } catch {} own = null; ownPort = 0; ownHost = '' } },
    ownEntry: () => (own ? { host: ownHost, port: ownPort } : null),
    routes: () => router.size(),
  }
}
