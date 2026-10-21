import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const en = JSON.parse(fs.readFileSync('locale/en.json', 'utf8'))
const zh = JSON.parse(fs.readFileSync('locale/zh.json', 'utf8'))

test('host locale covers the same components in both languages', () => {
  assert.deepEqual(Object.keys(en.components).sort(), Object.keys(zh.components).sort())
  for (const key of Object.keys(en.components)) {
    for (const locale of [en, zh]) {
      const entry = locale.components[key]
      for (const field of ['title', 'summary', 'disables']) {
        assert.equal(typeof entry[field], 'string')
        assert.ok(entry[field].trim().length > 0, `${key}.${field}`)
      }
    }
    assert.doesNotMatch(en.components[key].title, /preset-/)
  }
})
