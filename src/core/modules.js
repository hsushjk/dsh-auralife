// core/modules.js — 模块注册表（DESIGN-modular.md §2）。
//
// auralife = 两个 core：
//   bridge = 人机交互桥梁（用户可配技术接入）；
//   life   = 机（生命 + 记忆，用户只能开关，内部运行不可干预）。
//
// 每个模块：{ id, name, kind, core, defaultOn, description, capabilities[], settings[] }。
// settings 的 key 对应 config 里的路径（前端动态渲染时按 key 读写，写死页面的时代结束）。
// 生命模块的 settings 为空 —— 它们的内部参数全部内置，只留 debug 接口（DESIGN-modular.md §8）。

export const MODULES = [
  // ---------- bridge：人机交互桥梁 ----------
  {
    id: 'chat', name: '聊天', kind: 'bridge', core: true, defaultOn: true,
    description: '人机交互的主通道：收 Ta 发文字、图片、表情、语音',
    capabilities: ['双向文字', '双向图片', '双向表情', '双向语音'],
    settings: [
      { key: 'merge.waitSec', label: '停顿几秒再回', type: 'number', hint: '你发完一句后等几秒，给你留出连发多条的时间' },
      { key: 'merge.waitTypingSec', label: '最多等几秒', type: 'number', hint: '你一直在输入，最多等这么久就先回' },
      { key: 'history.keepDays', label: '聊天记录保留天数', type: 'number', hint: '原文保留这么久后清理；Ta 的记忆事实永久留，不受影响（3-3650 天）' },
      { key: 'chat.contextWindow', label: '上下文窗口（tokens）', type: 'number', hint: '0 = 自动读 DSH 平台的真实窗口；填了就以你填的为准（如 1000000 表示 1M），到 85% 自动归档旧会话开新会话' },
    ],
  },
  {
    id: 'web', name: '网页面板', kind: 'bridge', core: true, defaultOn: true,
    description: '网页聊天室 + SSE 传讯（配套 IM 客户端连的就是它）',
    capabilities: ['SSE 实时推送', '客人访问', '多会话'],
    settings: [
      { key: 'web.port', label: '端口', type: 'number' },
      { key: 'web.host', label: '监听地址', type: 'text', hint: '0.0.0.0 允许局域网访问' },
      { key: 'siteName', label: '网站名称', type: 'text', hint: '登录页和标题栏显示' },
      { key: 'pageTitle', label: '页面标题', type: 'text' },
      { key: 'theme.mode', label: '主题', type: 'select', options: [['follow', '跟随系统'], ['light', '浅色'], ['dark', '深色'], ['acrylic', '亚克力'], ['frosted', '毛玻璃']] },
      { key: 'theme.acrylic.brightness', label: '亚克力·背景亮度', type: 'number', hint: '0-100，默认 100（100=原样不处理）' },
      { key: 'theme.background', label: '背景图', type: 'text', hint: '上传的图片，所有浏览器同步显示' },
    ],
  },
  {
    id: 'tts', name: '语音合成', kind: 'bridge', defaultOn: false,
    description: 'Ta 说出来的声音：关 / edgetts / win 语音 / 自定义接口（参照 local/README）',
    capabilities: ['回复转语音'],
    settings: [], // TTS 设置有专属复杂 UI（引擎四档 + 试听 + edge 安装），不在 schema 里声明
  },
  {
    id: 'stt', name: '语音识别', kind: 'bridge', defaultOn: false,
    description: 'Ta 的耳朵：关 / dsh 自带 / 自定义接口（参照 local/README）',
    capabilities: ['听写语音消息'],
    settings: [], // STT 设置有专属复杂 UI（引擎三档 + 识别服务状态）
  },
  {
    id: 'imagegen', name: '生图', kind: 'bridge', defaultOn: false,
    description: 'Ta 画图的能力：想画就画（不用等开心或等被要求）',
    capabilities: ['文生图', '图生图'],
    settings: [], // 生图设置有专属复杂 UI（引擎三档 + 服务参数）
  },
  {
    id: 'stickers', name: '表情', kind: 'bridge', defaultOn: true,
    description: '表情包库：Ta 会收藏、斗图（随机概率已删，Ta 自己在回复里写 <sticker> 才会发）',
    capabilities: ['双向表情', '斗图', '收藏收图'],
    settings: [], // 表情设置有专属 UI（图库管理）
  },
  {
    id: 'sound', name: '提示音', kind: 'bridge', defaultOn: true,
    description: '消息来去的提示音（不想要声音就关掉）',
    capabilities: ['消息提示音'],
    settings: [], // 提示音设置有专属 UI（试听按钮）
  },

  // ---------- life：机（生命 + 记忆）----------
  {
    id: 'chemistry', name: '内分泌', kind: 'life', defaultOn: true,
    description: '多巴胺 / 皮质醇 / 血清素三激素，只有 Ta 自己的经历能改变',
    capabilities: ['激素涨落', '影响采样与话风'],
    settings: [],
  },
  {
    id: 'energy', name: '身体', kind: 'life', defaultOn: true,
    description: '体力随作息起伏：回话消耗、休息恢复',
    capabilities: ['体力起伏'],
    settings: [],
  },
  {
    id: 'wishes', name: '执念', kind: 'life', defaultOn: true,
    description: 'Ta 心里挂念的事：只有 Ta 自己会挂上、会了结',
    capabilities: ['执念生长', '驱动主动搭话'],
    settings: [],
  },
  {
    id: 'memory', name: '记忆', kind: 'life', defaultOn: true,
    description: '事实版本链 + 事件 + 联想 + 情绪锚点召回 + 遗忘曲线 + 梦境 + 烙印',
    capabilities: ['事实记忆', '事件摘要', '联想做梦', '遗忘曲线', '烙印', '写完读回自证'],
    settings: [],
  },
  {
    id: 'self', name: '人格', kind: 'life', defaultOn: true,
    description: 'Ta 的名字、对你的称呼、底色：出厂只是种子，Ta 自己会改，改到 100% 覆盖都行',
    capabilities: ['人格演化', '名字与称呼', '底色'],
    settings: [],
  },
  {
    id: 'drive', name: '主动搭话', kind: 'life', defaultOn: true,
    description: 'Ta 挂念+压力攒够了会自己来找你说话，由头来自记忆',
    capabilities: ['主动搭话', '记忆联动'],
    settings: [],
  },
  {
    id: 'alarm', name: '闹钟', kind: 'life', defaultOn: true,
    description: 'Ta 自己设的时间提醒，到点自己开口',
    capabilities: ['设闹钟', '到点唤醒'],
    settings: [],
  },
  {
    id: 'azone', name: '日记', kind: 'life', defaultOn: true,
    description: 'Ta 自己写的日记，在空间里可见',
    capabilities: ['自动写日记'],
    settings: [
      { key: 'diary.visibility', label: '日记可见性', type: 'select', options: [['all', '客人与主人可见'], ['self', '仅自己可见']] },
    ],
  },
  {
    id: 'azoneSocial', name: '回访', kind: 'life', defaultOn: true,
    description: 'Ta 自己去空间回访留言',
    capabilities: ['回访留言'],
    settings: [],
  },
  {
    id: 'organs', name: '器官', kind: 'life', defaultOn: true,
    description: 'Ta 的能力器官：出厂内置 10 个（心情已并入内分泌），缺能力会自己写新器官（经守护检查后热加载，全 AI 托管）',
    capabilities: ['10 个内置器官', '器官自举', '安全守护'],
    settings: [],
  },
]

// enabled 读法（收窄）：只有 TTS / STT / 生图 / 提示音四个需要开关（用户可能没能力配置或根本不想要），
// 其余模块恒开——开关做多了只会引发 bug（用户原话）。core 恒开。
// m 可以是模块对象或模块 id 字符串（调用方方便）。
export function moduleEnabled(cfg, m) {
  if (typeof m === 'string') m = MODULES.find((x) => x.id === m)
  if (!m) return true
  switch (m.id) {
    case 'tts': return cfg.voice?.enabled !== false
    case 'stt': return cfg.voice?.asr !== 'off'
    case 'imagegen': return cfg.imageGen?.enabled !== false
    case 'sound': return cfg.sound?.enabled !== false
    default: return true
  }
}

export function modulesSummary(cfg) {
  const pub = (m) => ({
    id: m.id,
    name: m.name,
    kind: m.kind,
    core: m.core,
    enabled: moduleEnabled(cfg, m),
    description: m.description,
    capabilities: m.capabilities,
    settings: m.settings,
  })
  return {
    bridge: MODULES.filter((m) => m.kind === 'bridge').map(pub),
    life: MODULES.filter((m) => m.kind === 'life').map(pub),
  }
}
