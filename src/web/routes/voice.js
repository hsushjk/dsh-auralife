import { readFile } from 'node:fs/promises'

export function register(router, ctx) {
  const { json, readBody, requireUser, requireOwner, getConfig, log, edgeInstalled, installEdge, PYENV_DIR, textToSpeech } = ctx
  const state = { installing: false }

  router.add('GET', 'api/voice/edge', async (req, res) => {
    const me = requireOwner(req, res); if (!me) return
    return json(res, { ok: true, installed: edgeInstalled(), dir: PYENV_DIR })
  })

  router.add('POST', 'api/voice/edge', async (req, res) => {
    const me = requireOwner(req, res); if (!me) return
    if (state.installing) return json(res, { ok: false, reason: '正在装，稍等一下' })
    state.installing = true
    try {
      const r = await installEdge(log)
      log.info('edge-tts 安装结果：' + (r.ok ? '成功' : r.reason || '失败'))
      return json(res, { ...r, installed: edgeInstalled(), dir: PYENV_DIR })
    } catch (error) {
      return json(res, { ok: false, reason: String(error.message || error) })
    } finally {
      state.installing = false
    }
  })

  router.add('POST', 'api/voice/test', async (req, res) => {
    const me = requireOwner(req, res); if (!me) return
    const b = await readBody(req)
    const text = String(b.text || '').trim() || '晚安啦，今天也辛苦了，明天见～'
    const opt = { ...(getConfig().voice || {}) }
    if (['cosyvoice', 'gptsovits', 'http'].includes(opt.provider)) opt.engine = opt.provider
    try {
      const r = await textToSpeech(text, opt, log)
      const buf = await readFile(r.file)
      const mime = /\.mp3$/i.test(r.file) ? 'audio/mpeg' : /\.(wav)$/i.test(r.file) ? 'audio/wav' : 'audio/ogg'
      return json(res, { ok: true, engine: r.engine, mime, data: buf.toString('base64') })
    } catch (error) {
      return json(res, { ok: false, reason: '念不出来：' + String(error.message || error) })
    }
  })
}
