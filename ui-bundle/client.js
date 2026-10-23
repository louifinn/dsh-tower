// dsh-tower-ui 0.2.2 — optional Web Client surfaces for the Tower plugin.
//
// Entry module. It registers, all plain React (no iframe, DOM writes, Host RPC
// or Harness Client package imports): the twelve keyed tool cards, the
// history-derived composer dock chip/summary, the root-scoped overlay status
// strip, the dynamic mode-aware denied-tool rows (#12), and the `tower-ui`
// locale dictionaries (en/zh). Tower mode has no Client RPC: the dock derives
// it from the durable `/tower`, `tower_mode` and `tower_control` history in the
// `useChat` legacy slice, so a page refresh re-derives the same stance.
//
// Since #71 the surfaces live in package-local sibling chunks
// (`client.<surface>.js`) loaded through `require.async`; each registers
// through this same `__ModuleLoader__` surface with `{ id, chunk, factory }`.
// React comes from the browser module table, theme references stay on
// `--dsw-alias-*` tokens, and `window.__TOWER_UI_DIAG__` is a read-only test
// seam (not DOM, no state).
window.__ModuleLoader__.load({
  id: 'dsh-tower-ui',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'tower-ui'
    const VERSION = '0.2.2'
    const DIAG_KEY = '__TOWER_UI_DIAG__'
    const NOTICE_MS = 4500
    // Native toolviews register at priority 0; the slot core renders the
    // lowest priority, so a negative priority shadows them only while this
    // registration is alive.
    const DENIED_PRIORITY = -10

    // -------------------------------------------------------------------
    // Diagnostics (read-only test seam; not DOM, not Host state).
    // -------------------------------------------------------------------
    const diagnostics = {
      plugin: 'dsh-tower-ui',
      version: VERSION,
      namespace: NS,
      applied: false,
      slots: [],
      toolviews: [],
      denied: { active: false, keys: [] },
      mode: { known: false, on: null, denied: null },
      errors: [],
    }
    if (typeof window !== 'undefined') window[DIAG_KEY] = diagnostics
    function recordSlot(slot, detail) {
      const duplicate = diagnostics.slots.some(
        (entry) => entry.slot === slot && entry.id === detail.id && entry.key === detail.key,
      )
      if (!duplicate) diagnostics.slots.push(Object.assign({ slot }, detail))
    }
    function guard(where, fn) {
      try {
        return fn()
      } catch (error) {
        diagnostics.errors.push({
          where,
          message: String(error && error.message ? error.message : error),
        })
        return undefined
      }
    }
    // A slot declaration can collapse and later return; its inject callback may
    // therefore run more than once. Guarding the callback body records a failed
    // registration instead of letting the declaration-lifetime effect throw
    // asynchronously into the page.
    function guardedCallback(where, fn) {
      return function () {
        try {
          return fn()
        } catch (error) {
          diagnostics.errors.push({
            where,
            message: String(error && error.message ? error.message : error),
          })
          return function () {}
        }
      }
    }

    const SURFACE_CHUNKS = [
      './client.locales.js',
      './client.styles.js',
      './client.helpers.js',
      './client.cards.js',
      './client.toolview.js',
      './client.denied.js',
      './client.mode.js',
      './client.dock.js',
      './client.overlay.js',
    ]

    return {
      inject: ['slots', 'locale'],
      async apply(ctx) {
        diagnostics.applied = true
        if (typeof require.async !== 'function') {
          throw new Error('dsh-tower-ui: requires the DSH client module system (require.async)')
        }

        // Load every package-local surface chunk once. The entry cannot require
        // a sibling synchronously, so the split surfaces arrive before the first
        // registration and a missing chunk fails the client half loudly.
        const loaded = await Promise.all(SURFACE_CHUNKS.map((file) => require.async(file)))
        const [
          locales,
          styles,
          helpersModule,
          cardsModule,
          toolviewModule,
          deniedModule,
          modeModule,
          dockModule,
          overlayModule,
        ] = loaded

        const { translate, toolLabel, seatT, EN, ZH } = locales
        const { ST, dotStyle } = styles
        const helpers = helpersModule.createHelpers(translate)
        const mode = modeModule.createModeStore(diagnostics, helpers)
        const env = { React, h, translate, toolLabel, seatT, ST, dotStyle, helpers, mode }
        env.modeModelFromLegacy = modeModule.modeModelFromLegacy
        env.cards = cardsModule.createCards(env)
        const overlay = overlayModule.createOverlay(env)

        // One auto-dismiss timer for the overlay strip, owned by ctx.effect.
        let dismissTimer = null
        function publishNotice(notice) {
          if (!helpers.isPlainObject(notice)) return
          overlay.setNotice(Object.assign({}, notice, { seq: Date.now() }))
          if (dismissTimer !== null) clearTimeout(dismissTimer)
          dismissTimer = setTimeout(function () {
            dismissTimer = null
            overlay.setNotice(null)
          }, NOTICE_MS)
        }
        env.notice = { source: overlay.source, publish: publishNotice }
        const toolview = toolviewModule.createToolview(env)
        const denied = deniedModule.createDenied(env)
        const dock = dockModule.createDock(env)

        // Locale dictionaries for the slot entries' bound `t` seat.
        guard('locale', function () {
          return ctx.effect(
            function () {
              return ctx.locale.register(NS, { en: EN, zh: ZH })
            },
            'tower-ui: dictionaries',
          )
        })
        guard('timer', function () {
          return ctx.effect(
            function () {
              return function () {
                if (dismissTimer !== null) {
                  clearTimeout(dismissTimer)
                  dismissTimer = null
                }
              }
            },
            'tower-ui: status strip timer',
          )
        })

        // 1. Keyed per-tool cards. `key` is the wire tool name selected by the
        //    Chat tool-call tree through `entryKey`.
        for (const tool of helpers.TOOL_NAMES) {
          guard('toolview:' + tool, function () {
            return ctx.slots.inject(
              'tool.call.toolview',
              guardedCallback('toolview:' + tool, function () {
                const dispose = ctx.slots.register(
                  {
                    name: 'tool.call.toolview',
                    key: tool,
                    locale: NS,
                  },
                  toolview.TowerToolCard,
                )
                if (!diagnostics.toolviews.includes(tool)) diagnostics.toolviews.push(tool)
                recordSlot('tool.call.toolview', { key: tool })
                return dispose
              }),
            )
          })
        }

        // 2. Composer dock: hint until this conversation has a Tower tool result.
        guard('dock', function () {
          return ctx.slots.inject(
            'conversation.composer.dock',
            guardedCallback('dock', function () {
              const dispose = ctx.slots.register(
                {
                  name: 'conversation.composer.dock',
                  id: 'tower-hint',
                  order: 6,
                  locale: NS,
                },
                dock.TowerDock,
              )
              recordSlot('conversation.composer.dock', { id: 'tower-hint', order: 6 })
              return dispose
            }),
          )
        })

        // 3. Shell overlay: transient start/result strip, pointer-transparent.
        guard('overlay', function () {
          return ctx.slots.inject(
            'shell.overlay',
            guardedCallback('overlay', function () {
              const dispose = ctx.slots.register(
                {
                  name: 'shell.overlay',
                  id: 'tower-status-strip',
                  order: 20,
                  locale: NS,
                  inject: function () {
                    return { hooks: { towerNotice: overlay.source } }
                  },
                },
                overlay.TowerStatusStrip,
              )
              recordSlot('shell.overlay', { id: 'tower-status-strip', order: 20 })
              return dispose
            }),
          )
        })

        // 4. Mode-aware denied-tool rows (#12). The dock publishes the Tower
        //    stance it derives from the displayed session's history; while it
        //    is on, shadow the denied tools' native keyed views at a lower
        //    priority (the slot core renders the lowest priority). Disposing
        //    these entries restores the native views exactly when mode is off.
        guard('denied-toolviews', function () {
          return ctx.slots.inject(
            'tool.call.toolview',
            guardedCallback('denied-toolviews', function () {
              const disposers = new Map()
              let currentKey = null
              const reconcile = function () {
                const currentMode = mode.modeSnapshot()
                const active = currentMode.known === true && currentMode.on === true
                const names = active ? denied.deniedNames(currentMode.denied) : []
                const nextKey = names.join('\n')
                if (nextKey === currentKey) return
                currentKey = nextKey
                for (const name of Array.from(disposers.keys())) {
                  if (names.includes(name)) continue
                  const dispose = disposers.get(name)
                  disposers.delete(name)
                  try {
                    if (typeof dispose === 'function') dispose()
                  } catch (error) {
                    diagnostics.errors.push({
                      where: 'denied-toolview-dispose:' + name,
                      message: String(error && error.message ? error.message : error),
                    })
                  }
                }
                for (const name of names) {
                  if (disposers.has(name)) continue
                  try {
                    disposers.set(
                      name,
                      ctx.slots.register(
                        {
                          name: 'tool.call.toolview',
                          key: name,
                          priority: DENIED_PRIORITY,
                          locale: NS,
                        },
                        denied.DeniedToolRow,
                      ),
                    )
                  } catch (error) {
                    diagnostics.errors.push({
                      where: 'denied-toolview:' + name,
                      message: String(error && error.message ? error.message : error),
                    })
                  }
                }
                diagnostics.denied = { active, keys: names.slice() }
                recordSlot('tool.call.toolview', { denied: names.slice(), priority: DENIED_PRIORITY })
              }
              const unsubscribe = mode.subscribeMode(reconcile)
              reconcile()
              return function () {
                try {
                  unsubscribe()
                } catch (error) {
                  /* already disposed */
                }
                for (const dispose of Array.from(disposers.values())) {
                  try {
                    if (typeof dispose === 'function') dispose()
                  } catch (error) {
                    /* registration already gone */
                  }
                }
                disposers.clear()
                currentKey = null
              }
            }),
          )
        })
      },
    }
  },
})
