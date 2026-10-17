// Opt-in Tower command hint rendered in the composer dock.
// Static text only: it never claims live mode state, because the Client cannot
// read the Host plugin's in-memory mode map without a Remote seam.
window.__ModuleLoader__.load({
  id: '@local/dsh-tower-ui',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    function TowerHint() {
      return h(
        'div',
        {
          title: 'Tower: /tower · /tower on [message] · /tower off [message]',
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
            padding: '0 6px',
            fontSize: '11px',
            lineHeight: '18px',
            color: 'inherit',
            opacity: 0.55,
            userSelect: 'none',
            whiteSpace: 'nowrap',
          },
        },
        h('span', { 'aria-hidden': true }, '⌘'),
        h('span', null, '/tower'),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.composer.dock',
              id: 'tower-hint',
              order: 6,
            },
            TowerHint,
          ),
        )
      },
    }
  },
})
