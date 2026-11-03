# AuraLife 自定义接入 TTS / STT / 生图

AuraLife 的语音合成（TTS）、语音识别（STT）、生图三项能力支持「自定义接口」档：接你自己电脑上的模型或服务（GPT-SoVITS、SD WebUI、ComfyUI、FunASR、faster-whisper、各类 OpenAI 兼容服务……）。

## 工作原理

每个能力对应一个脚本文件，放在数据目录的 `local/` 文件夹里：

| 文件 | 接管什么 | 什么时候被调用 |
|---|---|---|
| `local/tts.mjs` | 语音合成（Ta 发的语音条） | Ta 发语音，且 TTS 引擎选的是「自定义接口」 |
| `local/image.mjs` | 生图 | Ta 调用画图工具，且生图引擎选的是「自定义接口」 |
| `local/asr.mjs` | 语音条转文字 | 收到别人发来的语音条，且 STT 引擎选的是「自定义接口」 |

- 数据目录：Windows 在 `C:\Users\<你>\.dsh\plugins-data\auralife\local\`。
- 在设置页「语音合成 / 语音识别 / 生图」把引擎选成「自定义接口」即生效（对应 `config.local.{tts,image,asr}` 置 true）。
- 脚本不存在时，插件会自动把模板复制过去；插件升级不会动你的 `local/` 文件夹。
- 脚本改完保存即生效，不用重启 DSH。

## 写法约定

- Node.js 的 ES 模块（`.mjs`），默认导出：`export default async function (参数) { ... }`。
- 可以用 Node 自带的一切：`fetch`、`node:fs`、`node:child_process`（起你的 Python 项目）。**不能 npm install 第三方包**（脚本是运行时动态加载的）。
- 出错就 `throw new Error('原因')`：TTS 失败退回文字、STT 失败提示没听清、生图失败 Ta 会告诉对方没成功和原因。
- 用参数里的 `log.info()` / `log.warn()` 打日志，会出现在面板「日志」页。
- 超时：TTS 60 秒、STT 60 秒、生图 5 分钟。

## 脚本契约

### tts.mjs — 文字转语音

```js
// 参数：{ text, outDir, log }
// 返回：音频文件路径（wav / mp3 / silk），或 { file }
export default async function ({ text, outDir, log }) {
  const res = await fetch('http://127.0.0.1:9880/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, ref_wav_path: 'D:/voices/ref.wav', language: 'zh' }),
  })
  if (!res.ok) throw new Error('语音服务返回 ' + res.status)
  const buf = Buffer.from(await res.arrayBuffer())
  const file = outDir + '/tts-' + Date.now() + '.wav'
  await writeFile(file, buf)
  return file
}
```

### image.mjs — 文字生图

```js
// 参数：{ prompt, size, outDir, log }（size 形如 "1024x1024"，prompt 已带上面板里的固定风格）
// 返回：图片 Buffer，或 { buffer } / { file } / { base64 } / { url }
export default async function ({ prompt, size, outDir, log }) {
  const res = await fetch('http://127.0.0.1:7860/sdapi/v1/txt2img', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, width: 1024, height: 1024, steps: 24 }),
  })
  if (!res.ok) throw new Error('生图服务返回 ' + res.status)
  const j = await res.json()
  return { base64: j.images?.[0] || '' }
}
```

### asr.mjs — 语音转文字

```js
// 参数：{ file, log }（file 是 16kHz 单声道 wav）
// 返回：识别出的文字，或 { text }；听不清返回空字符串
export default async function ({ file, log }) {
  const body = await readFile(file)
  const res = await fetch('http://127.0.0.1:8000/transcribe', { method: 'POST', body })
  if (!res.ok) throw new Error('识别服务返回 ' + res.status)
  const j = await res.json()
  return { text: j.text || '' }
}
```

## 常见服务示例

| 能力 | 服务 | 地址 |
|---|---|---|
| TTS | GPT-SoVITS | `http://127.0.0.1:9880`（参考音频路径写进脚本） |
| TTS | CosyVoice 2 | `http://127.0.0.1:50000` |
| 生图 | SD WebUI | `http://127.0.0.1:7860/sdapi/v1/txt2img` |
| 生图 | ComfyUI | `http://127.0.0.1:8188`（走它的 workflow API） |
| 生图 | 任意 OpenAI 兼容图像接口 | 自填 endpoint + key |
| STT | FunASR | `http://127.0.0.1:8000` |
| STT | faster-whisper | 自建 HTTP 包装后接入 |

## 让 DSH 帮你改

在面板对应模块页选「自定义接口」后，把下面这段话粘给 DSH，再补一句你用的是什么服务、地址和关键参数，它会读这份说明、帮你把脚本改好：

> 帮我把 AuraLife 的自定义接口脚本改一下，接到我的 <服务名> 上，服务地址 <地址>，<关键参数>。脚本在数据目录的 local 文件夹里，契约见 Interface.md。
