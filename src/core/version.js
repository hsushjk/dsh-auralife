import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'))
    return String(pkg.version || '0.0').trim() || '0.0'
  } catch {
    return '0.0'
  }
})()
