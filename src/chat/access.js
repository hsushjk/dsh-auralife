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

export function isOwner(cfg, userId) {
  return String(userId || '') === OWNER_ID
}
