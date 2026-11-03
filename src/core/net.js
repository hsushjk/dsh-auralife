// —— 外网资源防护与抓取（AuraLife 自己的实现，2026-11 重写）——// 两条线：assertPublicUrl 只放行「公网」URL（拦本机/内网 = 防 AI 被诱导 SSRF）；
// fetchImage 把 base64://、http(s)、本地路径统一成图片字节，全程限流大小。
import { readFileSync, statSync } from 'node:fs'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { fileURLToPath } from 'node:url'

// —— IPv4 私有/保留段（区间比较，比逐字节拆更快更直观）——
const ipv4 = (s) => {
  const parts = s.split('.')
  if (parts.length !== 4) return null
  const nums = parts.map(Number)
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
  return (nums[0] << 24) | (nums[1] << 16) | (nums[2] << 8) | nums[3]
}

const ipv4Restricted = (v) => {
  const inRange = (lo, hi) => v >= lo && v <= hi
  return (
    inRange(0x00000000, 0x00ffffff) || // 0.0.0.0/8
    inRange(0x0a000000, 0x0affffff) || // 10.0.0.0/8
    inRange(0x64400000, 0x647fffff) || // 100.64.0.0/10（运营商级 NAT）
    inRange(0x7f000000, 0x7fffffff) || // 127.0.0.0/8
    inRange(0xa9fe0000, 0xa9feffff) || // 169.254.0.0/16（链路本地）
    inRange(0xac100000, 0xac1fffff) || // 172.16.0.0/12
    inRange(0xc0a80000, 0xc0a8ffff) || // 192.168.0.0/16
    v >= 0xe0000000 // 224.0.0.0/4（组播与保留）
  )
}

function isRestrictedIp(address) {
  if (!address) return true
  const ip = address.toLowerCase()
  if (ip.includes(':')) {
    // IPv6：本机回环、ULA(fc/fd)、链路本地(fe80)、全零、以及映射回 IPv4 的私有段
    if (ip === '::1' || ip === '::') return true
    if (ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80')) return true
    const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    return mapped ? ipv4Restricted(ipv4(mapped[1])) : false
  }
  const v = ipv4(ip)
  return v === null || ipv4Restricted(v)
}

export async function assertPublicUrl(url) {
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('只允许 http / https')
  const host = parsed.hostname.replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost')) throw new Error('不允许访问本机地址')
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((entry) => entry.address)
  if (!addresses.length || addresses.some(isRestrictedIp)) throw new Error('不允许访问内网地址')
}

// ——抓图：支持 base64:// 前缀、http(s) 地址（会过公网校验）、本地绝对路径/文件 URL ——
export async function fetchImage(source, options = {}) {
  const maxBytes = options.maxBytes ?? 10 * 1024 * 1024
  const src = String(source || '').trim()
  if (!src) throw new Error('没有地址')

  if (src.startsWith('base64://')) {
    const bytes = Buffer.from(src.slice('base64://'.length), 'base64')
    if (bytes.length > maxBytes) throw new Error('太大了')
    return bytes
  }

  if (/^https?:\/\//.test(src)) {
    await assertPublicUrl(src)
    const resp = await fetch(src, { signal: AbortSignal.timeout(options.timeoutMs ?? 20000), redirect: 'follow' })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const declared = Number(resp.headers.get('content-length') || 0)
    if (declared > maxBytes) throw new Error('太大了')
    const body = Buffer.from(await resp.arrayBuffer())
    if (body.length > maxBytes) throw new Error('太大了')
    return body
  }

  if (options.allowLocal !== false) {
    const localPath = src.startsWith('file://') ? fileURLToPath(src) : src
    const looksAbsolute = /^[a-zA-Z]:[\\/]/.test(localPath) || localPath.startsWith('/')
    if (looksAbsolute) {
      if (statSync(localPath).size > maxBytes) throw new Error('太大了')
      return readFileSync(localPath)
    }
  }

  throw new Error('不认识的地址')
}
