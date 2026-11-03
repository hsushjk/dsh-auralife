// 自定义接口 · 语音识别（STT / ASR）
// 在「设置 → 语音识别」把引擎选成「自定义」后，别人发来的语音条都会先送这里转文字。
// 写法约定见 Interface.md；改完保存即生效，不用重启 DSH。
//
// 入参：{ file, log }
//   file 语音条已转好的 wav 文件路径（16kHz、单声道、PCM16）
// 返回：识别出的文字（字符串），或 { text }；没听清就返回空字符串
// 失败：直接 throw，插件会退回 DSH 自带的识别。

import { readFileSync } from 'node:fs'

// ↓↓↓ 示例：一个接收 wav 文件、返回 {"text": "..."} 的本地 HTTP 服务
//（FunASR / faster-whisper / sherpa-onnx 之类包一层 HTTP 就行，地址换成你的）
const SERVER = 'http://127.0.0.1:8000/asr'

export default async function asr({ file }) {
  const form = new FormData()
  form.append('file', new Blob([readFileSync(file)], { type: 'audio/wav' }), 'voice.wav')
  const resp = await fetch(SERVER, { method: 'POST', body: form, signal: AbortSignal.timeout(60000) })
  if (!resp.ok) throw new Error(`识别服务返回 ${resp.status}`)
  const json = await resp.json()
  return String((json && json.text) || '').trim()
}
