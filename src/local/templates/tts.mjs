// 自定义接口 · 语音合成（TTS）
// 在「设置 → 语音合成」把引擎选成「自定义」后，Ta 每次要发语音就会调这里。
// 写法约定见 Interface.md；改完保存即生效，不用重启 DSH。
//
// 入参：{ text, outDir, log }
//   text   要念出来的话
//   outDir 这个文件夹可以随便放中间产物
//   log    log.info(...) / log.warn(...) 会显示在面板「日志」里
// 返回：音频文件路径（wav / mp3 都行），或 { file: 路径 }
// 失败：直接 throw，插件会退回内置语音并告诉 Ta 没念成。

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

// ↓↓↓ 示例：GPT-SoVITS 的 API v2（在 GPT-SoVITS 目录运行 python api_v2.py，默认 http://127.0.0.1:9880）。
// 换成你自己的服务地址；参考音频、参考文本也换成你的。
const SERVER = 'http://127.0.0.1:9880/tts'
const VOICE_REF_WAV = 'D:/voices/ref.wav'
const VOICE_REF_TEXT = '参考音频里说的那句话'

export default async function tts({ text, outDir, log }) {
  const query = new URLSearchParams({
    text,
    text_lang: 'zh',
    ref_audio_path: VOICE_REF_WAV,
    prompt_text: VOICE_REF_TEXT,
    prompt_lang: 'zh',
    media_type: 'wav',
  })
  const resp = await fetch(`${SERVER}?${query}`, { signal: AbortSignal.timeout(60000) })
  if (!resp.ok) {
    const detail = (await resp.text()).slice(0, 200)
    throw new Error(`TTS 服务返回 ${resp.status}：${detail}`)
  }
  const target = join(outDir, `tts-${Date.now()}.wav`)
  writeFileSync(target, Buffer.from(await resp.arrayBuffer()))
  log.info(`自定义 TTS 念好了：${text.slice(0, 20)}`)
  return target
}
