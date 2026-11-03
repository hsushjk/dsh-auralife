import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, statSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { buildWav, toMono16k } from './wav.js'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { dataDir } from '../core/store.js'

const LEGACY_PYENV = 'C:\\AuraChat\\pyenv'
export const PYENV_DIR = process.env.AURACHAT_PYENV || (existsSync(LEGACY_PYENV) ? LEGACY_PYENV : join(homedir(), 'AuraChat', 'pyenv'))
// Linux 兼容：Windows 的 venv 是 Scripts/python.exe，Linux 是 bin/python。
const pyExe = () => join(PYENV_DIR, process.platform === 'win32' ? join('Scripts', 'python.exe') : join('bin', 'python'))

function run(cmd, args, { timeoutMs = 60000, input, env } = {}) {
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    let child
    try {
      child = spawn(cmd, args, { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', ...(env || {}) } })
    } catch (error) {
      resolve({ code: -1, out, err: error.message })
      return
    }
    const t = setTimeout(() => {
      try { child.kill() } catch (e) {}
      err += '\n超时'
    }, timeoutMs)
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('error', (e) => { err += e.message })
    child.on('close', (code) => {
      clearTimeout(t)
      resolve({ code, out, err })
    })
    if (input !== undefined) {
      child.stdin.end(input, 'utf8')
    }
  })
}

function outDir() {
  const d = dataDir('voice-cache')
  mkdirSync(d, { recursive: true })

  try {
    for (const n of readdirSync(d)) {
      const p = join(d, n)
      if (Date.now() - statSync(p).mtimeMs > 86400_000) unlinkSync(p)
    }
  } catch (error) {}
  return d
}

export function edgeInstalled() {
  if (!existsSync(pyExe())) return false
  if (existsSync(join(PYENV_DIR, 'Lib', 'site-packages', 'edge_tts'))) return true // Windows venv
  try {
    // Linux venv：lib/python3.xx/site-packages/edge_tts
    for (const n of readdirSync(join(PYENV_DIR, 'lib'))) {
      if (/^python\d/.test(n) && existsSync(join(PYENV_DIR, 'lib', n, 'site-packages', 'edge_tts'))) return true
    }
  } catch (error) {}
  return false
}

export async function installEdge(log) {
  mkdirSync(PYENV_DIR, { recursive: true })
  if (!existsSync(pyExe())) {
    // Linux 兼容：Windows 试 py -3 / python；Linux 试 python3 / python。
    let r
    if (process.platform === 'win32') {
      r = await run('py', ['-3', '-m', 'venv', PYENV_DIR], { timeoutMs: 180000 })
      if (r.code !== 0) r = await run('python', ['-m', 'venv', PYENV_DIR], { timeoutMs: 180000 })
    } else {
      r = await run('python3', ['-m', 'venv', PYENV_DIR], { timeoutMs: 180000 })
      if (r.code !== 0) r = await run('python', ['-m', 'venv', PYENV_DIR], { timeoutMs: 180000 })
    }
    if (r.code !== 0) {
      log?.info('电脑上没有可用的 Python，用 uv 准备一个私有的')
      const uv = await findOrFetchUv(log)
      if (!uv) return { ok: false, message: '准备 Python 失败：下载安装工具 uv 没成功，检查一下网络（开代理或换个网络）再试' }
      const env = { UV_PYTHON_INSTALL_DIR: join(dirname(PYENV_DIR), 'python'), UV_PYTHON_INSTALL_MIRROR: 'https://registry.npmmirror.com/-/binary/python-build-standalone' }
      r = await run(uv, ['venv', '-q', PYENV_DIR, '--python', '3.12'], { timeoutMs: 600000, env })
      if (r.code !== 0) return { ok: false, message: '准备 Python 失败：' + r.err.slice(-300) }
    }
  }
  log?.info('正在安装 edge-tts …')
  let r = await run(pyExe(), ['-m', 'pip', 'install', '-q', 'edge-tts'], { timeoutMs: 300000 })
  if (r.code !== 0) {
    r = await run(pyExe(), ['-m', 'pip', 'install', '-q', '-i', 'https://mirrors.aliyun.com/pypi/simple', 'edge-tts'], { timeoutMs: 300000 })
  }

  if (r.code !== 0 && /No module named pip/.test(r.err)) {
    const uv = await findOrFetchUv(log)
    if (uv) {
      r = await run(uv, ['pip', 'install', '-q', '--python', pyExe(), 'edge-tts'], { timeoutMs: 300000 })
      if (r.code !== 0) r = await run(uv, ['pip', 'install', '-q', '--python', pyExe(), '--default-index', 'https://mirrors.aliyun.com/pypi/simple', 'edge-tts'], { timeoutMs: 300000 })
    }
  }
  if (r.code !== 0) return { ok: false, message: '安装 edge-tts 失败：' + r.err.slice(-300) }
  return { ok: true, message: '语音组件装好了' }
}

async function findOrFetchUv(log) {
  if (process.env.AURACHAT_UV) return process.env.AURACHAT_UV
  if ((await run('uv', ['--version'], { timeoutMs: 15000 })).code === 0) return 'uv'
  const bin = join(dirname(PYENV_DIR), 'bin')
  const local = join(bin, process.platform === 'win32' ? 'uv.exe' : 'uv')
  for (const p of [local, join('C:\\AuraChat', 'rvc', 'bin', 'uv.exe'), join(homedir(), 'AuraChat', 'rvc', 'bin', 'uv.exe'), join(homedir(), 'AuraChat', 'rvc', 'bin', 'uv')]) if (existsSync(p)) return p
  log?.info('下载 uv …')
  mkdirSync(bin, { recursive: true })

  // Linux 兼容：Windows 走 PowerShell 下载 zip；Linux 用 Node fetch 下载 tar.gz + tar 解压。
  if (process.platform !== 'win32') {
    const arch = process.arch === 'arm64' ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-gnu'
    const sources = [
      `https://registry.npmmirror.com/-/binary/uv/release/0.6.10/uv-${arch}.tar.gz`,
      `https://github.com/astral-sh/uv/releases/download/0.6.10/uv-${arch}.tar.gz`,
    ]
    for (const url of sources) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(300000) })
        if (!res.ok) throw new Error('HTTP ' + res.status)
        const tgz = join(bin, 'uv.tar.gz')
        writeFileSync(tgz, Buffer.from(await res.arrayBuffer()))
        const r = await run('tar', ['-xzf', tgz, '-C', bin, '--strip-components=1'], { timeoutMs: 120000 })
        try { unlinkSync(tgz) } catch (error) {}
        if (r.code === 0 && existsSync(local)) return local
      } catch (error) {
        log?.info(`从 ${new URL(url).host} 下 uv 没成功：${error.message}`)
      }
    }
    return existsSync(local) ? local : ''
  }

  const zip = join(bin, 'uv.zip')
  const tmp = join(bin, 'uv-src')

  const UV_SOURCES = [
    { url: 'https://registry.npmmirror.com/-/binary/uv/release/0.6.10/uv-x86_64-pc-windows-msvc.zip', sha256: '' },
    { url: 'https://github.com/astral-sh/uv/releases/download/0.6.10/uv-x86_64-pc-windows-msvc.zip', sha256: '' },
  ]
  const ps = "$ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri $env:AB_URL -OutFile $env:AB_OUT -UseBasicParsing -TimeoutSec 300; if ($env:AB_SHA -and (Get-FileHash $env:AB_OUT -Algorithm SHA256).Hash.ToLower() -ne $env:AB_SHA) { throw 'sha256 mismatch' }; if (Test-Path $env:AB_TMP) { Remove-Item $env:AB_TMP -Recurse -Force }; Expand-Archive -LiteralPath $env:AB_OUT -DestinationPath $env:AB_TMP -Force; $e = Get-ChildItem $env:AB_TMP -Recurse -Filter uv.exe | Select-Object -First 1; Copy-Item $e.FullName $env:AB_DEST -Force; Remove-Item $env:AB_OUT; Remove-Item $env:AB_TMP -Recurse -Force"
  for (const src of UV_SOURCES) {
    const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeoutMs: 400000, env: { AB_URL: src.url, AB_OUT: zip, AB_TMP: tmp, AB_DEST: local, AB_SHA: src.sha256 || '' } })
    if (r.code === 0 && existsSync(local)) return local
    log?.info(`从 ${new URL(src.url).host} 下 uv 没成功，换一个源`)
  }
  return existsSync(local) ? local : ''
}

async function edgeSynth(text, voice, rate, pitch) {
  const file = join(outDir(), `${randomUUID()}.mp3`)

  const txt = join(outDir(), `${randomUUID()}.txt`)
  const { writeFileSync } = await import('node:fs')
  writeFileSync(txt, text, 'utf8')
  const args = ['-I', '-m', 'edge_tts', '--voice', voice, '--file', txt, '--write-media', file]
  if (rate && rate !== '+0%') args.push(`--rate=${rate}`)
  if (pitch && pitch !== '+0Hz') args.push(`--pitch=${pitch}`)
  const r = await run(pyExe(), args, { timeoutMs: 60000 })
  try { unlinkSync(txt) } catch (error) {}
  if (r.code !== 0 || !existsSync(file) || statSync(file).size < 500) {
    throw new Error('edge-tts 失败：' + (r.err || r.out).slice(-200))
  }
  return file
}

async function windowsSynth(text) {
  // Linux 兼容：Windows 语音引擎（System.Speech）只在 Windows 上有。
  if (process.platform !== 'win32') throw new Error('Windows 语音只支持 Windows 系统，请把 TTS 换成 edgetts 或自定义接口')
  const file = join(outDir(), `${randomUUID()}.wav`)
  const script =
    'Add-Type -AssemblyName System.Speech;' +
    '$t=[Console]::In.ReadToEnd();' +
    '$s=New-Object System.Speech.Synthesis.SpeechSynthesizer;' +
    "$zh=$s.GetInstalledVoices()|Where-Object{$_.VoiceInfo.Culture.Name -eq 'zh-CN'}|Select-Object -First 1;" +
    'if($zh){$s.SelectVoice($zh.VoiceInfo.Name)};' +
    `$s.SetOutputToWaveFile('${file.replace(/'/g, "''")}');$s.Speak($t);$s.Dispose()`
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[Console]::InputEncoding=[Text.Encoding]::UTF8;${script}`], { timeoutMs: 60000, input: text })
  if (!existsSync(file) || statSync(file).size < 1000) throw new Error('Windows 语音失败：' + r.err.slice(-200))
  return file
}

async function fetchAudio(url, init, timeoutMs = 120000) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  if (!r.ok) throw new Error(`HTTP ${r.status}：${(await r.text().catch(() => '')).slice(0, 120)}`)
  const buf = Buffer.from(await r.arrayBuffer())
  if (buf.length < 400) throw new Error('返回的音频太短：' + buf.toString('utf8').slice(0, 120))
  return buf
}

function saveAudio(buf, sampleRate) {
  const isWav = buf.toString('ascii', 0, 4) === 'RIFF'
  const isMp3 = buf.toString('ascii', 0, 3) === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)
  const isOgg = buf.toString('ascii', 0, 4) === 'OggS'
  let out = buf
  let ext = isWav ? 'wav' : isMp3 ? 'mp3' : isOgg ? 'ogg' : 'wav'

  if (!isWav && !isMp3 && !isOgg) out = buildWav(new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2)), sampleRate)
  const file = join(outDir(), `${randomUUID()}.${ext}`)
  writeFileSync(file, out)
  return file
}

async function cosyvoiceSynth(text, c) {
  const base = String(c.url || '').replace(/\/+$/, '')
  if (!base) throw new Error('没填 CosyVoice 地址')
  const instruct = c.mode === 'instruct' && c.instruct
  const form = new URLSearchParams({ tts_text: text, spk_id: c.spkId || '中文女' })
  if (instruct) form.set('instruct_text', c.instruct)
  const buf = await fetchAudio(`${base}/${instruct ? 'inference_instruct' : 'inference_sft'}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form })
  return saveAudio(buf, c.sampleRate || 22050)
}

async function gptsovitsSynth(text, c) {
  const base = String(c.url || '').replace(/\/+$/, '')
  if (!base) throw new Error('没填 GPT-SoVITS 地址')
  const q = new URLSearchParams({ text, text_lang: c.textLang || 'zh', ref_audio_path: c.refAudio || '', prompt_text: c.promptText || '', prompt_lang: c.promptLang || 'zh', media_type: 'wav' })
  return saveAudio(await fetchAudio(`${base}/tts?${q}`, { method: 'GET' }), 32000)
}

async function httpSynth(text, c) {
  const tpl = String(c.urlTemplate || '')
  if (!tpl.includes('{text}')) throw new Error('通用 TTS 地址里要有 {text}')
  return saveAudio(await fetchAudio(tpl.split('{text}').join(encodeURIComponent(text)), { method: 'GET' }), 24000)
}

async function openaiSynth(text, c) {
  const base = String(c.baseUrl || '').replace(/\/+$/, '')
  if (!base) throw new Error('没填 TTS 服务地址')
  const headers = { 'content-type': 'application/json' }
  if (c.apiKey) headers.authorization = `Bearer ${c.apiKey}`
  const buf = await fetchAudio(`${base}/audio/speech`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: c.ttsModel || 'tts-1', input: text, voice: c.ttsVoice || 'alloy', response_format: 'mp3' }),
  })
  return saveAudio(buf, 24000)
}

export const voiceConverters = []

export async function textToSpeech(text, opt = {}, log) {
  const clean = String(text || '').trim()
  if (!clean) throw new Error('没有要念的文字')
  let file = ''
  let engine = ''
  const provider = opt.provider || 'auto'
  const openaiCfg = { baseUrl: opt.ttsBaseUrl, apiKey: opt.ttsApiKey, ttsModel: opt.ttsModel, ttsVoice: opt.ttsVoice }

  const wantEngine = (opt.engine && opt.engine !== 'auto') ? opt.engine : (['cosyvoice', 'gptsovits', 'http'].includes(provider) ? provider : '')
  const local = { cosyvoice: cosyvoiceSynth, gptsovits: gptsovitsSynth, http: httpSynth }[wantEngine]
  if (local) {
    try {
      file = await local(clean, opt[wantEngine] || {})
      engine = wantEngine
    } catch (error) {
      log?.warn(`${wantEngine} 失败：${error.message}`)
    }
  }

  if (!file && (provider === 'openai' || provider === 'auto') && openaiCfg.baseUrl) {
    try {
      file = await openaiSynth(clean, openaiCfg)
      engine = 'openai'
    } catch (error) {
      log?.warn(`TTS 服务失败：${error.message}`)
    }
  }

  if (!file && (provider === 'edge' || provider === 'auto') && edgeInstalled()) {
    try {
      file = await edgeSynth(clean, opt.voice || 'zh-CN-XiaoyiNeural', opt.rate, opt.pitch)
      engine = 'edge'
    } catch (error) {
      log?.warn(error.message, '→ 改用 Windows 语音')
    }
  }

  if (!file) {
    file = await windowsSynth(clean)
    engine = 'windows'
  }
  for (const conv of voiceConverters) {
    try {
      file = await conv(file)
    } catch (error) {
      log?.warn('变声失败，用原声：', error.message)
    }
  }
  return { file, engine }
}

function pickStt(x) {
  if (!x) return null
  if (typeof x.resolve === 'function' && typeof x.transcribe === 'function') return x
  const s = x.speechToText
  if (s && typeof s.resolve === 'function' && typeof s.transcribe === 'function') return s
  return null
}

// SenseVoice 只吃 16k 单声道 PCM16 WAV，所以先转格式，再交给宿主识别。
export function asrReady(opt = {}, dsh) {
  return Boolean(pickStt(dsh))
}

async function prepareStt(stt, log) {
  if (typeof stt.prepare !== 'function') return
  try {
    const snap = stt.snapshot ? stt.snapshot() : null
    const pid = snap?.default?.id || snap?.providerId || snap?.default?.providerId || snap?.providers?.[0]?.id
    if (!pid) return
    const task = stt.prepare(pid, {})
    if (task && typeof task.then === 'function') {
      await Promise.race([task, new Promise((r) => setTimeout(r, 60000))])
    }
  } catch (error) {
    log?.debug?.('识别器准备没成功（继续直接试一次）：' + error.message)
  }
}

export async function transcribe(buf, mime, opt = {}, log, dsh) {
  if (!buf?.length) throw new Error('没有音频')
  const stt = pickStt(dsh)
  if (!stt) throw new Error('这个环境没有语音识别（要在 DSH 桌面版里用）')
  const wav16 = toMono16k(buf, 16000)
  const run = async () => {
    const spec = stt.resolve({ audio: wav16, ...(opt.asrLanguage ? { language: opt.asrLanguage } : {}) })
    const r = await stt.transcribe(spec, AbortSignal.timeout(180000))
    return String(typeof r === 'string' ? r : r?.text || r?.transcript || '').trim()
  }
  let out = ''
  try {
    out = await run()
  } catch (error) {

    log?.info?.('识别器还没就绪，先准备一下：' + error.message)
    await prepareStt(stt, log)
    out = await run()
  }
  if (!out) throw new Error('没听清（识别结果为空）')
  log?.info(`语音转文字（SenseVoice）：${out.slice(0, 40)}`)
  return out
}
