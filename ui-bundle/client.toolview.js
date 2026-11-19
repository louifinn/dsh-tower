// dsh-tower-ui 0.2.2 — the toolview card surface (one keyed view per tool).
//
// A keyed `tool.call.toolview` entry REPLACES the native tool row (the host
// renderSlot in `dsh-client-ui-tool` only falls back when no keyed entry
// matches), so this chunk renders the native chrome itself: the UI-primitives
// `DisclosureRow` from the shell's static module table, driven by the
// host-supplied `useDisclosure()` seat hook (`{ expanded, toggle }`) exactly
// like the native `ToolRow`. Collapsed, it is the native row (icon, title,
// one-line summary, hover chevron); the curated detail rows live only in
// `children`, and `DisclosureRow` renders `open && children`, so the body
// exists only while expanded. The lifecycle transitions still publish into the
// notice store the root-scoped overlay injects. Package-local chunk (#71).
window.__ModuleLoader__.load({
  id: 'dsh-tower-ui',
  chunk: 'client.toolview.js',
  factory() {
    function createToolview(env) {
      const { React, h, translate, toolLabel, seatT, ST, helpers, cards, notice, primitives } = env
      const { isTowerTool, parsePayload, isPlainObject, truncate, imagesOfBlock } = helpers
      const { rowElement, cardModel } = cards
      const publishNotice = notice.publish
      // Resolved once by the entry from the browser module table; the host
      // primitives namespace is a static seed word, not a package dependency.
      const DisclosureRow = primitives.DisclosureRow
      const RowIcon = primitives.IconChecklistOutlineRegular
      const InspectIcon = primitives.IconInspectOutlineRegular
      function noop() {}

      // Mounting an already-settled result (history) stays silent; a live
      // preparing/start row and a start→result transition publish.
      function useToolviewLifecycle(props) {
        const phase = props ? props.phase : undefined
        const toolName = props ? props.toolName : undefined
        const callId = props ? props.callId : undefined
        const failed = Boolean(props && props.block && (props.block.isError === true || isPlainObject(props.block.error)))
        const previous = React.useRef ? React.useRef(null) : { current: null }
        React.useEffect(
          function () {
            const before = previous.current
            previous.current = { phase, callId }
            if (!isTowerTool(toolName)) return
            const sameCall = before !== null && before.callId === callId
            if (phase !== 'result') {
              if (!sameCall || before.phase !== phase) publishNotice({ tool: toolName, running: true })
            } else if (sameCall && before.phase !== 'result') {
              publishNotice({ tool: toolName, running: false, ok: failed !== true })
            }
          },
          [phase, callId, toolName, failed],
        )
      }

      // #195: a result that declares image content is previewed through the
      // owner's `loadImage` (the native image block does the same), never by
      // dumping the payload as text. `peek` gives an already-cached URL its
      // synchronous first paint, exactly like the native message image.
      function ImagePreview(props) {
        const t = props.t
        const image = props.image
        const loadImage = props.loadImage
        let peeked = null
        try {
          peeked = typeof loadImage.peek === 'function' ? loadImage.peek(image.attachment) : null
        } catch (error) {
          peeked = null
        }
        const urlState = React.useState(typeof peeked === 'string' && peeked !== '' ? peeked : null)
        const url = urlState[0]
        const setUrl = urlState[1]
        const failedState = React.useState(false)
        const failed = failedState[0]
        const setFailed = failedState[1]
        React.useEffect(
          function () {
            let live = true
            if (url === null) {
              try {
                const pending = loadImage(image.attachment)
                if (pending && typeof pending.then === 'function') {
                  pending.then(
                    function (value) {
                      if (live && typeof value === 'string' && value !== '') setUrl(value)
                    },
                    function () {
                      if (live) setFailed(true)
                    },
                  )
                }
              } catch (error) {
                setFailed(true)
              }
            }
            return function () {
              live = false
            }
          },
          [image.attachment],
        )
        const width = typeof image.attachment.width === 'number' ? image.attachment.width : '?'
        const height = typeof image.attachment.height === 'number' ? image.attachment.height : '?'
        const meta = translate(t, 'card.imageMeta', { name: image.name, width, height })
        let caption = meta
        if (failed === true) caption = meta + translate(t, 'card.sep') + translate(t, 'card.imageFailed')
        else if (url === null) caption = meta + translate(t, 'card.sep') + translate(t, 'card.imageLoading')
        return h(
          'span',
          { key: 'image', style: ST.ioText, 'data-tower-image': image.name },
          url !== null ? h('img', { src: url, alt: image.name, style: ST.image }) : null,
          h('span', { key: 'meta', style: ST.imageMeta }, caption),
        )
      }

      function TowerToolCard(props) {
        const t = seatT(props)
        const toolName = props && typeof props.toolName === 'string' ? props.toolName : ''
        const phase = props && typeof props.phase === 'string' ? props.phase : 'start'
        const running = phase !== 'result'
        // `ToolCall` always supplies the seat hook; the fallback keeps an
        // unexpected caller collapsed instead of throwing.
        const disclosure = typeof props.useDisclosure === 'function' ? props.useDisclosure() : null
        const expanded = Boolean(disclosure && disclosure.expanded === true)
        const toggle = disclosure && typeof disclosure.toggle === 'function' ? disclosure.toggle : noop
        // The documented owner props for a tool row (#195): only a function is
        // an affordance; anything else degrades to plain text (no dead link).
        // `openFile` is the slot's prop; `onOpenFile` is the native ToolRow name
        // kept as an alias.
        const openFile = props ? [props.openFile, props.onOpenFile].find((fn) => typeof fn === 'function') : undefined
        const loadImage = props && typeof props.loadImage === 'function' ? props.loadImage : null
        const inspect = props && typeof props.inspect === 'function' ? props.inspect : null
        useToolviewLifecycle(props)
        let payload = null
        if (!running) payload = parsePayload(props ? props.block : undefined)
        const model = running
          ? { tone: 'idle', headline: translate(t, 'card.running'), rows: [] }
          : cardModel(toolName, payload, t)
        // Only image content declared by the result is previewable; an error or
        // a text result never calls the loader.
        const images = running ? [] : imagesOfBlock(props ? props.block : undefined)
        // Only a settled result is expandable (curated rows, a declared image,
        // or an owner inspect action); native rows use DisclosureRow's row-click.
        const expandable = !running && (model.rows.length > 0 || images.length > 0 || inspect !== null)
        // The open body is the native generic tool-result surface:
        // bodyWrap > bodyScroll > ioCard, one ioSection per curated row, with an
        // ioDivider between adjacent sections. It is built only while open, so
        // the card never exists in the collapsed state. The flat keyed list
        // keeps React keys on both the sections and the dividers.
        const showBody = expanded && expandable
        const rows = showBody ? model.rows.slice() : []
        // A declared image without a loader degrades to a localized row; the
        // loader is never called for a payload that declares no image.
        if (showBody && images.length > 0 && loadImage === null) {
          rows.push({ text: translate(t, 'card.imageUnavailable'), tone: 'warn' })
        }
        const bodyChildren = []
        for (let index = 0; index < rows.length; index += 1) {
          if (index > 0) {
            bodyChildren.push(h('span', { key: 'divider-' + index, 'aria-hidden': true, style: ST.ioDivider }))
          }
          bodyChildren.push(rowElement(t, index, rows[index], openFile))
        }
        if (showBody && images.length > 0 && loadImage !== null) {
          if (bodyChildren.length > 0) {
            bodyChildren.push(h('span', { key: 'divider-images', 'aria-hidden': true, style: ST.ioDivider }))
          }
          const imageChildren = [h('span', { key: 'label', style: ST.ioLabel }, translate(t, 'card.image'))]
          for (let index = 0; index < images.length; index += 1) {
            imageChildren.push(h(ImagePreview, { key: 'image-' + index, image: images[index], loadImage, t }))
          }
          bodyChildren.push(
            h('div', { key: 'images', style: ST.imageBody, 'data-tower-images': String(images.length) }, imageChildren),
          )
        }
        const bodyParts = []
        if (bodyChildren.length > 0) {
          bodyParts.push(h('div', { key: 'scroll', style: ST.bodyScroll }, h('div', { key: 'card', style: ST.ioCard }, bodyChildren)))
        }
        if (showBody && inspect !== null) {
          const inspectChildren = [translate(t, 'tool.inspect')]
          if (InspectIcon) inspectChildren.unshift(h(InspectIcon, { key: 'icon', size: 14 }))
          bodyParts.push(
            h(
              'button',
              {
                key: 'inspect',
                type: 'button',
                'data-tower-inspect': 'true',
                title: translate(t, 'card.inspectPayload'),
                'aria-label': translate(t, 'card.inspectPayload'),
                style: ST.inspectButton,
                onClick: inspect,
              },
              inspectChildren,
            ),
          )
        }
        return h(
          'div',
          {
            'data-tower-toolview': toolName === '' ? 'tower_unknown' : toolName,
            'data-tower-phase': phase,
          },
          h(DisclosureRow, {
            icon: RowIcon ? h(RowIcon, { size: 14 }) : undefined,
            title: toolLabel(t, toolName),
            running,
            open: expanded && expandable,
            expandable,
            expandOnRowClick: true,
            keepContentWhenOpen: true,
            onToggle: toggle,
            collapsedContent: [
              h('span', { key: 'sep', 'aria-hidden': true, 'data-shimmer-decoration': true, style: ST.sep }),
              h(
                'span',
                { key: 'headline', style: running || model.tone !== 'error' ? ST.summary : Object.assign({}, ST.summary, ST.rowError) },
                truncate(model.headline, 100),
              ),
            ],
            children:
              bodyParts.length > 0 ? h('div', { key: 'body', style: ST.bodyWrap }, bodyParts) : undefined,
          }),
        )
      }

      return { TowerToolCard }
    }

    return { createToolview }
  },
})
