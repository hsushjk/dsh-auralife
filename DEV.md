# DEV.md — 二次开发指南

给想改、想移植、想接 AuraLife 的开发者。项目定位一句话：**两个 core——bridge（人机交互桥梁）与 life（机 = 生命 + 记忆）**；纯 ESM、零运行时依赖、Node ≥ 18。

## 架构总览

```
dsh-auralife/
├── src/
│   ├── host.js            插件入口（DSH 侧）：注册、依赖装配、系统提示词、定时器、网页挂载
│   ├── chat/              会话层
│   │   ├── access.js      权限分级（主人 / 客人）
│   │   ├── hub.js         消息落库、连发合并、回复投递、语音/表情/文件、上下文轮换
│   │   └── reply.js       一轮模型回复拆多条、过滤旁白占位
│   ├── core/              基础设施
│   │   ├── config.js      配置默认值 + normalize 逐字段校验（唯一入口）
│   │   ├── store.js       dataDir / readJson / writeJson（原子写）
│   │   ├── logger.js      内存环形日志
│   │   ├── llm.js         内部小任务的单次模型调用（判断/抽取，动态 import 避循环）
│   │   ├── modules.js     模块清单（17 个）与 moduleEnabled 四开关
│   │   ├── time.js / net.js / image.js / redact.js / version.js
│   ├── life/              生命（一条命，state.json 是唯一真相）
│   │   ├── state.js       createLife：load/save + 各子域读写（identity/setIdentity/setRhythm/wishes 底层）
│   │   ├── chemistry.js   三激素：基线+半衰期 decayToward、事件驱动、昼夜节律、慢变量积分
│   │   ├── energy.js      体力：请求消耗 0.8/次、醒 0.8/分、睡 1.6/分恢复（纯作息）
│   │   ├── wishes.js      执念池：add/resolve/top（张力排序）
│   │   ├── drive.js       主动搭话：AI 自评 assessUrge（{awake,urge,topic}）→ urge≥55 开口；fireAlarm 闹钟链路
│   │   ├── self.js        自我演化三层 traits/values/boundaries（merge 同 label 取 max conf）
│   │   ├── alarm.js       闹钟：setAlarm（同 at 去重）/fireDue/cancel/list
│   │   └── gap.js         缺口检测（CANNOT_RE / CLAIM_RE）
│   ├── memory/            记忆 v2（append-only）
│   │   ├── store.js       createMemStore：facts/episodes/edges 按月 JSONL；同 id last-wins；supersede 链；clear(kind)
│   │   ├── similar.js     bigram Jaccard、DEDUP_THRESHOLD 0.85、isNegation/sameEntity/isHardFact
│   │   ├── encode.js      segment（30min 间隙/10 轮切事件）→ LLM 抽事实（op add/update/outdated）→ moodIn/moodOut 记 null（schema 保留）
│   │   ├── recall.js      线索包→BM25（recallability=exp(-days/tau)）→冷门补位→锚点重排→MMR→3000 字预算；attentionMultiplier(cortisol,archived) 40-80 线性
│   │   ├── receipt.js     写完读回三态
│   │   ├── replay.js      每天一次：buildEdges（Jaccard>0.15）→forget（<0.05；archived 走 BRAND_TAU_DAYS=365）→auditFacts→extractSelf
│   │   ├── assess.js      auditFacts：3 天未动且 conf∈[0.3,0.8) 的事实给 LLM 判 outdated→墓碑
│   │   ├── migrate.js     旧 memories.json 迁移
│   │   └── v2.js          门面 createMemoryV2：contextFor/tick/consolidate/remember/revise/forget/recall/stats
│   ├── organs/            器官宿主 + 自举
│   │   ├── organ-host.js  10 内置器官清单、loadSelfMade、apiFor 白名单、tickAll 熔断、refreshIfChanged 多进程同步、toolDefs
│   │   ├── organ-guard.js 静态白名单（危险 API + import + 死循环词表）
│   │   └── organ-bootstrap.js  缺口→LLM 生成→四重闸→落盘即 active（全 AI 托管）
│   ├── persona/personas.js  人设读/建/改/删 + 系统提示词组装（含画图/工具提示）
│   ├── voice/
│   │   ├── tts.js         TTS 引擎链（edge/win/custom 本地脚本）+ transcribe（dsh/custom 两路）+ Linux 兼容分支
│   │   └── wav.js         toMono16k（16k 单声道 WAV）
│   ├── tools/tools.js     web_* 模型工具（remember/recall/wishes/identity/model/rhythm/hormone/alarm/diary/organ/avatar/draw/sticker…），full 级隔离
│   ├── local/             local.js（自定义接口三槽 tts/image/asr）+ templates/（模板脚本 + Interface.md）
│   └── web/               server.js（静态+SSE+固定端口）、router.js、auth.js、routes/（session/chat/azone/media/memory/voice/debug/settings）
├── public/                单页前端：index.html（向导）、app.js（视图+设置）、app.css、js/（format/theme/sound/audio/views/life/logs）
├── client/client.js       DSH 客户端侧入口
├── personas/             出厂人设种子
├── Interface.md          自定义接入文档（三槽契约）
└── clientdev.md          客户端开发文档（HTTP API / SSE / 踩坑清单）
```

## 核心概念

### 两个 core

- **bridge**：人机交互桥梁——会话、鉴权、网页、语音、表情、文件、SSE 推送。全固化（UI 写死）。
- **life**：机——生命（state.json 一条命）+ 记忆（mem/ append-only）。**用户不能干预生命和记忆**：无阈值/范围/定时设置；调试只能走 /api/debug 破坏性接口。

### 模块 ≠ 插件

17 个模块（bridge 7：chat/web/tts/stt/imagegen/stickers/sound；life 10：chemistry/energy/wishes/memory/self/drive/alarm/azone/azoneSocial/organs）。除「器官」外全部固化；**器官是唯一全插件**——清单/工具/设置表单都按 /api/organs 的器官声明动态加载。开关只有四个：TTS/STT/生图/提示音（moduleEnabled 只判这四项，其余恒开）。

### 记忆数据模型

- `mem/facts/YYYY-MM.jsonl`：`{id,t0,text,subj,aboutName,src,conf,ev,supersedes,archived,hits,hitDays,lastHit,invalidAt}`；同 id **最后一行 wins**（bumpHit 追加同 id 新行，内容字段 immutable）；supersede 建新 id、t0 继承。
- `mem/episodes/`：`{id,t0,t1,chatId,people,moodIn,moodOut,raw:{fromId,toId},summary,salience,…}`（moodIn/Out 现恒 null）。
- `mem/edges/`：`{id,a,b,kind,w,why,at}`。
- `mem/watermark.json`：每会话已编码水位（消息 t）。
- `mem/runs.json`：`{lastConsolidate:{at,added,episodes,receipt}, lastReplay:{day,at,edges,forgotten}}`。

### 生命周期（host.js 的定时器）

- 60s 心跳 ×N：记忆 tick（consolidate 30min 节流增量 + replay 每天一次 3 点后）、内分泌衰减、体力恢复、主动搭话评估（assessGap 15min 节流）、闹钟 fireDue、空间回访/日记、器官同步、冷落检测（搭话 30min 无人理→激素事件）。
- agent/request 钩子：体力消耗、温度劫持（cortisol≥70→0.3 / dopamine≥70→0.9）。
- 'out' 块：judgeChem 把一轮社交情绪映射成激素事件（|delta|≥5）。

### 器官八层安全

静态 guard（词表+正则拦危险 API/import/死循环）→ 原生 import 语法解析 → dryRun（stub + 2s 超时）→ 必须注册工具 → 运行时 apiFor 白名单 {log,net(http/https+15s),store(自目录),llm.ask,tools.add} → 工具只挂 full 级 → tick 熔断（3 次 tripped）→ 磁盘即真相（删目录=热卸载，多进程 mtime 快照同步）。

## HTTP API 速查

| 端点 | 说明 |
| --- | --- |
| `GET /api/state` | 免登录：站点信息+登录态 |
| `POST /api/login` / `POST /api/setup` | 登录 / 初始化（**setup 必带 pledge:true**） |
| `GET/POST /api/messages` | 收发（files[] 任意后缀，服务端 32MB 上限） |
| `GET /api/stream` | SSE：message/typing/rotate/history/nudge/azone，25s 心跳 |
| `GET /api/life` | 一条命全量快照（mood 已删；chemistry 带 history） |
| `GET /api/modules` | 模块广播（外部程序用；本 web 面板已写死不依赖） |
| `GET /api/organs` | 器官清单（含自长器官声明与 settings） |
| `POST /api/debug` | 调试台（主人）：8 模块破坏性动作 |
| `POST /api/test` | what=drive/diary/social |
| 其余 | config/memory(+consolidate)/self/wishes/media/avatar/background/diary/stickers/voice(/edge,/test)/logs/status |

## 调试与测试

- 调试台入口：左侧栏头像 5 连击 → 提示 → 第 6 击确认（localStorage auralife_debug）；再 5 连击+第 6 击关闭。只有「整理对话/记忆重放/叫 Ta 一次/写日记/社交回访」烧 token。
- 冒烟范式：临时目录 `AURACHAT_DATA_DIR` + `pathToFileURL` 动态 import 真模块 + mock dsh/hub；断言数据落盘而非返回值。
- 前端验证：headless Chrome CDP（--remote-debugging-port → Runtime.evaluate/Page.reload 抓 console；FileList 注入用 `new DataTransfer()`）。
- 全量语法：`node --check` 递归所有 .js/.mjs（排除 node_modules 与 local/templates）。

## 平台兼容

Linux/Windows 双平台：TTS 的 windowsSynth 非 win32 抛错提示换引擎；uv 安装有 Linux tar.gz 分支；venv 用 python3；路径全走 node:path。已知限制：DSH 内嵌页无麦克风（平台限制）；自定义接口脚本是用户自管。

## 约定

- 配置变更一律过 config.js normalize；密钥 SECRETS 列表单独存储，publicConfig 抹掉只留 `Set` 标记。
- 前端文案统一「Ta」，不用她/他/它；不为 UI 增加说教文案（用户要求）。
- 版本号唯一来源 package.json。
