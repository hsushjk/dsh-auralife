import { existsSync, mkdirSync, copyFileSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dataDir } from '../core/store.js'

const TEMPLATES = fileURLToPath(new URL('./templates/', import.meta.url))
const README = 'Interface.md'

// 翻唱槽删除；「本地接口」改名「自定义接口」，三个槽分别并入 TTS/STT/生图的「自定义」档。
export const SLOTS = {
  tts: { file: 'tts.mjs', title: '语音合成', timeoutMs: 60_000, example: 'GPT-SoVITS（http://127.0.0.1:9880，参考音频在 D:/voices/ref.wav）' },
  image: { file: 'image.mjs', title: '生图', timeoutMs: 300_000, example: 'SD WebUI（http://127.0.0.1:7860）或 ComfyUI（http://127.0.0.1:8188）' },
  asr: { file: 'asr.mjs', title: '语音识别', timeoutMs: 60_000, example: 'FunASR / faster-whisper 的本地服务（http://127.0.0.1:8000）' },
}

export async function toImageBuffer(r) {
  if (Buffer.isBuffer(r)) return r
  if (r?.buffer && Buffer.isBuffer(r.buffer)) return r.buffer
  if (r?.base64) return Buffer.from(String(r.base64).replace(/^data:[^,]+,/, ''), 'base64')
  if (r?.file) return readFileSync(r.file)
  if (r?.url) {
    const res = await fetch(r.url, { signal: AbortSignal.timeout(60000) })
    if (!res.ok) throw new Error(`下载图片失败（HTTP ${res.status}）`)
    return Buffer.from(await res.arrayBuffer())
  }
  if (typeof r === 'string' && existsSync(r)) return readFileSync(r)
  throw new Error('生图脚本没返回图片（要返回 Buffer，或 {buffer|file|base64|url}）')
}

export const fileOf = (r) => (typeof r === 'string' ? r : r?.file || r?.output || '')

export function createLocal({ getConfig, log }) {
  const dir = () => dataDir('local')
  const outDir = () => dataDir('local', 'out')
  const pathOf = (slot) => join(dir(), SLOTS[slot].file)
  const last = {}

  function active(slot) {
    return Boolean(getConfig().local?.[slot]) && existsSync(pathOf(slot))
  }

  async function call(slot, args) {
    const spec = SLOTS[slot]
    const file = pathOf(slot)
    const t = Date.now()
    try {

      const mod = await import(pathToFileURL(file).href + '?v=' + statSync(file).mtimeMs)
      const fn = mod.default || mod.run
      if (typeof fn !== 'function') throw new Error(`${spec.file} 里没有 export default 的函数`)
      mkdirSync(outDir(), { recursive: true })
      const child = log.child ? log.child('local') : log
      let timer
      const result = await Promise.race([
        fn({ ...args, outDir: outDir(), log: child }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`超过 ${Math.round(spec.timeoutMs / 1000)} 秒没完成`)), spec.timeoutMs) }),
      ]).finally(() => clearTimeout(timer))
      last[slot] = { ok: true, at: Date.now(), message: `用时 ${((Date.now() - t) / 1000).toFixed(1)} 秒` }
      return result
    } catch (error) {
      last[slot] = { ok: false, at: Date.now(), message: String(error.message || error).slice(0, 300) }
      log.warn(`自定义接口「${spec.title}」出错：`, last[slot].message)
      throw error
    }
  }

  function template(slot) {
    mkdirSync(dir(), { recursive: true })
    if (!existsSync(join(dir(), README))) copyFileSync(join(TEMPLATES, README), join(dir(), README))
    const dest = pathOf(slot)
    if (existsSync(dest)) return { ok: true, created: false, path: dest, message: '文件已经有了，没覆盖' }
    copyFileSync(join(TEMPLATES, SLOTS[slot].file), dest)
    return { ok: true, created: true, path: dest, message: '模板放好了，照里面的注释改，或者让 DSH 帮你改' }
  }

  function promptFor(slot) {
    const s = SLOTS[slot]
    return `帮我修改 AuraLife 的自定义接口脚本：${pathOf(slot)}\n`
      + `先读同一个文件夹里的「${README}」了解参数和返回值的约定，再把这个脚本改成调用我电脑上的${s.title}：\n`
      + `【这里写你用的是什么、地址、模型和关键参数，例如：${s.example}】\n`
      + '只改这一个脚本，不要动插件本身的代码；改完告诉我怎么测试。'
  }

  function status() {
    return Object.entries(SLOTS).map(([slot, s]) => ({
      slot, title: s.title, file: s.file, path: pathOf(slot),
      exists: existsSync(pathOf(slot)), enabled: Boolean(getConfig().local?.[slot]), active: active(slot),
      last: last[slot] || null, prompt: promptFor(slot),
    }))
  }

  return { active, call, template, status, dir, pathOf }
}
