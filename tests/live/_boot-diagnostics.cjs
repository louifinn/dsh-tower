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

/** Replace every `token=<value>` credential while keeping the URL readable. */
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
  DEFAULT_BOOT_TIMEOUT_MS,
  MAX_BOOT_TIMEOUT_MS,
  MIN_BOOT_TIMEOUT_MS,
  REDACTED,
  SNIPPET_CHARS,
  SUCCESS_SNIPPET_CHARS,
  parseBootTimeoutMs,
  redactSnippet,
  redactTokens,
  redactUrls,
}
