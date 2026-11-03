// features/companion.js — 确定性词表情绪打分（内分泌的触发源之一）。
//
// 心情（mood 状态机）已删除情绪交给三激素管。
// 这里保留两块：
//   1. scoreText —— 用户消息的词表打分，被凶/被夸直接映射皮质醇/多巴胺（不调 LLM）。
//   2. judgeChem —— 每轮聊完由 LLM 判这一轮对内分泌的影响，直接喂 chemistry.event，
//      不再存心情数值（原 mood.judge 的存储层已删，判断能力保留）。

const UP = ['喜欢你', '爱你', '想你', '可爱', '好看', '漂亮', '聪明', '真棒', '厉害', '牛', '谢谢', '辛苦', '晚安', '早安', '抱抱', '摸摸', '贴贴', '乖', '宝贝', '爱了', '哈哈哈', '白米饭', '好吃', '请你吃']
const DOWN = ['讨厌', '滚', '烦死', '闭嘴', '笨', '蠢', '傻', '丑', '垃圾', '废物', '恶心', '无聊', '走开', '别理我', '不理你', '别说话', '生气', '难过', '烦人']

export function scoreText(text) {
  const t = String(text || '')
  let d = 0
  for (const w of UP) if (t.includes(w)) d += 6
  for (const w of DOWN) if (t.includes(w)) d -= 8
  return Math.max(-20, Math.min(20, d))
}

// 每轮聊完的「社交情绪 → 内分泌」判断（原 mood.judge，去掉了心情存储）。
// 返回 { delta: -15~15, reason, confidence } 或 null（判断失败）。
export async function judgeChem({ dsh, getConfig, life, userText, reply, who = '对方', origin = 'user' }) {
  const full = getConfig()
  const bot = life?.load?.().identity?.name || full.botName || 'AuraLife'
  if (!dsh) return null
  const scene = origin === 'speak-up' ? `这一轮是${bot}自己想${who}了、主动去找${who}说话（不是被叫来干活）` : `这一轮是${who}在跟${bot}说话`
  try {
    const { askModel } = await import('../core/llm.js')
    const out = await askModel(dsh, {
      cfg: full,
      system: `你在判断聊天角色「${bot}」聊完一轮后，这一轮对它的内分泌（多巴胺/皮质醇/血清素）的影响。${scene}。只看这一轮真正影响它的东西：被夸、被关心、被惦记 → 多巴胺/血清素该涨；被凶、被冷落、被嫌弃 → 皮质醇该涨、血清素该跌；开玩笑的「讨厌~」「笨蛋」不算真骂。只输出 JSON：{"delta": -15~15 的整数（正=聊得开心，负=聊得难受）, "reason": "十几个字的理由", "confidence": 0~1 你有多确定}。没什么影响就 delta 为 0。`,
      text: `${origin === 'speak-up' ? bot + '主动说' : who + '说'}：${String(userText || '').slice(0, 600)}\n${bot}回：${String(reply || '').slice(0, 600)}`,
      maxTokens: 400,
      temperature: 0.2,
    })
    const m = String(out || '').match(/\{[\s\S]*\}/)
    if (!m) return null
    try {
      const j = JSON.parse(m[0])
      const delta = Math.max(-15, Math.min(15, Math.round(Number(j.delta) || 0)))
      const confidence = Math.max(0, Math.min(1, Number(j.confidence) || 0))
      return { delta, reason: String(j.reason || '').slice(0, 40), confidence }
    } catch { return null }
  } catch {
    return null
  }
}
