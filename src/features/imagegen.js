import { fetchImage } from '../core/net.js'

const TIMEOUT = 240000

function styleOf(c, prompt) {
  return [c.stylePrompt, prompt].filter(Boolean).join('，')
}

async function viaOpenAI(c, prompt, log) {
  const base = String(c.baseUrl || '').replace(/\/+$/, '')
  if (!base || !c.model) throw new Error('还没填生图服务地址或模型')
  const headers = { 'content-type': 'application/json' }
  if (c.apiKey) headers.authorization = `Bearer ${c.apiKey}`
  const r = await fetch(`${base}/images/generations`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: c.model, prompt: styleOf(c, prompt), size: c.size, n: 1, response_format: 'b64_json', image_size: c.size }),
    signal: AbortSignal.timeout(TIMEOUT),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j?.error?.message || j?.message || `HTTP ${r.status}`)
  const item = (j.data || j.images || [])[0] || {}
  if (item.b64_json) return Buffer.from(item.b64_json, 'base64')
  if (item.url) return await fetchImage(item.url, { maxBytes: 20 * 1024 * 1024, allowLocal: false })
  throw new Error('生图服务没有返回图片')
}

async function viaSdWebUI(c, prompt) {
  const base = String(c.baseUrl || 'http://127.0.0.1:7860').replace(/\/+$/, '')
  const [w, h] = String(c.size || '512x512').split('x').map((n) => parseInt(n, 10) || 512)
  const r = await fetch(`${base}/sdapi/v1/txt2img`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(c.apiKey ? { authorization: `Bearer ${c.apiKey}` } : {}) },
    body: JSON.stringify({
      prompt: styleOf(c, prompt),
      negative_prompt: c.negativePrompt || '',
      steps: c.steps, cfg_scale: c.cfgScale, sampler_name: c.sampler,
      width: w, height: h, batch_size: 1, n_iter: 1,
    }),
    signal: AbortSignal.timeout(TIMEOUT),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j?.error || j?.detail || `HTTP ${r.status}`)
  const b64 = (j.images || [])[0]
  if (!b64) throw new Error('SD WebUI 没有返回图片')
  return Buffer.from(String(b64).replace(/^data:image\/\w+;base64,/, ''), 'base64')
}

async function viaComfyUI(c, prompt, log) {
  const base = String(c.baseUrl || 'http://127.0.0.1:8188').replace(/\/+$/, '')
  const ckpt = c.model || 'v1-5-pruned-emaonly.safetensors'
  const [w, h] = String(c.size || '512x512').split('x').map((n) => parseInt(n, 10) || 512)
  const workflow = {
    3: { class_type: 'KSampler', inputs: { seed: Math.floor(Math.random() * 1e12), steps: c.steps, cfg: c.cfgScale, sampler_name: c.sampler, scheduler: 'normal', denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] } },
    4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: ckpt } },
    5: { class_type: 'EmptyLatentImage', inputs: { width: w, height: h, batch_size: 1 } },
    6: { class_type: 'CLIPTextEncode', inputs: { text: styleOf(c, prompt), clip: ['4', 1] } },
    7: { class_type: 'CLIPTextEncode', inputs: { text: c.negativePrompt || '', clip: ['4', 1] } },
    8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    9: { class_type: 'SaveImage', inputs: { filename_prefix: 'auralife', images: ['8', 0] } },
  }
  const r = await fetch(`${base}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(c.apiKey ? { authorization: `Bearer ${c.apiKey}` } : {}) },
    body: JSON.stringify({ prompt: workflow }),
    signal: AbortSignal.timeout(30000),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok || !j.prompt_id) throw new Error(j?.error || `提交工作流失败 HTTP ${r.status}`)
  const id = j.prompt_id
  const until = Date.now() + TIMEOUT
  while (Date.now() < until) {
    await new Promise((s) => setTimeout(s, 1500))
    const h2 = await fetch(`${base}/history/${id}`, { signal: AbortSignal.timeout(15000) })
    const hj = await h2.json().catch(() => ({}))
    const entry = hj?.[id]
    if (!entry) continue
    const outs = entry.outputs || {}
    for (const k of Object.keys(outs)) {
      const img = (outs[k].images || [])[0]
      if (img?.filename) {
        const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder || '', type: img.type || 'output' })
        const vr = await fetch(`${base}/view?${q}`, { signal: AbortSignal.timeout(60000) })
        if (!vr.ok) throw new Error(`取图失败 HTTP ${vr.status}`)
        return Buffer.from(await vr.arrayBuffer())
      }
    }
  }
  throw new Error('ComfyUI 画太久没出图')
}

export function createImageGen({ getConfig, log, local }) {
  const cfg = () => getConfig().imageGen

  const enabled = () => {
    const c = cfg()
    if (local?.active('image')) return true
    if (!c.enabled) return false
    if (c.provider === 'code') return true
    return Boolean(c.baseUrl)
  }

  async function generate(prompt) {
    const c = cfg()
    if (local?.active('image')) {
      const { toImageBuffer } = await import('../local/local.js')
      const t = Date.now()
      const buf = await toImageBuffer(await local.call('image', { prompt: styleOf(c, prompt), size: c.size }))
      log.info(`本地画好了一张图（${Math.round(buf.length / 1024)}KB，${Math.round((Date.now() - t) / 1000)}s）：${prompt.slice(0, 40)}`)
      return buf
    }
    if (!c.enabled) throw new Error('生图还没开启')
    const t = Date.now()
    let buf
    if (c.provider === 'sdwebui') buf = await viaSdWebUI(c, prompt)
    else if (c.provider === 'comfyui') buf = await viaComfyUI(c, prompt, log)
    else if (c.provider === 'code') throw new Error('代码画图由模型自己调用工具完成，这里不生成')
    else buf = await viaOpenAI(c, prompt, log)
    log.info(`画好了一张图（${Math.round(buf.length / 1024)}KB，${Math.round((Date.now() - t) / 1000)}s）：${prompt.slice(0, 40)}`)
    return buf
  }

  return { generate, enabled }
}
