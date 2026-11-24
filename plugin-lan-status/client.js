// LAN status client half: a sidebar panel entry plus the main page that
// embeds the standalone status panel through the host's same-origin
// /lan-status bridge. The host half owns the data and the bridge; this file
// only registers slots.
window.__ModuleLoader__.load({
  id: '@local/dsh-lan-status',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const module = { exports: {} }

    const PANEL_ID = 'lan-status'
    const NS = 'lan-status'

    function PanelIcon({ size }) {
      const s = size ?? 16
      return h(
        'svg',
        { width: s, height: s, viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false' },
        h('rect', { x: 2, y: 2.5, width: 12, height: 3.2, rx: 1, fill: 'currentColor', opacity: 0.9 }),
        h('rect', { x: 2, y: 6.4, width: 12, height: 3.2, rx: 1, fill: 'currentColor', opacity: 0.65 }),
        h('rect', { x: 2, y: 10.3, width: 12, height: 3.2, rx: 1, fill: 'currentColor', opacity: 0.4 }),
        h('circle', { cx: 4.2, cy: 4.1, r: 0.55, fill: 'var(--dsw-alias-bg-base, #0b0f17)' }),
        h('circle', { cx: 4.2, cy: 8.0, r: 0.55, fill: 'var(--dsw-alias-bg-base, #0b0f17)' }),
        h('circle', { cx: 4.2, cy: 11.9, r: 0.55, fill: 'var(--dsw-alias-bg-base, #0b0f17)' }),
      )
    }

    function PanelPage() {
      return h(
        'div',
        {
          style: {
            display: 'flex',
            width: '100%',
            height: '100%',
            minHeight: 0,
            background: 'var(--dsw-alias-bg-base, #0b0f17)',
          },
        },
        h('iframe', {
          src: '/lan-status/',
          title: 'LAN 状态',
          style: {
            flex: '1 1 auto',
            width: '100%',
            height: '100%',
            border: 0,
            background: 'var(--dsw-alias-bg-base, #0b0f17)',
          },
        }),
      )
    }

    module.exports.inject = ['slots', 'locale']
    module.exports.apply = (ctx) => {
      ctx.effect(
        () => ctx.locale.register(NS, { zh: { panel: 'LAN 状态' }, en: { panel: 'LAN status' } }),
        'dsh-lan-status:dictionaries',
      )
      const t = ctx.locale.bind(NS)
      ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS, inject: () => ({}) }, PanelPage),
      )
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 40,
            locale: NS,
            label: () => t('panel'),
          },
          PanelIcon,
        ),
      )
    }

    return module.exports
  },
})
