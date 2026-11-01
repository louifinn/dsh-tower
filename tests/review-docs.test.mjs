// #M42: the review policy is one tri-state control, and its docs/copy have to
// say so. These tests pin the user-facing contract that the component gate
// cannot see: the three modes, the plugin-page location, the one-release alias
// mapping, the off-start restart limitation, and the reviewer-preset dependency.
//
// They also keep the deprecated key confined to the documents that must mention
// it (the migration note, the reference tables, the ADR, the changelog and the
// generated component surface). A new guide telling readers to flip the old
// boolean fails here before it reaches a user.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8')

// Documents allowed to name the deprecated key: they either record history or
// document the alias on purpose.
const ALIAS_DOCS = new Set([
  'CHANGELOG.md',
  'docs/adr/0005-component-surface.md',
  'docs/guide/install-upgrade-migration.md',
  'docs/reference/component-surface.md',
  'docs/reference/config.generated.md',
  'docs/reference/config.md',
  'docs/reference/surface-budget.md',
  'docs/zh/guide/install-upgrade-migration.md',
  'docs/zh/reference/config.md',
])

const MIGRATION_EN = 'docs/guide/install-upgrade-migration.md'
const MIGRATION_ZH = 'docs/zh/guide/install-upgrade-migration.md'

test('the bilingual migration guidance explains all three modes and the alias mapping (#M42)', () => {
  const en = read(MIGRATION_EN)
  assert.match(en, /2\.5\.0 → 2\.6\.0/)
  for (const mode of ['`off`', '`optional`', '`required`']) {
    assert.ok(en.includes(mode), `English migration guidance names ${mode}`)
  }
  assert.match(en, /one\s+tri-state control/i)
  assert.match(en, /Plugins page/i)
  assert.match(en, /`true` resolves to `required`/)
  assert.match(en, /`false`\s+to `optional`/)
  assert.match(en, /leaving it unset means\s+`optional`/)
  assert.match(en, /one-release alias/i)
  assert.match(en, /restart/i)
  assert.match(en, /`preset-tower-reviewer`/)
  assert.match(en, /not a\s+component row/i)
  assert.match(en, /no mutually exclusive review rows/i)

  const zh = read(MIGRATION_ZH)
  for (const mode of ['`off`', '`optional`', '`required`']) {
    assert.ok(zh.includes(mode), `中文迁移说明包含 ${mode}`)
  }
  assert.match(zh, /三态控件/)
  assert.match(zh, /插件页/)
  assert.match(zh, /保留一个版本的别名/)
  assert.match(zh, /重启/)
  assert.match(zh, /`preset-tower-reviewer`/)
})

test('the plugin page still has exactly one tri-state control, not one row per mode (#M42)', () => {
  const client = read('client.js')
  assert.match(client, /const MODES = \['off', 'optional', 'required'\]/)
  assert.match(client, /const DEFAULT_MODE = 'optional'/)
  assert.equal(
    (client.match(/role: 'radiogroup'/g) ?? []).length,
    1,
    'the policy is one radio group; a second group would be a second control',
  )
  assert.ok(!/review-policy-row|review_policy_row/.test(client))
})

test('the deprecated key is confined to the alias-migration documents (#M42)', () => {
  const files = ['README.md', 'README.en.md', 'CHANGELOG.md']
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const relative = `${dir}/${entry.name}`
      if (entry.isDirectory()) walk(relative)
      else if (entry.name.endsWith('.md')) files.push(relative)
    }
  }
  walk('docs')

  const mentioning = files.filter((file) => read(file).includes('review.requireReview'))
  assert.deepEqual(
    mentioning.filter((file) => !ALIAS_DOCS.has(file)),
    [],
    'stale live docs must be rewritten to review.mode; only alias-migration references may name the old key',
  )
})
