// 自定义接口 · 生图（Image）
// 在「设置 → 生图」把引擎选成「自定义」后，Ta 每次画图都会调这里。
// 写法约定见 Interface.md；改完保存即生效，不用重启 DSH。
//
// 入参：{ prompt, size, outDir, log }
//   prompt 要画的内容（已包含设置里的固定风格）
//   size   想要的尺寸，如 "1024x1024"
// 返回：图片 Buffer，或 { buffer } / { file: 路径 } / { base64 } / { url } 任一
// 失败：直接 throw，Ta 会被告知没画成。

// ↓↓↓ 示例：Stable Diffusion WebUI / Forge 的 HTTP API（启动参数带 --api，默认 http://127.0.0.1:7860）。
// 用 ComfyUI、其它画图服务同理：POST 自己的接口，把结果转成上面四种返回之一。
const SERVER = 'http://127.0.0.1:7860/sdapi/v1/txt2img'

export default async function image({ prompt, size, log }) {
  const [w, h] = String(size || '1024x1024').split('x').map(Number)
  const payload = {
    prompt,
    negative_prompt: 'lowres, bad anatomy, text, watermark',
    width: w,
    height: h,
    steps: 25,
    cfg_scale: 6,
  }
  const resp = await fetch(SERVER, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(300000),
  })
  if (!resp.ok) {
    const detail = (await resp.text()).slice(0, 200)
    throw new Error(`生图服务返回 ${resp.status}：${detail}`)
  }
  const json = await resp.json()
  const imageB64 = json && json.images && json.images[0]
  if (!imageB64) throw new Error('生图服务没返回图片')
  log.info(`自定义生图画好了：${prompt.slice(0, 30)}`)
  return { base64: imageB64 }
}
