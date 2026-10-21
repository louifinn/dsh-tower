// Pure message routing, read tracking, and inbox projections.
//
// app/messages.js owns the state lock, load, persistence, and activity log;
// app/roster.js's unreadFor delegates to `unreadMessages` here.
// @ts-check
import { TowerToolError } from '../errors.js'

/** @typedef {import('../../types/index.js').RosterEntry} RosterEntry */
/** @typedef {import('../../types/index.js').TowerState} TowerState */

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  throw new TowerToolError('invalid-argument', message)
}

/**
 * Validate the recipient against the roster plus the synthetic `tower` name.
 * @param {{ roster?: RosterEntry[], to: string, from: string }} params
 * @returns {void}
 */
export function assertMessageRecipient({ roster = [], to, from }) {
  const names = new Set(roster.map((entry) => entry.name))
  names.add('tower')
  if (to !== 'all' && !names.has(to)) {
    fail(`unknown message recipient "${to}" (known: ${[...names].join(', ')}, all)`)
  }
  if (to === from) fail('refusing to send a message to yourself')
}

/**
 * Project the persisted message record.
 * @param {any} input
 * @param {number} seq
 * @param {number} now
 * @returns {any}
 */
export function createMessage(input, seq, now) {
  return {
    id: `msg-${seq}`,
    seq,
    from: input.from,
    to: input.to,
    subject: input.subject,
    body: input.body,
    scope: input.scope ?? null,
    consentRef: input.consentRef ?? null,
    at: now,
    readBy: [],
    delivery: [],
  }
}

/**
 * Append delivery results to a message, preserving earlier entries.
 * @param {{ delivery?: unknown[] }} message
 * @param {unknown[]} results
 * @returns {unknown[]}
 */
export function addDelivery(message, results) {
  message.delivery = [...(message.delivery ?? []), ...results]
  return message.delivery
}

/**
 * Inbox page plus read-marking mutation. Returns `changed` so the use case can
 * decide whether the state file needs a write.
 * @param {any[]} messages
 * @param {{ reader: string, limit?: number, includeRead?: boolean }} input
 * @param {number} now
 * @returns {{ payload: any, changed: boolean }}
 */
export function inboxView(messages, input, now) {
  const reader = input.reader
  const limit = Math.max(1, Math.min(100, input.limit ?? 20))
  const includeRead = input.includeRead === true
  const visible = [...messages]
    .reverse()
    .filter((message) => (message.to === reader || message.to === 'all') && message.from !== reader)
  const unread = visible.filter((message) => !(message.readBy ?? []).includes(reader))
  const page = (includeRead ? visible : unread).slice(0, limit)

  let changed = false
  for (const message of page) {
    if (!(message.readBy ?? []).includes(reader)) {
      message.readBy = [...(message.readBy ?? []), reader]
      message.readAt = { ...(message.readAt ?? {}), [reader]: now }
      changed = true
    }
  }
  const unreadRemaining = visible.filter((message) => !(message.readBy ?? []).includes(reader)).length
  return {
    payload: {
      reader,
      messages: page.map((message) => ({
        id: message.id,
        from: message.from,
        to: message.to,
        subject: message.subject,
        body: message.body,
        scope: message.scope ?? null,
        at: message.at,
        delivery: message.delivery ?? [],
        ackAt: message.readAt?.[reader] ?? null,
      })),
      pageSize: page.length,
      unreadRemaining,
    },
    changed,
  }
}

/**
 * Unread inbox rows for one recipient (messages from self never count).
 * @param {TowerState} state
 * @param {string} name
 * @returns {any[]}
 */
export function unreadMessages(state, name) {
  return (state.messages ?? []).filter((message) => {
    if (message.from === name) return false
    if (message.to !== name && message.to !== 'all') return false
    return !(/** @type {any[]} */ (message.readBy ?? [])).includes(name)
  })
}
