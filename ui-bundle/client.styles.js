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
      header: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 },
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
        minWidth: 0,
        color: 'var(--dsw-alias-label-secondary)',
      },
      ioTextError: { color: 'var(--dsw-alias-state-error-primary)' },
      ioDivider: { background: 'var(--dsw-alias-border-l2)', flex: 'none', height: '.5px' },
      title: { color: 'var(--dsw-alias-label-primary)', flex: 'none' },
      dim: {
        color: 'var(--dsw-alias-label-tertiary)',
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      row: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      rowError: { color: 'var(--dsw-alias-state-error-primary)' },
      hint: {
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
      dock: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        minWidth: 0,
        maxWidth: '100%',
        padding: '1px 8px',
        fontSize: '11px',
        lineHeight: '18px',
        color: 'var(--dsw-alias-label-tertiary)',
        whiteSpace: 'nowrap',
      },
      dockTool: { color: 'var(--dsw-alias-label-secondary)', flex: 'none' },
      dockText: {
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        color: 'var(--dsw-alias-label-tertiary)',
      },
      stripWrap: {
        position: 'fixed',
        left: '50%',
        bottom: '16px',
        transform: 'translateX(-50%)',
        display: 'flex',
        justifyContent: 'center',
        pointerEvents: 'none',
        zIndex: 9100,
        maxWidth: 'calc(100vw - 32px)',
      },
      stripCard: {
        pointerEvents: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        maxWidth: '100%',
        padding: '4px 10px',
        border: '0.5px solid var(--dsw-alias-border-l1)',
        borderRadius: '999px',
        background: 'var(--dsw-alias-bg-overlay)',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: '12px',
        lineHeight: '18px',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      },
      modeChip: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        padding: '0 8px',
        border: '0.5px solid var(--dsw-alias-border-l2)',
        borderRadius: '999px',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: '11px',
        lineHeight: '18px',
        whiteSpace: 'nowrap',
        userSelect: 'none',
      },
      modeChipLabel: { color: 'var(--dsw-alias-label-primary)' },
      modeChipOn: { color: 'var(--dsw-alias-state-success-primary)' },
      denyCard: {
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
        minWidth: 0,
        maxWidth: '100%',
        boxSizing: 'border-box',
        margin: '2px 0 2px 4px',
        padding: '8px 10px',
        border: '0.5px solid var(--dsw-alias-border-l2)',
        borderRadius: '8px',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: '12px',
        lineHeight: '18px',
      },
      denyLabel: { color: 'var(--dsw-alias-state-warn-primary)', flex: 'none' },
      denyHint: { color: 'var(--dsw-alias-label-tertiary)' },
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

    return { TONE, ST, dotStyle }
  },
})
