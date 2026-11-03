# AuraLife 客户端开发文档

给要写 AuraLife 客户端（Android / Windows / 任何能发 HTTP 的程序）的开发者。本文只讲**客户端怎么连 AuraLife**；自定义接入 TTS/STT/生图见 Interface.md，项目与二次开发见 README.md / DEV.md。

## 连接方式（两种入口）

| 入口 | 基址 | 说明 |
|---|---|---|
| 插件固定端口 | `http://<主机>:2332/` | 默认绑 `0.0.0.0`，端口可在设置改。**基址就是根，不要加 `/auralife` 前缀**——固定端口服务器会 404 拒绝该前缀 |
| DSH 网关 | `http://<DSH>:<端口>/auralife/api/*` | DSH 侧栏嵌入页同源路径，只代理 API |

- 固定入口根路径 `GET /api/state` 免登录，可探活。
- 探活拿到 `enabled`、`needSetup`、`siteName`、`version` 后，未初始化则引导用户先在网页/DSH 里走完向导。

## 鉴权

- 登录：`POST /api/login`，body `{ username, password }` → `{ ok:true, token, subject, role, name }`（扁平，没有 me 嵌套）。
- 之后每个请求带 **`Authorization: Bearer <token>`**；也支持 URL `?token=`（媒体、SSE 常要用，注意 token 会进代理日志，能带头就带头）。
- **鉴权失败默认返回 HTTP 200**，body 是 `{ ok:false, reason:'没登录' }`（个别接口用 `message` 字段）——**客户端一律先判 `body.ok`，再看状态码**。例外：`/api/stream` 与 `/api/media/*` 鉴权失败是 **HTTP 401**（body 同样 `{ok:false,reason:'没登录'}`）。
- token 固定 30 天、无滑动续期、登录响应没有过期时间：客户端本地记登录时刻，收到「没登录」就静默重登。多设备登录互不踢；改密码不吊销旧 token。
- 权限三级：**公开**（/api/state、/api/models）→ **登录**（消息收发）→ **主人专属**（life/modules/organs/memory/wishes/self/config/debug/logs/diary 写/stickers 写/avatar/background/personas/guests——客人账号调用会得到 `{ok:false,reason:'只有主人能这么做'}`）。

## 核心流程

### 1. 握手：`GET /api/state`（公开）

返回 `{ ok, needSetup, enabled, me:{subject,role,name,level}|null, botName, title, siteName, version, ownerName, persona, theme }`。
`me.role` 为 `owner` 或 `social`（客人）——客户端用它决定显示哪些入口。**项目无 API 版本化，请按 `version` 字段做兼容分支**。

### 2. 收历史：`GET /api/messages`

两种模式（响应形状不同）：

- **按条数**（老参数，稳定）：`?before=<时间戳>&limit=<1-100>`。返回 `{ ok, messages:[...], hasMore }`，消息**升序**；`before` 含边界（`t <= before`）。
- **按整片**（网页同款，推荐）：`?file=last` 取最新一片 → `{ ok, file:{ index, total, id, limit }, messages:[...] }`；往上翻 `?file=prev&before=<本片最早消息 t>`。
- 参数 `chat` 会被忽略（每个账号只有自己的会话）。
- 同毫秒边界消息会跨页重复——**客户端必须按 `(t, id)` 双键去重合并**。

消息形状：`{ id, t, who:'user'|'bot', uid, text, kind, mediaId?, mediaMime?, fileName?, bytes?, ... }`。**没有昵称字段**（who/uid 而已）；客人名单 `api/guests` 只有主人能拉，多用户客户端要自己维护 uid→昵称映射。

### 3. 发消息：`POST /api/messages`

body（全部可选，但至少要有一个）：

```json
{
  "text": "文字",
  "images": [{ "data": "data:image/png;base64,..." }],
  "voice": { "data": "data:audio/webm;base64,...", "dur": 3 },
  "files": [{ "name": "note.txt", "mime": "text/plain", "data": "data:...;base64,..." }]
}
```

- 返回只有 `{ ok:true }`——**不回显消息 id/时间**，SSE 断开时以 SSE 收到为准（见下）。
- 限制：voice.dur 越界被静默钳到 1..60；files 单条 base64 ≥30M 字符会被**静默丢弃**（响应仍是 ok:true）；服务端请求体上限 32MB。
- 输入中状态：`POST /api/typing` body `{ typing:true|false }`。
- 语音单独传：`POST /api/voice`（dur 越界这里会**报错**而不是钳制）。

### 4. 实时：`GET /api/stream`（SSE）

- 只认 `?token=`（不能用 Bearer 头）。
- 25 秒一次心跳注释行 `: ping`。
- **服务端不写 `event:`/`id:`/`retry:` 字段**：浏览器 EventSource 默认 3s 重连可用；原生客户端（OkHttp/URLSession）**必须自建重连 + 指数退避**，且用 `onmessage`（不是 `addEventListener('message')`）读 `e.data`。
- 每个事件是一行 JSON，按 `type` 分派：

| type | payload | 客户端动作 |
|---|---|---|
| `message` | `{type, chatId, message}` | 收到同 `message.id` 就按 id 覆盖，不要追加（语音转写完成会重发同 id 一次，带 `heard` 字段） |
| `typing` | `{type, chatId, on}` | 显示「正在输入…」 |
| `rotate` | `{type, chatId, at, tokens, window, ratio, priorSessionId, priorSessionTitle, archiveDir}` | 上下文轮换了：清空本地消息缓存，提示「聊天已归档、开新会话」 |
| `history` | `{type, chatId, oldestAt, droppedBefore, hasMore}` | 有旧消息被清理：丢弃 `t < droppedBefore` 的气泡 |
| `nudge` | 打扰 `{chatId, at, reason, wish, urge}`；闹钟 `{chatId, at, reason:'alarm', alarm}` | 系统通知（她主动找你 / 她给自己设的闹钟响了） |
| `azone` | `{type, reason:'reply', entryId}` | 空间有人回复日记——**广播给所有连接（无 chatId）**，客户端自行判断是否相关 |

- **断线补拉**：漏掉的事件没有 replay，重连后 `GET /api/messages?before=<本地最后一条 t>` 补齐，按 `(t,id)` 去重。

### 5. 媒体：`GET /api/media/<mediaId>`

- 支持 `?token=` 兜底；带 ETag + `immutable` 强缓存（304）。
- **404 = 过期**（聊天记录保留天数到了就删）：客户端必须降级渲染占位（图片碎掉/语音不可听），不能依赖缓存头。

## 端点速查表

| 端点 | 权限 | 说明 |
|---|---|---|
| GET /api/state | 公开 | 握手/探活 |
| GET /api/models | 公开 | DSH 模型列表 |
| POST /api/login · /api/logout · /api/setup | 公开 | 登录/登出/初始化（setup 只在未初始化时可调） |
| GET/POST /api/messages · /api/typing · /api/voice | 登录 | 收发 |
| GET /api/stream | 登录（401） | SSE |
| GET /api/media/<id> | 登录（401） | 媒体文件 |
| GET /api/diary | 登录 | 空间记录/留言（读） |
| POST /api/diary* | 主人 | 空间写/留言/删除 |
| GET /api/stickers* | 登录 | 表情库（读） |
| POST /api/stickers* | 主人 | 表情库（写） |
| POST /api/avatar · /api/background | 主人 | 头像/背景（上传）；GET /api/avatar、/api/background、/api/icon 免登录 |
| GET /api/life | 主人 | 生命总览快照 |
| GET /api/modules | 主人 | 模块广播 |
| GET /api/organs · GET/POST /api/organs/settings | 主人 | 器官清单与设置（settings 要带 `?org=`/body `{org}`） |
| GET /api/memory · POST /api/memory/consolidate · GET /api/memory/self | 主人 | 记忆（只读 + 整理 + 自我认知） |
| GET/POST /api/wishes · /api/self | 主人 | 执念/自我（POST 判别字段是 `resolve`/`reset`，不是 `action`） |
| GET/PATCH /api/config | 主人 | 设置（**PATCH 是嵌套对象深合并**：`{"voice":{"enabled":false}}`，不是点路径字符串） |
| GET /api/logs · /api/status · POST /api/logs/clear | 主人 | 日志/状态/清日志（status 含 version/platform/host/asr） |
| POST /api/test · /api/debug | 主人 | 测试/调试（破坏性，客户端不要暴露） |
| GET/POST /api/personas* · /api/guests* · /api/account · /api/password | 主人 | 人设/客人/账号/改密码 |
| GET /api/voice/edge · POST /api/voice/edge · POST /api/voice/test | 主人 | edgetts 状态/安装/试听 |

**器官设置**：`GET /api/organs/settings?org=<id>` 读、`POST /api/organs/settings` body `{ org, values }` 写——只在带 org 时可用，不带会报「没有这个器官」。

## 最小示例（Node 18+，零依赖）

```js
const BASE = 'http://127.0.0.1:2332'

// 1. 登录
const login = await fetch(BASE + '/api/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: '主人', password: '你的密码' }),
}).then((r) => r.json())
if (!login.ok) throw new Error(login.reason || login.message)
const token = login.token

// 2. 拉最新一片历史
const hist = await fetch(BASE + '/api/messages?file=last', { headers: { Authorization: 'Bearer ' + token } }).then((r) => r.json())
console.log('history:', hist.messages?.length, 'messages')

// 3. 发一条
const sent = await fetch(BASE + '/api/messages', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
  body: JSON.stringify({ text: '你好' }),
}).then((r) => r.json())
console.log('sent:', sent.ok)

// 4. 订阅 SSE（原生 EventSource 示例；注意用 onmessage 而不是 addEventListener('message')）
import { EventSource } from 'node:eventsource' // 或任何 SSE 客户端
const es = new EventSource(BASE + '/api/stream?token=' + token)
es.onmessage = (e) => {
  const ev = JSON.parse(e.data)
  if (ev.type === 'message') console.log('new message:', ev.message.text)
  if (ev.type === 'nudge') console.log('she nudges:', ev.reason)
  if (ev.type === 'rotate') { console.log('context rotated, refetch history'); /* 清缓存重拉 */ }
}
```

## 避坑清单

1. 直连基址**不带** `/auralife` 前缀。
2. 鉴权失败**默认 200 + ok:false**（错误字段 `reason` 为主、个别是 `message`）；`/api/stream` 与 `/api/media/*` 是 **401**。
3. SSE 用 `onmessage`；无 event:/id:/retry:；断线自建重连 + `before` 补拉。
4. `GET /api/messages` 的 `chat` 参数被忽略；两种分页模式形状不同；升序；`(t,id)` 去重。
5. `POST /api/messages` 不回显；大文件静默丢；voice dur 静默钳制。
6. token 无 expiresAt、固定 30 天；`?token=` 会进日志，优先 Bearer。
7. 媒体 404=已过期；azone 事件是广播；nudge 有两种 reason。
8. PATCH /api/config 用嵌套对象；POST /api/wishes 用 `resolve` 字段。
9. 无 API 版本化，按 `/api/state` 的 `version` 做兼容分支。
10. `/api/organs/settings` 必须带 org（`?org=` 或 body `{org}`）。
