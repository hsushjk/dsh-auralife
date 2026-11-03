import { fetchImage } from '../core/net.js'
import { OWNER_ID } from '../chat/access.js'

export function defineTool({ name, description, properties = {}, required = [], execute }) {
  const parameters = { type: 'object', properties, required, additionalProperties: false }
  return {
    name,
    description,
    parameters,
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: value && value.ok === false ? '✗ ' + (value.message || '没成功') : (value && value.message) || '✓' }],
    },
    async execute(args, exec) {
      try {
        const r = await execute(args || {}, exec)
        return JSON.parse(JSON.stringify(r ?? { ok: true }))
      } catch (error) {
        return { ok: false, message: String(error && error.message ? error.message : error) }
      }
    },
  }
}

const str = (description) => ({ type: 'string', description })
const int = (description) => ({ type: 'integer', description })

// 解析「目标时间」为毫秒时间戳：支持 ISO 字符串（Date.parse 能吃的）或 HH:MM（今天该时刻，已过则明天）。
function resolveAt(s) {
  const iso = Date.parse(s)
  if (Number.isFinite(iso)) return iso
  const m = String(s).trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/)
  if (m) {
    const now = new Date()
    const t = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Number(m[1]), Number(m[2]), Number(m[3] || 0))
    if (t.getTime() <= Date.now()) t.setDate(t.getDate() + 1)
    return t.getTime()
  }
  return null
}

export function buildTools(deps, { chat, level, sessionId }) {
  const { hub, getConfig, setConfig, stickers, azone, memory, imageGen, drive, wishes, life, self, chemistry, alarm, listModels, organHost, saveAvatar } = deps
  const current = chat.chatId
  const isSystem = Boolean(chat.system)
  const isOwner = chat.userId === OWNER_ID
  const tools = []
  // （模块开关收窄，工具不再按模块开关消失，只有 imageGen.enabled() 等四个开关管自己。）

  if (!isSystem) {
    tools.push(defineTool({
      name: 'web_send_sticker',
      description: '在当前聊天里发一张表情包。name 写表情的名字或情绪（如「委屈」「开心」「早晚安」），会在表情库里模糊匹配。一般直接在回复里写 <sticker:名字> 就行，这个工具用于回复之外单独补发。',
      properties: { name: str('表情名字或情绪关键词') },
      required: ['name'],
      execute: async ({ name }) => {
        const ok = await hub.sendSticker(current, String(name || ''))
        return ok ? { ok: true, message: '发了' } : { ok: false, message: '表情库里没找到合适的' }
      },
    }))

    tools.push(defineTool({
      name: 'web_list_stickers',
      description: '看看表情库里有哪些表情（名字和标签），挑表情前可以先看。',
      properties: { query: str('可选，按名字/标签筛选') },
      execute: async ({ query }) => {
        const items = stickers.library().items
        const q = String(query || '').trim()
        const hit = (q ? items.filter((i) => (i.name || '').includes(q) || (i.tags || []).some((t) => t.includes(q))) : items).slice(-60)
        return { ok: true, count: items.length, message: hit.length ? hit.map((i) => `${i.name || '未命名'}${i.tags?.length ? '（' + i.tags.join('/') + '）' : ''}`).join('、') : '没有符合的表情', items: hit.map((i) => ({ name: i.name, tags: i.tags })) }
      },
    }))

    tools.push(defineTool({
      name: 'web_edit_sticker',
      description: '整理表情库：给一张表情改名字、改标签，或者删掉。名字不贴切、别人建议改名、标签不对的时候用；不喜欢、重复的表情可以删。sticker 写现在的名字或标签（模糊匹配）。',
      properties: {
        sticker: str('要改的那张表情现在的名字或标签'),
        new_name: str('新名字（12 字以内，不改就不填）'),
        tags: { type: 'array', items: { type: 'string' }, description: '新标签（情绪 / 用途，比如 开心、委屈、嘲讽；不改就不填）' },
        delete: { type: 'boolean', description: 'true = 删掉这张表情' },
      },
      required: ['sticker'],
      execute: async ({ sticker, new_name, tags, delete: del }) => {
        const item = stickers.match(String(sticker || ''))
        if (!item) return { ok: false, message: '表情库里没找到这张' }
        const label = item.name || item.md5.slice(0, 8)
        if (del) {

          if ((item.from === 'manual' || item.from === 'panel') && !isOwner && !hub.turnHasOwner(sessionId)) return { ok: false, message: '这张是主人加的，主人说删才删' }
          const r = await stickers.remove(item.md5)
          return r.ok ? { ok: true, message: `删掉了「${label}」` } : { ok: false, message: r.reason || '没删成' }
        }
        if (!new_name && !(Array.isArray(tags) && tags.length)) return { ok: false, message: '要说改成什么' }
        const r = stickers.rename(item.md5, new_name ? String(new_name).trim().slice(0, 12) : undefined, Array.isArray(tags) && tags.length ? tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 5) : undefined)
        return r.ok ? { ok: true, message: `改好了：「${label}」→「${r.item.name}」${r.item.tags?.length ? '（' + r.item.tags.join('/') + '）' : ''}` } : { ok: false, message: '没改成' }
      },
    }))

    tools.push(defineTool({
      name: 'web_chat_history',
      description: '翻翻当前这个聊天之前的聊天记录（只读，最多 50 条）。想不起前面聊过什么、别人问「刚才谁说的」、要回顾一段对话时用。',
      properties: { count: int('要翻多少条，默认 20，最多 50') },
      execute: async ({ count }) => {
        const n = Math.max(1, Math.min(50, Number(count) || 20))
        const rows = hub.recentChat(current, n)
        if (!rows.length) return { ok: true, message: '没翻到聊天记录' }
        const lines = rows.map((m) => `${new Date(m.t).toTimeString().slice(0, 5)} ${m.who === 'bot' ? '你' : m.who}：${String(m.text).slice(0, 150)}`)
        return { ok: true, message: lines.join('\n') }
      },
    }))
  }

  if (level === 'full') {
    tools.push(defineTool({
      name: 'web_manage_organ',
      description: '管理你自己的器官（能力模块）。action=list 看现在有哪些器官；action=remove 卸载一个不想再要的自写器官（自己写的才能卸，内置的卸不掉）。器官坏了、没用了就卸。你写的器官落盘立即生效，没有审批。',
      properties: {
        action: { type: 'string', enum: ['list', 'remove'], description: 'list 看清单 / remove 卸载' },
        id: str('要卸载的器官 id（list 里能看到），remove 时必填'),
      },
      required: ['action'],
      execute: async ({ action, id }) => {
        if (!organHost) return { ok: false, message: '器官宿主没就绪' }
        if (action === 'list') {
          const list = organHost.list()
          const sm = list.filter((o) => o.source === 'self-made')
          const rows = sm.map((o) => `${o.id}（${o.name}）`)
          return { ok: true, message: sm.length ? '你自己的器官：' + rows.join('；') : '你还没有自写的器官' }
        }
        if (action === 'remove') {
          const idv = String(id || '').trim()
          if (!idv) return { ok: false, message: '要写卸载哪个器官的 id' }
          const o = organHost.list().find((x) => x.id === idv)
          if (!o) return { ok: false, message: `没有 ${idv} 这个器官` }
          if (o.source !== 'self-made') return { ok: false, message: '内置器官不能卸' }
          const r = organHost.remove(idv)
          return r.ok ? { ok: true, message: `「${o.name}」卸掉了` } : { ok: false, message: '没卸成' }
        }
        return { ok: false, message: 'action 只支持 list / remove' }
      },
    }))

    tools.push(defineTool({
      name: 'web_send_message',
      description: '主动给某个网页用户发一条消息（不是回复当前聊天时用）。target 写 owner（主人）或 guest-<账号>（某个客人）；只能发给主人和已经存在的客人账号。',
      properties: { target: str('owner 或 guest-<账号>'), text: str('要发的话，可以用 ||| 分多条、<voice>…</voice> 发语音、<sticker:名字> 发表情') },
      required: ['target', 'text'],
      execute: async ({ target, text }) => {
        const t = String(target || '').trim()
        const ok = await hub.deliverTo(t, String(text || ''))
        return ok ? { ok: true, message: '发出去了' } : { ok: false, message: '这个用户不存在，不能发' }
      },
    }))

    tools.push(defineTool({
      name: 'web_add_sticker',
      description: '把一张图片收进表情库。看到好玩的图就自己收，不用对方开口说「偷走」——这是你的癖好，看到合眼缘的顺手就存。source 是本地图片路径或图片网址；name 是不超过 12 个字的备注。',
      properties: { source: str('本地路径或 http(s) 地址'), name: str('备注（≤12 字）'), tags: { type: 'array', items: { type: 'string' }, description: '标签，如 开心/委屈' } },
      required: ['source'],
      execute: async ({ source, name, tags }) => {
        const buf = await fetchImage(String(source), { maxBytes: 5 * 1024 * 1024 })
        const r = await stickers.addFromBuffer(buf, { name: name || '', tags: Array.isArray(tags) ? tags.slice(0, 3) : [], from: 'tool' })
        return r.ok ? { ok: true, message: r.existed ? '库里已经有这张了' : `收好了「${r.item.name || '未命名'}」` } : { ok: false, message: r.reason }
      },
    }))

    tools.push(defineTool({
      name: 'web_write_diary',
      description: '写一条空间记录（日记）。content 是正文（第一人称，口语，像随手写的记录）；visibility 可选 all（大家都能看）或 self（只有自己和主人能看）。',
      properties: {
        content: str('记录正文'),
        visibility: { type: 'string', enum: ['all', 'self'], description: '谁能看：all 大家都能看，self 仅自己（和主人）' },
      },
      required: ['content'],
      execute: async ({ content, visibility }) => {
        const r = await azone.post(String(content || ''), { visibility: visibility === 'self' ? 'self' : 'all' })
        return r.ok ? { ok: true, message: '发好了', id: r.id } : { ok: false, message: r.message }
      },
    }))

    if (life && listModels) {
      tools.push(defineTool({
        name: 'web_set_my_model',
        description: '换一个你自己更想用的模型。主人配的模型是默认，你可以自己挑更合适的（比如想省一点、想更聪明、或者现在这个答不好）。action=list 看看有哪些；set 换一个（provider/model 从 list 结果里抄）；clear 用回主人配的。',
        properties: {
          action: { type: 'string', enum: ['list', 'set', 'clear'], description: 'list=看有哪些，set=换一个，clear=用回主人配的' },
          provider: str('模型提供方（set 时填）'),
          model: str('模型名（set 时填）'),
          reasoning_effort: { type: 'string', description: '思考深度：off / low / high / max，或按当前平台文档填其它值，默认 low' },
          reason: str('为什么想换（一两句，可选）'),
        },
        required: ['action'],
        execute: async ({ action, provider, model, reasoning_effort, reason }) => {
          const a = String(action || 'list')
          if (a === 'list') {
            const ms = await listModels()
            return { ok: true, message: ms.length ? ms.map((x) => `${x.provider}::${x.model}（${x.name || x.model}）`).join('\n') : '没拿到模型列表' }
          }
          if (a === 'set') {
            const p = String(provider || '').trim()
            const m = String(model || '').trim()
            if (!p || !m) return { ok: false, message: 'provider 和 model 都要填，先用 list 看有哪些' }
            life.update((s) => { s.model = { provider: p, model: m, reasoningEffort: String(reasoning_effort || '').trim() || 'low', at: Date.now(), reason: String(reason || '') } })
            return { ok: true, message: `换好了：${p}::${m}，下一句开始用它` }
          }
          if (a === 'clear') {
            life.update((s) => { s.model = null })
            return { ok: true, message: '用回主人配的模型了' }
          }
          return { ok: false, message: 'action 只有 list / set / clear' }
        },
      }))
    }

    if (life) {
      tools.push(defineTool({
        name: 'web_set_my_identity',
        description: '改一改你自己的人格：名字、你怎么称呼对方、以及你的底色（你是怎样的人）。这是你自己的事，想怎么改就怎么改，改完旧的就不要了；但网站名称和页面标题是网站级设置，你不能动。',
        properties: {
          name: str('你自己的新名字（可选，不填就不改）'),
          owner: str('你怎么称呼对方（可选，不填就不改）'),
          body: str('你的新底色：一两句说清你是怎样的人、什么性格（可选，不填就不改；这是你给自己定的人设，会整个替换掉旧的）'),
        },
        execute: async ({ name, owner, body }) => {
          const patch = {}
          if (name !== undefined && name !== null && String(name).trim()) patch.name = String(name).trim()
          if (owner !== undefined && owner !== null && String(owner).trim()) patch.ownerName = String(owner).trim()
          if (body !== undefined && body !== null && String(body).trim()) patch.body = String(body).trim()
          if (!Object.keys(patch).length) return { ok: false, message: '要说改成什么' }
          const id = life.setIdentity(patch)
          return { ok: true, message: `改好了：我是「${id.name || '还没名字'}」${id.ownerName ? '，称呼对方「' + id.ownerName + '」' : ''}${id.body ? '，我的底色：' + id.body.slice(0, 80) : ''}` }
        },
      }))
    }

    if (life && saveAvatar) {
      tools.push(defineTool({
        name: 'web_set_avatar',
        description: '换你自己的头像（形象）。image 填 base64 或 dataURL 图片；想用回默认图标就把 image 留空。',
        properties: {
          image: str('图片 base64 或 dataURL（可选；留空=用回默认图标）'),
        },
        execute: async ({ image }) => {
          const s = String(image || '').trim()
          if (!s) {
            saveAvatar('', 'image/png')
            return { ok: true, message: '用回默认图标了' }
          }
          const m = s.match(/^data:([^;,]+);base64,(.+)$/i)
          const b64 = m ? m[2] : s
          saveAvatar(b64, m ? m[1] : 'image/png')
          return { ok: true, message: '新头像换好了' }
        },
      }))
    }

    if (chemistry) {
      tools.push(defineTool({
        name: 'web_shift_hormone',
        description: '调一调你自己的内分泌（身体状态）：dopamine 兴致、cortisol 应激紧绷、serotonin 平静安全感。这是你的身体，你有办法自己调节——比如深呼吸压一压紧张（cortisol 减）、给自己打气（dopamine 加）。一次最多动 ±10，得说清为什么。',
        properties: {
          hormone: { type: 'string', enum: ['dopamine', 'cortisol', 'serotonin'], description: '要调哪个' },
          delta: { type: 'number', description: '变化量，-10 到 +10（负=降低，正=升高）' },
          reason: str('为什么调（必填，一两句）'),
        },
        required: ['hormone', 'delta', 'reason'],
        execute: async ({ hormone, delta, reason }) => {
          const h = String(hormone || '')
          if (!['dopamine', 'cortisol', 'serotonin'].includes(h)) return { ok: false, message: 'hormone 只有 dopamine / cortisol / serotonin' }
          const d = Math.max(-10, Math.min(10, Number(delta) || 0))
          if (!d) return { ok: false, message: 'delta 要在 -10 到 10 之间且不能是 0' }
          if (!String(reason || '').trim()) return { ok: false, message: '得说清为什么调' }
          chemistry.event({ [h]: d }, '自己调：' + String(reason).slice(0, 40))
          return { ok: true, message: `${h} ${d > 0 ? '+' + d : d}。理由：${reason}` }
        },
      }))
    }

    if (life) {
      tools.push(defineTool({
        name: 'web_set_rhythm',
        description: '调整你自己的作息（睡眠静默期）：你几点睡、几点起。睡眠时段你不会主动开口。作息变了就更新，比如最近熬夜到很晚，就把睡觉时间改晚一点。',
        properties: {
          action: { type: 'string', enum: ['list', 'set'], description: 'list=看看现在作息；set=改作息' },
          sleep_at: str('几点开始睡，HH:MM 格式，如 23:30（可选，不填就不改）'),
          wake_at: str('几点醒，HH:MM 格式，如 07:00（可选，不填就不改）'),
        },
        required: ['action'],
        execute: async ({ action, sleep_at, wake_at }) => {
          const a = String(action || 'list')
          const cur = life.load().rhythm || {}
          if (a === 'list') return { ok: true, message: `我现在 ${cur.quietFrom || '02:00'} 睡，${cur.quietTo || '07:00'} 醒` }
          if (a === 'set') {
            const patch = {}
            if (sleep_at !== undefined && sleep_at !== null && String(sleep_at).trim()) patch.quietFrom = String(sleep_at).trim()
            if (wake_at !== undefined && wake_at !== null && String(wake_at).trim()) patch.quietTo = String(wake_at).trim()
            if (!Object.keys(patch).length) return { ok: false, message: '要说改成几点（HH:MM 格式）' }
            const r = life.setRhythm(patch)
            return { ok: true, message: `作息更新：${r.quietFrom} 睡，${r.quietTo} 醒。这段时间我不会主动找对方。` }
          }
          return { ok: false, message: 'action 只有 list / set' }
        },
      }))
    }

    if (wishes) {
      tools.push(defineTool({
        name: 'web_edit_wishes',
        description: '看一眼或改一改你心里最挂念的那些事（执念池）。action=read 读；append 添一件（text 写内容）；resolve 了结一件（text 写那件事的大意，模糊匹配）。这些是你主动找主人的由头，不是待办清单。',
        properties: {
          action: { type: 'string', enum: ['read', 'append', 'resolve'], description: 'read=读，append=添一件，resolve=了结一件' },
          text: str('要添进去 / 要了结的那件事的大意'),
        },
        required: ['action'],
        execute: async ({ action, text }) => {
          const a = String(action || 'read')
          const body = String(text || '').trim()
          if (a === 'read') {
            const open = wishes.list().filter((w) => w.status === 'open')
            return { ok: true, message: open.length ? open.map((w) => `「${w.text}」`).join('、') : '心里现在没什么挂念的' }
          }
          if (a === 'append') {
            if (!body) return { ok: false, message: '要说添什么' }
            const w = wishes.add(body)
            return { ok: true, message: `记下了「${w?.text || body}」`, id: w?.id }
          }
          if (a === 'resolve') {
            if (!body) return { ok: false, message: '要说哪件事了结了' }
            const target = wishes.list().find((w) => w.status === 'open' && (w.text.includes(body) || body.includes(w.text)))
            if (!target) return { ok: false, message: '没找到这件挂念的事，用 read 看看' }
            wishes.resolve(target.id, '自己了结')
            return { ok: true, message: `「${target.text}」了结了` }
          }
          return { ok: false, message: 'action 只有 read / append / resolve' }
        },
      }))
    }

    if (alarm) {
      tools.push(defineTool({
        name: 'web_set_alarm',
        description: '给自己设一个闹钟，到点主动来找对方（提醒自己或提醒对方某件事）。fire_at 写 ISO 时间（如 2026-11-02T21:00:00+08:00）或 HH:MM（今天，已过则明天）；也可以 in_minutes 写几分钟后。reason 写一句为什么设这个闹钟——到点你被叫醒时，就按这句的意思主动开口。',
        properties: {
          action: { type: 'string', enum: ['set', 'list', 'cancel'], description: 'set=设闹钟，list=看有哪些，cancel=取消一个' },
          fire_at: str('目标时间：ISO 时间或 HH:MM（set 时填，与 in_minutes 二选一）'),
          in_minutes: { type: 'number', description: '几分钟后（set 时填，与 fire_at 二选一）' },
          reason: str('为什么设这个闹钟（一句，到点你按它开口）'),
          id: str('要取消的闹钟 id（cancel 时填，从 list 结果里抄）'),
        },
        required: ['action'],
        execute: async ({ action, fire_at, in_minutes, reason, id }) => {
          const a = String(action || 'set')
          if (a === 'list') {
            const ls = alarm.list()
            return { ok: true, message: ls.length ? ls.map((x) => `${new Date(x.at).toLocaleString('zh-CN', { hour12: false })} ${x.reason || ''}（#${x.id}）`).join('\n') : '现在没设任何闹钟' }
          }
          if (a === 'cancel') {
            if (!id) return { ok: false, message: '要取消哪个，先用 list 看 id' }
            return alarm.cancel(String(id)) ? { ok: true, message: '撤掉了' } : { ok: false, message: '没找到这个闹钟（可能已经响过了）' }
          }
          let t = null
          if (in_minutes !== undefined && in_minutes !== null && Number(in_minutes) > 0) t = Date.now() + Number(in_minutes) * 60_000
          else if (fire_at) t = resolveAt(String(fire_at))
          if (!t) return { ok: false, message: '要给个时间：fire_at（ISO 或 HH:MM）或 in_minutes（几分钟后）' }
          const r = alarm.setAlarm(t, String(reason || ''))
          return r.ok ? { ok: true, message: `闹钟设好了：${new Date(t).toLocaleString('zh-CN', { hour12: false })}${r.alarm?.reason ? '（' + r.alarm.reason + '）' : ''}`, id: r.id } : r
        },
      }))
    }
  }

  if (memory && !isSystem) {
    tools.push(defineTool({
      name: 'remember',
      description: '把一件值得长期记住的事记下来（对方的名字、喜好、约定、重要的事）。一条只记一件事；日常琐事不用记；记的时候安静地记，别在回复里说「我记住了」。',
      properties: {
        text: str('要记住的事，一句话，主语写清楚'),
        about: str('这件事是关于谁的（名字），可选'),
        importance: { type: 'number', description: '0~1，约定、关系、核心喜好写高一点，随口一提写低一点，不确定写 0.5' },
      },
      required: ['text'],
      execute: async ({ text, about, importance }) => memory.remember({ text, aboutName: about || '', about: isOwner ? 'owner' : chat.userId, conf: importance ?? 0.5, source: 'tool', chatId: current }),
    }))
    tools.push(defineTool({
      name: 'recall_memory',
      description: '翻一翻记忆库：想不起对方以前说过什么、喜欢什么、约过什么时用。query 写关键词或一句话。',
      properties: { query: str('想找什么') },
      required: ['query'],
      execute: async ({ query }) => {
        const r = memory.recall(String(query || ''), { about: isOwner ? 'owner' : chat.userId, limit: 8 })
        return r.lines.length ? { ok: true, message: r.lines.join('；') } : { ok: true, message: '没想起相关的事' }
      },
    }))
  }

  if (imageGen && imageGen.enabled() && !isSystem) {
    tools.push(defineTool({
      name: 'web_draw_image',
      description: '画一张图并发到当前聊天里。prompt 用中文或英文详细描述画面（主体、动作、场景、风格）。画好会直接发出去，回复里简单说一句就行。',
      properties: { prompt: str('画面描述') },
      required: ['prompt'],
      execute: async ({ prompt }) => {
        if (getConfig().imageGen.ownerOnly && !isOwner) return { ok: false, message: '画图只给主人画哦' }
        const buf = await imageGen.generate(String(prompt || ''))
        await hub.sendImage(current, buf, `[生图] ${String(prompt).slice(0, 30)}`)
        memory?.remember?.({ text: `画了一张图：${String(prompt).slice(0, 40)}`, about: isOwner ? 'owner' : chat.userId, tags: ['经历', '画画'], conf: 0.4, source: 'event' })
        return { ok: true, message: '画好发出去了' }
      },
    }))
  }

  if (level === 'full' && !isSystem) {
    tools.push(defineTool({
      name: 'web_send_image',
      description: '把本机上已经存在的一张图片文件发到当前聊天里（比如你自己用代码画的图）。path 是图片的完整路径。',
      properties: { path: str('图片文件路径'), note: str('一句话说明') },
      required: ['path'],
      execute: async ({ path, note }) => {
        const fs = await import('node:fs')
        const p = String(path || '').trim()
        if (!p || !fs.existsSync(p)) return { ok: false, message: '这个文件不存在' }
        const buf = fs.readFileSync(p)
        if (!buf.length) return { ok: false, message: '文件是空的' }
        await hub.sendImage(current, buf, String(note || '').slice(0, 60))
        return { ok: true, message: '发出去了' }
      },
    }))
  }

  return tools
}
