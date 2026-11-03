# AuraLife 自定义接口

这个文件夹里的脚本可以接管 AuraLife 的三项能力（语音合成 / 语音识别 / 生图），换成你电脑上自己的模型或服务。
插件升级不会动这个文件夹。脚本改完保存就生效，不用重启 DSH。

| 文件 | 接管什么 | 什么时候用 |
|---|---|---|
| `tts.mjs` | 语音合成（Ta 发的语音条） | 每次 Ta 要发语音，且 TTS 选的是「自定义」 |
| `image.mjs` | 生图 | 她调用画图工具，且生图选的是「自定义」 |
| `asr.mjs` | 别人发来的语音条转文字 | 收到语音条，且 STT 选的是「自定义」 |

在面板对应模块页（TTS / STT / 生图）把引擎选成「自定义」才会用；文件不存在时，会自动把模板放过来。

## 写法约定

- 是 Node.js 的 ES 模块（`.mjs`），`export default async function (参数) { ... }`。
- 可以用 Node 自带的一切：`fetch`、`node:fs`、`node:child_process`（调你的 Python 项目）……不能 `npm install` 第三方包。
- 出错就 `throw new Error('原因')`：语音、识别会退回内置方式；生图会让她告诉对方没成功和原因。
- 用参数里的 `log.info()` / `log.warn()` 打日志，会出现在面板「日志」页。
- 超时：语音 60 秒、识别 60 秒、生图 5 分钟。

## 各脚本的参数和返回值

### tts.mjs
- 参数：`{ text, outDir, log }`
- 返回：音频文件路径（wav / mp3 / silk），或 `{ file }`

### image.mjs
- 参数：`{ prompt, size, outDir, log }`（`size` 形如 `"1024x1024"`，`prompt` 已带上面板里的固定风格）
- 返回：图片 `Buffer`，或 `{ buffer }` / `{ file }` / `{ base64 }` / `{ url }`

### asr.mjs
- 参数：`{ file, log }`（`file` 是 16kHz 单声道 wav）
- 返回：识别出的文字，或 `{ text }`；听不清返回空字符串

## 让 DSH 帮你改

在面板对应模块页点「复制给 DSH 的话」，粘给 DSH，再补一句你用的是什么服务、地址和关键参数，它会读这份说明、帮你把脚本改好。
