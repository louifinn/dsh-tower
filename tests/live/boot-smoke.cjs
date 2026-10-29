// Live boot smoke: prove that the reproducible live harness can drive a real,
// isolated DSH Web runtime through the resolved Playwright install.
//
//   $env:DSH_LIVE='1'
//   $env:DSH_HOME=(New-Item -ItemType Directory "$env:TEMP\dsh-live").FullName
//   $env:DSH_TEST_URL='http://127.0.0.1:59001/?token=...'
//   npm run test:live -- --script boot-smoke
//
// The first line prints the resolved DSH_HOME and the host version (#47).
// Missing DSH_TEST_URL or a browser that cannot launch is an environment gap:
// the script prints SKIP and exits 0 unless DSH_LIVE_REQUIRE=1 (the nightly CI
// job sets it so a silent skip cannot pass as evidence).
//
// The SUCCESS target is the composer (a contenteditable text box). A shell that
// rendered only the sidebar is a broken boot, not a pass: the first-run Preview
// Notice (#47) can leave the sidebar up while the session never becomes usable.
// After navigation the smoke first waits, bounded, for either the composer or a
// visible Preview Notice button with the exact label "Continue" or "继续"; if the
// notice is there it is clicked and `dismissed:preview-notice` is logged. The
// readiness poll that follows is bounded (DSH_LIVE_BOOT_TIMEOUT_MS overrides the
// 60 s default) and composer-only.
//
// Both "New Session" and "新会话" sidebar markers are detected and logged, so a
// failure artifact shows whether the shell rendered at all and in which
// language. Every run writes tests/live/boot-smoke.png and
// tests/live/boot-smoke.log; a failure also logs a redacted body snippet and the
// full non-benign page/console errors, so a CI-only failure is diagnosable from
// the artifact alone.
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const env = require('./_env.cjs')
const {
  CHOOSE_WORKSPACE_MARKERS,
  DEFAULT_BOOT_TIMEOUT_MS,
  NEW_SESSION_MARKERS,
  PREVIEW_NOTICE_LABELS,
  PREVIEW_NOTICE_WAIT_MS,
  SNIPPET_CHARS,
  SUCCESS_SNIPPET_CHARS,
  isPreviewNoticeLabel,
  newSessionSignals,
  parseBootTimeoutMs,
  redactSnippet,
  redactTokens,
} = require('./_boot-diagnostics.cjs')

env.announce()

const { loadOrExit } = require('./resolve-playwright.cjs')

const COMPOSER_SELECTOR =
  'div[role="textbox"][contenteditable="true"], textarea[contenteditable], [contenteditable="true"]'
const URL = process.env.DSH_TEST_URL
const REQUIRE = process.env.DSH_LIVE_REQUIRE === '1'
const OUT = __dirname
const LOG = path.join(OUT, 'boot-smoke.log')
const TIMEOUT_RAW = process.env.DSH_LIVE_BOOT_TIMEOUT_MS
const TIMEOUT_MS = parseBootTimeoutMs(TIMEOUT_RAW)

fs.writeFileSync(LOG, '')
const log = (message) => {
  const line = `[${new Date().toISOString()}] ${message}`
  fs.appendFileSync(LOG, `${line}\n`)
  console.log(line)
}

function skip(reason) {
  log(`SKIP live boot smoke: ${reason}`)
  if (REQUIRE) {
    console.error('live boot smoke: DSH_LIVE_REQUIRE=1, so this skip is a failure.')
    process.exit(1)
  }
  process.exit(0)
}

if (!URL) {
  skip('DSH_TEST_URL is not set; boot an isolated server first (tests/README.md, section 2)')
}

const { playwright } = loadOrExit()
const { chromium } = playwright

const BENIGN_CONSOLE = [/favicon/i, /ResizeObserver loop/i, /net::ERR_ABORTED/i]

// Shared in-page predicates. They receive the label marker arrays as an
// argument so the single source of truth stays in _boot-diagnostics.cjs.

/**
 * Wait, bounded, for the first render to show the composer or a Preview Notice
 * button, then click the notice if it is visible.
 *
 * @returns {Promise<{state: 'absent'|'dismissed'|'blocked', label?: string, error?: string}>}
 */
async function dismissPreviewNotice(page) {
  try {
    await page.waitForFunction(
      (args) => {
        if (document.querySelector(args.composerSelector)) return true
        const labelOf = (el) => String((el && (el.innerText || el.textContent)) || '').trim()
        const isVisible = (el) => {
          const rect = el.getBoundingClientRect()
          if (rect.width <= 0 || rect.height <= 0) return false
          const style = window.getComputedStyle(el)
          return style.visibility !== 'hidden' && style.display !== 'none'
        }
        const labels = args.labels.map((label) => label.toLowerCase())
        return Array.from(document.querySelectorAll('button, [role="button"]')).some(
          (el) => isVisible(el) && labels.includes(labelOf(el).toLowerCase()),
        )
      },
      { composerSelector: COMPOSER_SELECTOR, labels: PREVIEW_NOTICE_LABELS },
      { timeout: Math.min(TIMEOUT_MS, PREVIEW_NOTICE_WAIT_MS), polling: 200 },
    )
  } catch {
    // Neither the composer nor the notice arrived in the bounded window; the
    // readiness poll and the diagnostics below still describe the state.
  }
  return page.evaluate((args) => {
    const labelOf = (el) => String((el && (el.innerText || el.textContent)) || '').trim()
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return false
      const style = window.getComputedStyle(el)
      return style.visibility !== 'hidden' && style.display !== 'none'
    }
    const labels = args.labels.map((label) => label.toLowerCase())
    const target = Array.from(document.querySelectorAll('button, [role="button"]')).find(
      (el) => isVisible(el) && labels.includes(labelOf(el).toLowerCase()),
    )
    if (!target) return { state: 'absent' }
    try {
      target.click()
      return { state: 'dismissed', label: labelOf(target) }
    } catch (error) {
      return { state: 'blocked', label: labelOf(target), error: String((error && error.message) || error) }
    }
  }, { labels: PREVIEW_NOTICE_LABELS })
}

;(async () => {
  const startedAt = Date.now()
  log(`launch url=${redactTokens(URL)}`)
  log(
    `boot: waiting up to ${TIMEOUT_MS}ms for the composer ` +
      `(DSH_LIVE_BOOT_TIMEOUT_MS=${TIMEOUT_RAW ?? 'unset, default ' + DEFAULT_BOOT_TIMEOUT_MS})`,
  )
  let browser
  try {
    browser = await chromium.launch({ headless: true, executablePath: env.chromePath() })
  } catch (error) {
    skip(`Playwright could not launch a browser (${String((error && error.message) || error).split('\n')[0]})`)
    return
  }
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  page.setDefaultTimeout(15000)
  const pageErrors = []
  const consoleErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    const text = message.text()
    if (BENIGN_CONSOLE.some((pattern) => pattern.test(text))) return
    consoleErrors.push(text)
  })

  let navigationError = null
  try {
    await page.goto(URL, { waitUntil: 'domcontentloaded' })
  } catch (error) {
    navigationError = redactTokens(String((error && error.message) || error).split('\n')[0])
    log(`navigation: failed (${navigationError})`)
  }

  // The first-run Preview Notice (#47) can park the app before the composer
  // exists. Dismiss it after navigation and before the readiness poll.
  let previewState = 'absent'
  if (!navigationError) {
    try {
      const preview = await dismissPreviewNotice(page)
      previewState = preview.state
      if (preview.state === 'dismissed') {
        log(`dismissed:preview-notice label=${JSON.stringify(preview.label)}`)
      } else if (preview.state === 'blocked') {
        log(`preview-notice: present but could not be clicked (${preview.error})`)
      } else {
        log('preview-notice: absent')
      }
    } catch (error) {
      log(`preview-notice: check failed (${redactTokens(String((error && error.message) || error).split('\n')[0])})`)
    }
  }

  // Bounded readiness poll (#47): the fixed 5 s sleep both flaked on a slow
  // runner and hid the page state when it did not become interactive. The
  // composer is required; the sidebar alone is not a usable session.
  let ready = false
  if (!navigationError) {
    try {
      await page.waitForFunction(
        (composerSelector) => document.querySelector(composerSelector) !== null,
        COMPOSER_SELECTOR,
        { timeout: TIMEOUT_MS, polling: 200 },
      )
      ready = true
    } catch {
      ready = false
    }
    log(`readiness: ${ready ? 'ready' : 'timeout'} after ${Date.now() - startedAt}ms`)
  } else {
    log('readiness: skipped (navigation failed)')
  }

  // The screenshot is taken before the signals are read, and even when the
  // readiness poll timed out: it is the primary artifact for diagnosing a
  // CI-only failure.
  try {
    await page.screenshot({ path: path.join(OUT, 'boot-smoke.png') })
    log('screenshot:boot-smoke.png')
  } catch (error) {
    log(`screenshot: failed (${redactTokens(String((error && error.message) || error).split('\n')[0])})`)
  }

  let signals = null
  let bodySnippet = ''
  try {
    const diagnostics = await page.evaluate((composerSelector) => {
      const composer = document.querySelector(composerSelector)
      const bodyText = document.body ? document.body.innerText : ''
      const isVisible = (el) => {
        const rect = el.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) return false
        const style = window.getComputedStyle(el)
        return style.visibility !== 'hidden' && style.display !== 'none'
      }
      const labelOf = (el) => String((el && (el.innerText || el.textContent)) || '').trim()
      return {
        title: document.title,
        href: location.href,
        composer: composer !== null,
        bodyText,
        buttonLabels: Array.from(document.querySelectorAll('button, [role="button"]'))
          .filter(isVisible)
          .map(labelOf),
      }
    }, COMPOSER_SELECTOR)
    const bilingual = newSessionSignals(diagnostics.bodyText)
    signals = {
      title: diagnostics.title,
      href: diagnostics.href,
      composer: diagnostics.composer,
      newSession: bilingual.newSession,
      newSessionEnglish: bilingual.newSessionEnglish,
      newSessionChinese: bilingual.newSessionChinese,
      previewNotice: diagnostics.buttonLabels.some(isPreviewNoticeLabel),
      chooseWorkspace: CHOOSE_WORKSPACE_MARKERS.some((marker) => diagnostics.bodyText.includes(marker)),
      textLength: diagnostics.bodyText.length,
    }
    bodySnippet = diagnostics.bodyText
    // Never print the token itself; CI logs and uploaded artifacts are durable.
    log(
      `signals: ${JSON.stringify({
        ...signals,
        href: redactTokens(signals.href),
        markers: { newSession: NEW_SESSION_MARKERS, previewLabels: PREVIEW_NOTICE_LABELS },
      })}`,
    )
  } catch (error) {
    log(`signals: unavailable (${redactTokens(String((error && error.message) || error).split('\n')[0])})`)
  }

  await browser.close()
  log('closed')

  const failures = []
  if (navigationError) failures.push(`navigation to the tokenized URL failed (${navigationError})`)
  if (!signals) failures.push('the renderer did not answer a trivial page evaluate; it may have crashed')
  if (pageErrors.length > 0) failures.push(`${pageErrors.length} page error(s)`)
  if (consoleErrors.length > 0) failures.push(`${consoleErrors.length} console error(s)`)
  if (signals && !signals.composer) {
    const state = []
    if (previewState === 'blocked') state.push('the Preview Notice button was visible but could not be clicked')
    else if (signals.previewNotice) state.push('a Preview Notice "Continue"/"继续" button is still visible')
    if (previewState === 'dismissed' && signals.newSession) {
      state.push('the Preview Notice was dismissed but the session still did not open')
    }
    if (signals.chooseWorkspace) state.push('the page is asking to choose a workspace')
    if (signals.newSession) state.push('the sidebar rendered but the composer did not')
    failures.push(
      `the page did not render the composer within ${TIMEOUT_MS}ms` +
        (state.length > 0 ? ` (${state.join('; ')})` : '') +
        '; a sidebar-only shell is not a usable session (raise DSH_LIVE_BOOT_TIMEOUT_MS to wait longer)',
    )
  }
  if (signals && signals.textLength === 0) failures.push('the page rendered an empty body')

  if (failures.length > 0) {
    // Full, non-benign errors: the summary above stays short, the artifact log
    // carries everything needed to tell a blank page from a broken app.
    for (const [index, message] of pageErrors.entries()) log(`page error[${index}]: ${redactTokens(message)}`)
    for (const [index, message] of consoleErrors.entries()) log(`console error[${index}]: ${redactTokens(message)}`)
    log(`body snippet (${bodySnippet.length} of ${signals ? signals.textLength : '?'} chars, redacted): ${JSON.stringify(redactSnippet(bodySnippet, SNIPPET_CHARS))}`)
    const message = `FAIL live boot smoke: ${failures.join('; ')}`
    log(message)
    console.error(
      `${message}\n` +
        'live boot smoke: diagnostics are in tests/live/boot-smoke.png and tests/live/boot-smoke.log ' +
        '(the nightly CI job uploads them as the `live-boot-diagnostics` artifact). ' +
        `Waited ${Date.now() - startedAt}ms; set DSH_LIVE_BOOT_TIMEOUT_MS to wait longer.`,
    )
    process.exit(1)
  }

  log(`body snippet (${bodySnippet.length} of ${signals.textLength} chars, redacted): ${JSON.stringify(redactSnippet(bodySnippet, SUCCESS_SNIPPET_CHARS))}`)
  console.log(
    `PASS live boot smoke (title=${JSON.stringify(signals.title)}, composer=${signals.composer}, ` +
      `newSession=${signals.newSession}, preview=${previewState}, wait=${Date.now() - startedAt}ms)`,
  )
})().catch((error) => {
  log(`FATAL ${error && error.stack ? error.stack : error}`)
  process.exit(1)
})
