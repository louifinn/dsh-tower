// Inbox/message use cases.
import { withLock, writeJsonAtomic, appendJsonl } from '../lib/store.js'
import { validateState } from '../domain/state.js'
import { TowerToolError } from '../domain/errors.js'
import {
  assertMessageRecipient,
  createMessage,
  addDelivery,
  inboxView,
} from '../domain/collab/messages.js'

function fail(message) {
  throw new TowerToolError('invalid-argument', message)
}

export async function recordMessage(tower, input) {
    return withLock(tower.paths, async () => {
      const state = await tower.load()
      if (!Array.isArray(state.messages)) state.messages = []
      assertMessageRecipient({ roster: state.roster ?? [], to: input.to, from: input.from })
      const now = Date.now()
      const seq = (state.messageSeq ?? 0) + 1
      state.messageSeq = seq
      const message = createMessage(input, seq, now)
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
      addDelivery(message, results)
      state.revision += 1
      state.updatedAt = Date.now()
      await writeJsonAtomic(tower.paths.state, state)
      return message.delivery
    })
  }

  export async function inbox(tower, input) {
    return withLock(tower.paths, async () => {
      const state = await tower.load()
      const now = Date.now()
      const { payload, changed } = inboxView(state.messages ?? [], input, now)
      if (changed) {
        state.revision += 1
        state.updatedAt = now
        validateState(state, tower.paths.state)
        await writeJsonAtomic(tower.paths.state, state)
      }
      return payload
    })
  }
