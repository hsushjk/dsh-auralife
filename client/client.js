window.__ModuleLoader__.load({
  id: 'dsh-auralife',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react')
    const h = React.createElement
    const inject = ['slots']
    const PANEL_ID = 'auralife'
    const PAGE = '/auralife/'

    function ChatIcon({ size }) {
      const s = size || 16
      return h('svg', { width: s, height: s, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: 'M20.5 11.6a8 8 0 0 1-8 8 8.6 8.6 0 0 1-3.1-.6L4.5 20.6l1.5-4.2a8 8 0 1 1 14.5-4.8Z' }),
        h('circle', { cx: 9, cy: 11.6, r: 0.9, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 12.4, cy: 11.6, r: 0.9, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 15.8, cy: 11.6, r: 0.9, fill: 'currentColor', stroke: 'none' }),
      )
    }

    function AuraLifePage() {

      return h('div', { style: { height: '100%', width: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' } },
        h('iframe', {
          src: PAGE,
          title: 'AuraLife',
          allow: 'microphone',
          style: { flex: 1, width: '100%', height: '100%', border: 'none', display: 'block', background: 'transparent' },
        }),
      )
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      slots.inject('main', () => slots.register({ name: 'main', key: PANEL_ID }, AuraLifePage))
      slots.inject('sidebar.panellist', () => slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: () => 'AuraLife' }, ChatIcon))
    }

    exports.apply = apply
    exports.inject = inject
    exports.AuraLifePage = AuraLifePage
    exports.ChatIcon = ChatIcon
    return module.exports
  },
})
