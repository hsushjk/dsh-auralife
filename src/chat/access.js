export const OWNER_ID = 'owner'

export function levelFor(cfg, chat) {
  if (!chat || chat.system) return 'social'
  if (isOwner(cfg, chat.userId)) return 'full'
  if (chat.level === 'full') return 'full'
  return 'social'
}

export function presetFor(level) {
  return level === 'full' ? 'auralife-owner' : 'auralife-guest'
}

// #4：预设人格只跟「是不是主人本人」走，不跟 level 走。
// 客人即使被开了 full，也不该拿到主人预设（那等于把整扇门连人设一起给他）。
export function presetForChat(cfg, chat) {
  return isOwner(cfg, chat?.userId) ? 'auralife-owner' : 'auralife-guest'
}

export function isOwnerChat(cfg, chat) {
  return Boolean(chat && !chat.system && isOwner(cfg, chat.userId))
}

export function isOwner(cfg, userId) {
  return String(userId || '') === OWNER_ID
}
