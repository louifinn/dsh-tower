// Shared, testable helpers for boot-smoke.cjs diagnostics (#47).
//
// The boot smoke used to sleep a fixed 5 s and print only booleans, so a
// nightly failure said "composer:false" and nothing else. This module owns the
// two decisions that must stay unit-testable without a browser:
//
//   * how long to wait for readiness (DSH_LIVE_BOOT_TIMEOUT_MS, default 60 s,
//     clamped to a sane range so a typo cannot hang the nightly for an hour or
//     give up after 3 ms), and
//   * how to redact the page text before it enters a durable CI artifact.
//
// It has no Playwright dependency and no environment guard, so the offline
// suite can require it directly.
'use strict'

const DEFAULT_BOOT_TIMEOUT_MS = 60000
const MIN_BOOT_TIMEOUT_MS = 1000
const MAX_BOOT_TIMEOUT_MS = 600000
const SNIPPET_CHARS = 1200
const SUCCESS_SNIPPET_CHARS = 200
const REDACTED = '<redacted>'
// (#47) How long the smoke waits for the first render to show either the
// composer or the first-run Preview Notice button before it tries to dismiss
// the notice. A rendered app resolves this immediately; only an app that shows
// neither pays the whole window before the readiness poll starts.
const PREVIEW_NOTICE_WAIT_MS = 15000
// The first-run notice's button label, per language. Matched on the trimmed
// innerText, case-insensitively.
const PREVIEW_NOTICE_LABELS = ['Continue', '继续']
// The sidebar's new-session entry, per language. A diagnostic only: the
// composer is the success target, because a sidebar-only shell is not usable.
const NEW_SESSION_MARKERS = ['New Session', '新会话']
// The workspace-picker state the broken CI boot parked on. Diagnostic only.
const CHOOSE_WORKSPACE_MARKERS = ['Choose workspace', '选择工作区', '选择工作空间']

/**
 * Parse DSH_LIVE_BOOT_TIMEOUT_MS.
 *
 * An unset, blank, non-positive, or non-numeric value falls back to the default
 * instead of failing the smoke: a bad override must not be confused with a real
 * boot failure. A valid value is floored and clamped to
 * [MIN_BOOT_TIMEOUT_MS, MAX_BOOT_TIMEOUT_MS].
 *
 * @param {string | number | null | undefined} raw
 * @returns {number} timeout in milliseconds
 */
function parseBootTimeoutMs(raw) {
  if (raw === undefined || raw === null) return DEFAULT_BOOT_TIMEOUT_MS
  const trimmed = String(raw).trim()
  if (trimmed === '') return DEFAULT_BOOT_TIMEOUT_MS
  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_BOOT_TIMEOUT_MS
  return Math.min(MAX_BOOT_TIMEOUT_MS, Math.max(MIN_BOOT_TIMEOUT_MS, Math.floor(parsed)))
}

/**
 * True when a button's trimmed innerText names the first-run Preview Notice's
 * dismiss action in either language ("Continue" / "继续").
 *
 * @param {unknown} text
 * @returns {boolean}
 */
function isPreviewNoticeLabel(text) {
  const label = String(text ?? '').trim().toLowerCase()
  return PREVIEW_NOTICE_LABELS.some((candidate) => candidate.toLowerCase() === label)
}

/**
 * The bilingual new-session diagnostic for the boot signals.
 *
 * `newSession` is true when either language's sidebar marker is present, so a
 * log records what rendered without assuming the UI language. It is never the
 * success target: the composer is.
 *
 * @param {unknown} bodyText
 * @returns {{newSession: boolean, newSessionEnglish: boolean, newSessionChinese: boolean}}
 */
function newSessionSignals(bodyText) {
  const text = String(bodyText ?? '')
  const newSessionEnglish = text.includes('New Session')
  const newSessionChinese = text.includes('新会话')
  return { newSession: newSessionEnglish || newSessionChinese, newSessionEnglish, newSessionChinese }
}

/**
 * Replace every `token=<value>` credential while keeping the URL readable.
 */
function redactTokens(text) {
  return String(text ?? '').replace(/\btoken=[^\s&"'<>)\]}]+/gi, 'token=<redacted>')
}

/** Replace whole http(s) URLs, which may carry a token in a query or path. */
function redactUrls(text) {
  return String(text ?? '').replace(/\bhttps?:\/\/[^\s"'<>)\]}]+/gi, REDACTED)
}

/**
 * A redacted, bounded body snippet safe to upload in a CI artifact.
 *
 * URLs are removed before token= values so a tokenized link becomes one
 * `<redacted>` rather than a partially redacted string.
 *
 * @param {unknown} text
 * @param {number} [limit]
 * @returns {string}
 */
function redactSnippet(text, limit = SNIPPET_CHARS) {
  const slice = String(text ?? '').slice(0, Math.max(0, limit))
  return redactTokens(redactUrls(slice))
}

module.exports = {
  CHOOSE_WORKSPACE_MARKERS,
  DEFAULT_BOOT_TIMEOUT_MS,
  MAX_BOOT_TIMEOUT_MS,
  MIN_BOOT_TIMEOUT_MS,
  NEW_SESSION_MARKERS,
  PREVIEW_NOTICE_LABELS,
  PREVIEW_NOTICE_WAIT_MS,
  REDACTED,
  SNIPPET_CHARS,
  SUCCESS_SNIPPET_CHARS,
  isPreviewNoticeLabel,
  newSessionSignals,
  parseBootTimeoutMs,
  redactSnippet,
  redactTokens,
  redactUrls,
}
