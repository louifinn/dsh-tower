const fs = require('node:fs')
const zlib = require('node:zlib')
const path = require('node:path')
const root = require('./_diagnostic-env.cjs').sessionRoot()
const suffix = process.argv[2]
function decodeFrames(buf) {
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const starts = []
  let idx = buf.indexOf(magic)
  while (idx !== -1) { starts.push(idx); idx = buf.indexOf(magic, idx + 4) }
  const parts = []
  for (let i = 0; i < starts.length; i += 1) {
    const seg = buf.subarray(starts[i], i + 1 < starts.length ? starts[i + 1] : buf.length)
    try { parts.push(zlib.zstdDecompressSync(seg).toString('utf8')) } catch {}
  }
  return parts.join('')
}
const dir = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name.includes(suffix)).map((e) => path.join(root, e.name))[0]
if (!dir) { console.error('no session'); process.exit(1) }
const events = decodeFrames(fs.readFileSync(path.join(dir, 'session.v4.jsonl.zstd'))).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
const problems = []
for (const event of events) {
  const seq = event.seq
  const type = event.type
  let message = null
  if (type === 'user/message') message = event.data
  else if (type === 'developer/message') message = event.data?.message ?? null
  else if (type === 'assistant/message' || type === 'system/message' || type === 'tool/result') message = event.data?.message ?? null
  if (message && (!message.role || !message.id)) problems.push({ seq, type, missing: [!message.role && 'role', !message.id && 'id'].filter(Boolean), preview: JSON.stringify(message).slice(0, 200) })
  if (type === 'agent/inbox/spliced') {
    for (const item of event.data?.inserted ?? []) {
      if (!item || typeof item !== 'object' || !item.role || !item.id) problems.push({ seq, type: `${type}:${event.data?.target}`, missing: [!item?.role && 'role', !item?.id && 'id'].filter(Boolean), preview: JSON.stringify(item).slice(0, 200) })
    }
  }
}
console.log(`session ${path.basename(dir)} events=${events.length} problems=${problems.length}`)
for (const p of problems) console.log(JSON.stringify(p))
