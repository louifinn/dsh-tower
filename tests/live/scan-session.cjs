// Scan session logs for a probe string and dump the surrounding event shapes.
// Read-only diagnostic; zstd streams are concatenated frames.
const fs = require('node:fs')
const zlib = require('node:zlib')
const path = require('node:path')

const root = require('./_env.cjs').sessionRoot()
const needle = process.argv[2] || '这是一条测试消息'

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
      /* skippable frame or trailing bytes */
    }
  }
  return parts.join('')
}

const dirs = fs
  .readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(root, entry.name))
  .map((dir) => ({ dir, mtime: fs.statSync(dir).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime)

for (const { dir, mtime } of dirs.slice(0, 12)) {
  const file = path.join(dir, 'session.v4.jsonl.zstd')
  if (!fs.existsSync(file)) continue
  let text
  try {
    text = decodeFrames(fs.readFileSync(file))
  } catch (error) {
    console.log(`### ${path.basename(dir)} decode error: ${error.message}`)
    continue
  }
  if (!text.includes(needle)) continue
  console.log(`### ${path.basename(dir)} size=${text.length} mtime=${new Date(mtime).toISOString()}`)
  const lines = text.split('\n').filter(Boolean)
  console.log(`events=${lines.length}`)
  lines.forEach((line, index) => {
    if (!line.includes(needle)) return
    console.log(`--- event line ${index} ---`)
    console.log(line.slice(0, 1200))
    for (let j = Math.max(0, index - 3); j < Math.min(lines.length, index + 3); j += 1) {
      if (j === index) continue
      const parsed = (() => { try { return JSON.parse(lines[j]) } catch { return null } })()
      console.log(`  [${j}] type=${parsed && parsed.type} data=${JSON.stringify(parsed && parsed.data).slice(0, 400)}`)
    }
  })
}
