// Dump events in a session log range for diagnosis (read-only).
// arg1: session id (suffix ok), arg2: from (inclusive), arg3: to (inclusive), arg4: max chars per event
const fs = require('node:fs')
const zlib = require('node:zlib')
const path = require('node:path')

const root = require('./_env.cjs').sessionRoot()
const suffix = process.argv[2]
const from = Number(process.argv[3] || 0)
const to = Number(process.argv[4] || Number.MAX_SAFE_INTEGER)
const limit = Number(process.argv[5] || 2000)

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
      /* skippable */
    }
  }
  return parts.join('')
}

const dir = fs
  .readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name.includes(suffix))
  .map((entry) => path.join(root, entry.name))[0]
if (!dir) {
  console.error(`no session matching ${suffix}`)
  process.exit(1)
}
const text = decodeFrames(fs.readFileSync(path.join(dir, 'session.v4.jsonl.zstd')))
const lines = text.split('\n').filter(Boolean)
console.log(`session ${path.basename(dir)} events=${lines.length}`)
lines.forEach((line, index) => {
  const parsed = (() => {
    try {
      return JSON.parse(line)
    } catch {
      return null
    }
  })()
  if (!parsed) return
  const seq = parsed.seq ?? index
  if (seq < from || seq > to) return
  const data = JSON.stringify(parsed.data ?? null)
  console.log(`[${seq}] ${parsed.type} ${data.slice(0, limit)}`)
})
