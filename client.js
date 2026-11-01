// dsh-tower — core Web Client half.
//
// The Host half of the bundle declares the profile config schema; this module
// adds the one editable control the Plugins page needs: a section in the
// `plugins.bundle.config` keyed slot for the `dsh-tower` bundle. The section is
// a single three-option radio group (off / optional / required) rendered from
// the Host-owned settings form. There is deliberately no component row for the
// review policy: rows are on/off capabilities, while the policy is one value
// with three states.
//
// Saving goes through `ctx.configForms.get('tower-host')` (the Host entry id in
// cordis.patch.yml). One `mutate([...])` call writes both review keys:
// `review.mode` becomes the selected value and the deprecated scalar alias
// `review.requireReview` is normalized to `false`, so the stored profile patch
// can never contain a contradiction. The Host schema marks both keys volatile, so
// the accepted values are reflected in place without reloading the plugin.
//
// The displayed selection is the *resolved* policy, not just `review.mode`: the
// alias decides when `mode` is absent, exactly like `resolveReviewPolicy` in
// domain/integration/review.js.
//
// No build step, no new dependency, no Host/Client package imports: React comes
// from the browser module table and theme colors use `--dsw-alias-*` tokens.
window.__ModuleLoader__.load({
  id: 'dsh-tower',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'dsh-tower'
    const HOST_ENTRY = 'tower-host'
    const MODES = ['off', 'optional', 'required']
    const DEFAULT_MODE = 'optional'

    const EN = {
      'config.title': 'Review policy',
      'config.intro': 'Choose how Tower treats review for this profile. This choice is saved immediately.',
      'config.current': 'Current choice: {mode}',
      'config.loading': 'Loading the saved review policy…',
      'config.unavailable': 'The review policy cannot be changed here right now. Try again later, or open the Tower host settings.',
      'config.readonly': 'This review policy is read-only in the current profile.',
      'config.saving': 'Saving…',
      'config.saved': 'Saved.',
      'config.saveFailed': 'The new choice could not be saved; the previous policy is still in effect.',
      'config.off.label': 'Off',
      'config.off.description': 'Review is unavailable: no review can be recorded, and merges never wait for one.',
      'config.optional.label': 'Optional',
      'config.optional.description': 'Review is available, but it never blocks a merge.',
      'config.required.label': 'Required',
      'config.required.description': 'A clean review at the branch tip blocks merge; the reviewer preset is required.',
      'config.restartHint':
        'This profile started with review off, so the merge gate already uses the new choice but the review tool appears only after a restart (or a profile reload).',
    }

    const ZH = {
      'config.title': '审查策略',
      'config.intro': '选择 Tower 为此配置处理审查的方式，选择后会立即保存。',
      'config.current': '当前选择：{mode}',
      'config.loading': '正在加载已保存的审查策略…',
      'config.unavailable': '暂时无法在此修改审查策略，请稍后再试，或打开 Tower 主机设置。',
      'config.readonly': '当前配置下审查策略为只读。',
      'config.saving': '正在保存…',
      'config.saved': '已保存。',
      'config.saveFailed': '新选择未能保存，仍使用之前的审查策略。',
      'config.off.label': '关闭',
      'config.off.description': '审查不可用：无法记录审查，合并也不会等待审查。',
      'config.optional.label': '可选',
      'config.optional.description': '审查可用，但不会阻止合并。',
      'config.required.label': '必需',
      'config.required.description': '分支末端的干净审查会阻止合并；需要审查代理预设。',
      'config.restartHint':
        '此配置启动时审查为关闭状态：合并门禁已使用新的选择，但审查工具需要重启（或重新加载配置）后才会出现。',
    }

    function fill(text, params) {
      return String(text ?? '').replace(/\{([A-Za-z0-9_]+)\}/g, (match, key) =>
        params && params[key] !== undefined ? String(params[key]) : match,
      )
    }

    function makeT(props) {
      const seat = props && typeof props.t === 'function' ? props.t : null
      return function t(key, params) {
        if (seat) {
          try {
            const value = seat(key, params)
            if (typeof value === 'string') return value
          } catch {
            /* fall back to the bundled English dictionary */
          }
        }
        return fill(EN[key] !== undefined ? EN[key] : key, params)
      }
    }

    function readForm(props) {
      return props && props.form && typeof props.form.getSnapshot === 'function' ? props.form : null
    }

    function safeSnapshot(form) {
      if (!form) return null
      try {
        return form.getSnapshot() ?? null
      } catch {
        return null
      }
    }

    // The resolved policy: an explicit `mode` wins; otherwise the deprecated
    // boolean alias decides (true -> required, false -> optional), like
    // `resolveReviewPolicy`. Only a literal `true` can raise the mode, which is
    // also the only value the resolver accepts beside a non-required mode.
    function currentMode(snapshot) {
      const review = (snapshot && snapshot.value && snapshot.value.review) || {}
      if (MODES.includes(review.mode)) return review.mode
      return review.requireReview === true ? 'required' : DEFAULT_MODE
    }

    // Both review keys are written together: the selected mode, plus the alias
    // normalized to `false`. An explicit `false` is required — leaving the key
    // unset would restore the inherited default, and a stale `true` would
    // contradict a non-required mode and make `resolveTowerConfig` throw.
    function reviewOps(mode) {
      return [
        { op: 'set', path: ['review', 'mode'], value: mode },
        { op: 'set', path: ['review', 'requireReview'], value: false },
      ]
    }

    function ReviewPolicySection(props) {
      const t = makeT(props)
      const form = readForm(props)
      const [snapshot, setSnapshot] = React.useState(function () {
        return safeSnapshot(form)
      })
      const [pending, setPending] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      // The policy this page first saw. A session whose profile started with
      // review off never registered the review tool, so switching to
      // optional/required takes effect at the merge gate immediately but needs a
      // restart (or profile reload) before the tool exists. The control states
      // that limitation instead of pretending the tool appeared.
      const startMode = React.useRef(null)

      React.useEffect(
        function () {
          if (!form) return undefined
          const update = function () {
            const next = safeSnapshot(form)
            if (startMode.current === null && next && next.status === 'ready') {
              startMode.current = currentMode(next)
            }
            setSnapshot(next)
          }
          update()
          let unsubscribe
          try {
            unsubscribe = form.subscribe(update)
          } catch {
            unsubscribe = undefined
          }
          return function () {
            if (typeof unsubscribe === 'function') unsubscribe()
          }
        },
        [form],
      )

      const status = snapshot && typeof snapshot.status === 'string' ? snapshot.status : 'unavailable'
      const writable = status === 'ready' && snapshot.writable !== false
      const selection = currentMode(snapshot)
      const restartNeeded = notice === 'saved' && startMode.current === 'off' && selection !== 'off'

      function choose(next) {
        if (!form || !writable || pending || next === selection) return
        setPending(next)
        setNotice(null)
        let result
        try {
          result = form.mutate(reviewOps(next), snapshot ? snapshot.revision : undefined)
        } catch {
          setPending(null)
          setNotice('saveFailed')
          return
        }
        Promise.resolve(result).then(
          function (accepted) {
            setPending(null)
            setSnapshot(safeSnapshot(form))
            setNotice(accepted === false ? 'saveFailed' : 'saved')
          },
          function () {
            setPending(null)
            setSnapshot(safeSnapshot(form))
            setNotice('saveFailed')
          },
        )
      }

      const statusText =
        status === 'loading'
          ? t('config.loading')
          : status !== 'ready'
            ? t('config.unavailable')
            : snapshot && snapshot.writable === false
              ? t('config.readonly')
              : ''

      return h(
        'section',
        {
          'data-dsh-tower-review-policy': '',
          style: {
            display: 'grid',
            gap: '10px',
            padding: '16px',
            border: '1px solid var(--dsw-alias-border-l2)',
            borderRadius: '8px',
            background: 'var(--dsw-alias-bg-module-platform)',
          },
        },
        h('div', { style: { color: 'var(--dsw-alias-label-primary)', fontWeight: 600 } }, t('config.title')),
        h('p', { style: { margin: 0, color: 'var(--dsw-alias-label-secondary)', fontSize: '13px' } }, t('config.intro')),
        h(
          'div',
          {
            role: 'radiogroup',
            'aria-label': t('config.title'),
            style: { display: 'grid', gap: '8px' },
          },
          MODES.map(function (mode) {
            const active = selection === mode
            return h(
              'label',
              {
                key: mode,
                'data-mode': mode,
                style: {
                  display: 'grid',
                  gridTemplateColumns: 'auto 1fr',
                  gap: '8px',
                  alignItems: 'start',
                  padding: '8px',
                  borderRadius: '6px',
                  cursor: writable && !pending ? 'pointer' : 'default',
                  border: active ? '1px solid var(--dsw-alias-label-primary)' : '1px solid var(--dsw-alias-border-l2)',
                },
              },
              h('input', {
                type: 'radio',
                name: 'dsh-tower-review-policy',
                value: mode,
                checked: active,
                disabled: !writable || Boolean(pending),
                onChange: function () {
                  choose(mode)
                },
              }),
              h(
                'span',
                { style: { display: 'grid', gap: '2px' } },
                h('span', { style: { color: 'var(--dsw-alias-label-primary)', fontWeight: 500 } }, t(`config.${mode}.label`)),
                h('span', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: '13px' } }, t(`config.${mode}.description`)),
              ),
            )
          }),
        ),
        statusText
          ? h('p', { style: { margin: 0, color: 'var(--dsw-alias-label-secondary)', fontSize: '13px' } }, statusText)
          : null,
        h(
          'p',
          {
            role: 'status',
            'aria-live': 'polite',
            style: { margin: 0, color: 'var(--dsw-alias-label-secondary)', fontSize: '13px', minHeight: '18px' },
          },
          pending ? t('config.saving') : notice ? t(`config.${notice}`) : t('config.current', { mode: t(`config.${selection}.label`) }),
        ),
        restartNeeded
          ? h(
              'p',
              {
                'data-dsh-tower-restart-hint': '',
                style: { margin: 0, color: 'var(--dsw-alias-label-secondary)', fontSize: '13px' },
              },
              t('config.restartHint'),
            )
          : null,
      )
    }

    return {
      inject: ['slots', 'locale'],
      async apply(ctx) {
        ctx.effect(function () {
          return ctx.locale.register(NS, { en: EN, zh: ZH })
        }, 'dsh-tower: review policy settings')
        ctx.slots.inject('plugins.bundle.config', function () {
          return ctx.slots.register(
            {
              name: 'plugins.bundle.config',
              key: 'dsh-tower',
              locale: NS,
              inject: function () {
                let forms
                try {
                  forms = typeof ctx.get === 'function' ? ctx.get('configForms') : undefined
                } catch {
                  forms = undefined
                }
                const form = forms && typeof forms.get === 'function' ? forms.get(HOST_ENTRY) : undefined
                return { form }
              },
            },
            ReviewPolicySection,
          )
        })
      },
    }
  },
})
