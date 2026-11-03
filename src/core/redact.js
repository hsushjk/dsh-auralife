// —— 日志/面板输出脱敏（AuraLife 自己的实现，2026-11 重写）——// 目标：把「明确像密钥的东西」打码，防止把主人的密钥写进日志页、聊天记录或发给模型。
// 不做完美识别——能认出常见形状即可；误伤无害（日志本来就是给人看的）。

// 常见密钥形状（按优先级，先精确后模糊）。
const masks = [
  // sk- 开头的长 token（OpenAI 风格，最容易辨认）
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, 'sk-***'],
  // "Bearer xxx" / "token=xxx" 这类显式标注后面的值
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g, '$1***'],
  // 键值写法：api_key: 后面跟着一串不含空格的值
  [/((?:access[_-]?token|token|password|passwd|pwd|secret|api[_-]?key|cookie|clientkey|authorization)["']?\s*[:=]\s*["']?)[^\s"',;&]{4,}/gi, '$1***'],
  // URL 查询串里的 token / key 参数
  [/([?&](?:token|access_token|key)=)[^&\s]+/gi, '$1***'],
]

export function redact(input) {
  let text = String(input ?? '')
  for (const [pattern, replacement] of masks) text = text.replace(pattern, replacement)
  return text
}
