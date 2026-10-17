// Repair a session log damaged by the 2026-10-18 steer bug.
//
// The `/tower <message>` command forwarded a role-less `{content, source}`
// object into the inbox, so both the inbox splice record and the durable
// user/message event lack `role`/`id`; every later model request then failed
// with 422 "messages[N]: missing field `role`".
//
// This script:
//   1. decodes the concatenated zstd frames into JSONL,
//   2. verifies the damage is exactly the two expected events,
//   3. adds `role: "user"` and a shared `id` to both,
//   4. backs up the original, writes the repaired log atomically,
//   5. writes a repaired COPY under a fresh session id for validation.
const fs = require('node:fs')
const zlib = require('node:zlib')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

const ROOT = require('./_env.cjs').sessionRoot()
const SUFFIX = process.argv[2] || 'af615845'
const BACKUP_DIR = path.join(__dirname, 'backup')

function decodeFrames(buf) {
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const starts = []
  let idx = buf.indexOf(magic)
  while (idx !== -1) {
    starts.push(idx)
    idx = buf.indexOf(magic, idx + 4)
  }
  const parts = []
  for (let i = 0; i < starts.length; i += 1) {
    const seg = buf.subarray(starts[i], i + 1 < starts.length ? starts[i + 1] : buf.length)
    try {
      parts.push(zlib.zstdDecompressSync(seg).toString('utf8'))
    } catch {
      /* skippable frame */
    }
  }
  return parts.join('')
}

const dir = fs
  .readdirSync(ROOT, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name.includes(SUFFIX))
  .map((entry) => path.join(ROOT, entry.name))[0]
if (!dir) {
  console.error(`no session matching ${SUFFIX}`)
  process.exit(1)
}
const originalId = path.basename(dir)
const file = path.join(dir, 'session.v4.jsonl.zstd')
const lines = decodeFrames(fs.readFileSync(file)).split('\n').filter(Boolean)

const messageId = randomUUID()
const damaged = []
const repairedLines = lines.map((line) => {
  const event = JSON.parse(line)
  if (event.type === 'agent/inbox/spliced' && Array.isArray(event.data?.inserted)) {
    for (const item of event.data.inserted) {
      if (item && typeof item === 'object' && !item.role && !item.id && item.source?.kind === 'user') {
        item.role = 'user'
        item.id = messageId
        damaged.push(`seq ${event.seq} inbox splice`)
      }
    }
  }
  if (event.type === 'user/message' && !event.data?.role && !event.data?.id && event.data?.source?.kind === 'user') {
    event.data.role = 'user'
    event.data.id = messageId
    damaged.push(`seq ${event.seq} user/message`)
  }
  return JSON.stringify(event)
})

const expected = ['inbox splice', 'user/message']
if (damaged.length !== expected.length || !expected.every((kind) => damaged.some((entry) => entry.endsWith(kind)))) {
  console.error(`refusing to write: expected exactly ${expected.join(' + ')}, found ${JSON.stringify(damaged)}`)
  process.exit(2)
}

const payload = `${repairedLines.join('\n')}\n`

function writeAtomic(target, text) {
  const tmp = `${target}.tmp-${process.pid}`
  fs.writeFileSync(tmp, zlib.zstdCompressSync(Buffer.from(text, 'utf8')))
  fs.renameSync(tmp, target)
}

fs.mkdirSync(BACKUP_DIR, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backup = path.join(BACKUP_DIR, `${originalId}-${stamp}.zstd`)
fs.copyFileSync(file, backup)
writeAtomic(file, payload)
console.log(`repaired ${damaged.join(', ')} in ${originalId}`)
console.log(`backup: ${backup}`)

const copyId = `session-${randomUUID()}`
const copyDir = path.join(ROOT, copyId)
const copyPayload = payload.split(originalId).join(copyId)
fs.mkdirSync(copyDir, { recursive: true })
writeAtomic(path.join(copyDir, 'session.v4.jsonl.zstd'), copyPayload)
console.log(`validation copy: ${copyId}`)
