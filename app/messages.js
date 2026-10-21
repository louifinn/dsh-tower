// Inbox/message use cases.
import { withLock, writeJsonAtomic, appendJsonl } from '../lib/store.js'
import { validateState } from '../domain/state.js'
import { TowerToolError } from '../lib/errors.js'

function fail(message) {
  throw new TowerToolError('invalid-argument', message)
}

export async function recordMessage(tower, input) {
    return withLock(tower.paths, async () => {
      const state = await tower.load()
      if (!Array.isArray(state.messages)) state.messages = []
      const names = new Set((state.roster ?? []).map((entry) => entry.name))
      names.add('tower')
      if (input.to !== 'all' && !names.has(input.to)) {
        fail(`unknown message recipient "${input.to}" (known: ${[...names].join(', ')}, all)`)
      }
      if (input.to === input.from) fail('refusing to send a message to yourself')
      const now = Date.now()
      const seq = (state.messageSeq ?? 0) + 1
      state.messageSeq = seq
      const message = {
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
      state.messages.push(message)
      state.revision += 1
      state.updatedAt = now

      validateState(state, tower.paths.state)
      await writeJsonAtomic(tower.paths.state, state)
      await appendJsonl(tower.paths.activity, {
        at: now,
        type: 'message',
        text: `${input.from} -> ${input.to}: ${input.subject}`,
      })
      return { ...message, readBy: [], delivery: [] }
    })
  }

  export async function recordDelivery(tower, messageId, results) {
    return withLock(tower.paths, async () => {
      const state = await tower.load()
      const message = (state.messages ?? []).find((entry) => entry.id === messageId)
      if (!message) fail(`unknown message "${messageId}"`)
      message.delivery = [...(message.delivery ?? []), ...results]
      state.revision += 1
      state.updatedAt = Date.now()
      await writeJsonAtomic(tower.paths.state, state)
      return message.delivery
    })
  }

  export async function inbox(tower, input) {
    const reader = input.reader
    return withLock(tower.paths, async () => {
      const state = await tower.load()
      const limit = Math.max(1, Math.min(100, input.limit ?? 20))
      const includeRead = input.includeRead === true
      const visible = [...(state.messages ?? [])]
        .reverse()
        .filter((message) => (message.to === reader || message.to === 'all') && message.from !== reader)
      const unread = visible.filter((message) => !(message.readBy ?? []).includes(reader))
      const page = (includeRead ? visible : unread).slice(0, limit)

      let changed = false
      for (const message of page) {
        if (!(message.readBy ?? []).includes(reader)) {
          message.readBy = [...(message.readBy ?? []), reader]
          message.readAt = { ...(message.readAt ?? {}), [reader]: Date.now() }
          changed = true
        }
      }
      const unreadRemaining = visible.filter((message) => !(message.readBy ?? []).includes(reader)).length
      if (changed) {
        state.revision += 1
        state.updatedAt = Date.now()
        validateState(state, tower.paths.state)
        await writeJsonAtomic(tower.paths.state, state)
      }
      return {
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
      }
    })
  }

  /** Read-only completion preconditions shared by tower_complete and the tool
   * layer's test-discovery preflight. Throws on the first failed condition. */
