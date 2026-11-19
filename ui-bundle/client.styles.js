// dsh-tower-ui 0.2.2 — the inline style table.
//
// Theme references are restricted to `--dsw-alias-*` tokens. Chunk (#71).
window.__ModuleLoader__.load({
  id: 'dsh-tower-ui',
  chunk: 'client.styles.js',
  factory() {
    const TONE = {
      ok: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
      none: 'var(--dsw-alias-label-tertiary)',
    }
    // #197: the composer dock row is the native `StatsPills` pill. The installed
    // shell's `StatsPills.module.css` is a borderless, transparent inline-flex
    // pill: `font: inherit` from the appearance-scaled anchor type, a 20px line
    // box, 6px gap, 1px 8px padding and `--dsw-radius-sm` (reserved for a hover
    // surface the native pill only gets when it is a button). The type
    // expressions are the native anchor's, not local px values.
    const dockPill = {
      boxSizing: 'border-box',
      display: 'inline-flex',
      alignItems: 'center',
      gap: '6px',
      maxWidth: '100%',
      minWidth: 0,
      padding: '1px 8px',
      border: 'none',
      borderRadius: 'var(--dsw-radius-sm)',
      background: '0 0',
      color: 'var(--dsw-alias-label-tertiary)',
      font: 'inherit',
      fontVariantNumeric: 'tabular-nums',
      fontSize: 'calc(var(--dsh-content-font-size-secondary, 13px) - 1px)',
      lineHeight: 'calc(20px + var(--dsh-content-font-delta-secondary, 0px))',
      whiteSpace: 'nowrap',
    }
    const ST = {
      // Native row summary geometry: the 2px caption dot between the title and
      // a one-line ellipsized summary whose type scales with the appearance
      // text-size setting (the live variables the native `ToolRow.module.css`
      // uses), so the row stays pixel-identical at any content font size.
      sep: {
        flex: 'none',
        width: '2px',
        height: '2px',
        margin: '0 8px',
        borderRadius: '1px',
        background: 'var(--dsw-alias-label-caption)',
      },
      summary: {
        flex: 'auto',
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        color: 'var(--dsw-alias-label-tertiary)',
        fontSize: 'var(--dsh-content-font-size-secondary, 13px)',
        lineHeight: 'calc(24px + var(--dsh-content-font-delta, 0px))',
      },
      // The mode-blocked row summary keeps the native row geometry and takes
      // the state text tokens the host uses for warning/error captions.
      summaryWarn: { color: 'var(--dsw-alias-state-warn-label)' },
      summaryError: { color: 'var(--dsw-alias-state-error-primary)' },
      // Expanded body: the native generic tool-result surface, token for token
      // from the host `ToolRow.module.css` (`bodyWrap`/`ioCard`/`ioSection`/
      // `ioLabel`/`ioText`/`ioDivider`). The open card must look like the row
      // the host renders for a generic tool result: the border, code-block
      // background and `font` shorthand are what give it the native surface and
      // type scale. Never pin a px font size or a hex/rgb colour here — the
      // `font` shorthand and the `--dsw-*` tokens follow the appearance
      // text-size setting and the light/dark theme.
      bodyWrap: { display: 'flex', flexDirection: 'column' },
      ioCard: {
        border: '.5px solid var(--dsw-alias-border-l1)',
        borderRadius: 'var(--dsw-radius-lg)',
        background: 'var(--dsw-alias-markdown-code-block)',
        font: 'var(--dsw-font-markdown-code-block-small)',
        flexDirection: 'column',
        margin: '4px 0 4px 4px',
        display: 'flex',
      },
      ioSection: {
        gridTemplateColumns: 'max-content 1fr',
        alignItems: 'baseline',
        columnGap: '14px',
        maxHeight: '150px',
        padding: '12px 16px',
        display: 'grid',
        overflowY: 'auto',
      },
      ioLabel: { color: 'var(--dsw-alias-label-caption)', alignSelf: 'start', position: 'sticky', top: 0 },
      ioText: {
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        overflowWrap: 'anywhere',
        minWidth: 0,
        color: 'var(--dsw-alias-label-secondary)',
      },
      ioTextError: { color: 'var(--dsw-alias-state-error-primary)' },
      ioDivider: { background: 'var(--dsw-alias-border-l2)', flex: 'none', height: '.5px' },
      // #195: the expanded body is one native-like scroll region (the host
      // `bodyScroll` cap) instead of a fixed row count, so a card with more
      // curated rows than fit is still complete.
      bodyScroll: { maxHeight: '260px', overflowY: 'auto' },
      // #195: a repository path in a row value is a real affordance — the native
      // `fileLink` dotted underline, no local chrome, and the io-card type scale.
      fileLink: {
        font: 'inherit',
        color: 'inherit',
        padding: 0,
        border: 'none',
        background: 'none',
        textAlign: 'left',
        textDecoration: 'underline dotted',
        textUnderlineOffset: '2px',
        cursor: 'pointer',
        minWidth: 0,
        overflowWrap: 'anywhere',
      },
      // #195: the native inspect pill (`row.inspect`), rendered only while open
      // and only when the owner supplied `inspect`.
      inspectButton: {
        alignSelf: 'flex-start',
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        margin: '4px 0 2px 4px',
        padding: '2px 8px',
        border: '.5px solid var(--dsw-alias-border-l3)',
        borderRadius: '999px',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-secondary)',
        cursor: 'pointer',
        font: 'inherit',
        lineHeight: '16px',
      },
      // #195: an image result keeps the native image block sizing; the loader is
      // only consulted for a result that actually declares image content.
      imageBody: { display: 'flex', flexDirection: 'column', gap: '8px', padding: '12px 16px', minWidth: 0 },
      image: { maxWidth: '100%', maxHeight: '240px', display: 'block', objectFit: 'contain' },
      imageMeta: { color: 'var(--dsw-alias-label-tertiary)', overflowWrap: 'anywhere' },
      dim: {
        color: 'var(--dsw-alias-label-tertiary)',
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      rowError: { color: 'var(--dsw-alias-state-error-primary)' },
      // A non-interactive status stays a plain label (dot + text): the hint,
      // the summary and the mode chip share the native pill geometry and never
      // render a border, a fill or a hover treatment.
      hint: Object.assign({}, dockPill, { userSelect: 'none' }),
      dock: dockPill,
      dockTool: { color: 'var(--dsw-alias-label-secondary)', flex: 'none' },
      dockText: {
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        color: 'var(--dsw-alias-label-tertiary)',
      },
      // #196: the shell.overlay strip is the native toast surface: top-center
      // at the native 40px offset (never over the composer), the toast
      // radius/background/label/shadow tokens, the native 14px/22px type and
      // the native `min(640px, 100vw - 48px)` width. The shell overlay layer
      // already owns the stacking order, so this surface declares no z-index.
      stripWrap: {
        position: 'fixed',
        top: '40px',
        left: '50%',
        transform: 'translateX(-50%)',
        width: 'max-content',
        maxWidth: 'min(640px, calc(100vw - 48px))',
        pointerEvents: 'none',
      },
      stripCard: {
        pointerEvents: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        maxWidth: '100%',
        minWidth: 0,
        padding: '12px 16px',
        border: 'none',
        borderRadius: 'var(--dsw-radius-lg)',
        background: 'var(--dsw-alias-toast-bg)',
        color: 'var(--dsw-alias-toast-label)',
        fontSize: '14px',
        lineHeight: '22px',
        boxShadow: 'var(--dsw-shadow-lv3)',
        overflow: 'hidden',
      },
      stripText: {
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      modeChip: Object.assign({}, dockPill, { userSelect: 'none' }),
      modeChipLabel: { color: 'var(--dsw-alias-label-primary)' },
      modeChipOn: { color: 'var(--dsw-alias-state-success-primary)' },
    }
    function dotStyle(tone) {
      return {
        width: '6px',
        height: '6px',
        flex: 'none',
        borderRadius: '999px',
        background: TONE[tone] || TONE.none,
      }
    }

    // #196: the native bundles inject their module CSS from the chunk factory —
    // a tagged <style> created at materialization, idempotent by
    // `data-plugin-css` and owned by the loader's style registry. The Module
    // Loader has no `styles` service for factory bundles (that closure is only
    // passed to dynamic cordis packages), so the factory is the native
    // injection point. Without a document (SSR/tests) the class is inert: the
    // inline layout still renders and the motion is an enhancement, not a
    // requirement.
    const STRIP_CLASS = 'dsh-tower-status-strip'
    const STRIP_CSS_ID = 'dsh-tower-ui/status-strip.css'
    // Native toast motion: a 160ms rise, then the hold-then-fade exit. Under
    // `prefers-reduced-motion: reduce` the entry and its translate are dropped
    // (the native rule keeps only the opacity fade).
    const STRIP_CSS = [
      '.' + STRIP_CLASS + '{animation:dsh-tower-strip-in .16s ease-out,dsh-tower-strip-fade 1s ease var(--dsh-toast-hold, 3s) forwards}',
      '@keyframes dsh-tower-strip-in{0%{opacity:0;transform:translate(-50%,-6px)}to{opacity:1;transform:translate(-50%)}}',
      '@keyframes dsh-tower-strip-fade{to{opacity:0;visibility:hidden}}',
      '@media (prefers-reduced-motion: reduce){.' + STRIP_CLASS + '{animation:dsh-tower-strip-fade 1s ease var(--dsh-toast-hold, 3s) forwards}}',
    ].join('\n')
    if (
      typeof document !== 'undefined' &&
      document.querySelector('style[data-plugin-css=' + JSON.stringify(STRIP_CSS_ID) + ']') === null
    ) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-tower-ui'
      tag.dataset.pluginCss = STRIP_CSS_ID
      tag.textContent = STRIP_CSS
      document.head.appendChild(tag)
    }

    return { TONE, ST, dotStyle, STRIP_CLASS, STRIP_CSS, STRIP_CSS_ID }
  },
})
