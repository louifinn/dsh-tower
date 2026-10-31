// #137: component labels are user-facing copy, not a config dump. These are the
// unit proofs for the copy gate that `docs:check:components` runs over the root
// locale, the generated row locales and the ui-bundle meta label:
//
//   - a config key, tool id, slash command or module specifier in a label fails;
//   - an English noun left untranslated in Chinese fails;
//   - the recorded glossary is enforced in both directions;
//   - zh/en field paths and non-empty text must agree.
//
// Each negative fixture is paired with the shipped copy passing, so the tests
// prove both "the leak is caught" and "the current labels are clean".
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  COMPONENT_GLOSSARY,
  GLOSSARY_FILE,
  checkGlossaryFile,
  checkLocaleCopy,
  checkMetaRowCopy,
} from '../scripts/check-components.mjs'
import { OFF_EFFECT_LABEL, ROW_LOCALES, rowLocalePaths } from '../scripts/generate-capability-locale.mjs'
import { removeTemp } from './helpers/cleanup.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8')
const readJson = (relative) => JSON.parse(read(relative))

const pair = (en, zh, enFile = 'locale/en.json', zhFile = 'locale/zh.json') => ({
  en: { file: enFile, payload: en },
  zh: { file: zhFile, payload: zh },
})
const meta = (title, description) => ({ meta: { title, description } })
const hasMessage = (findings, code, pattern) =>
  findings.some((entry) => entry.code === code && pattern.test(entry.message))
const cleanPair = () =>
  pair(meta('Tower', 'Missions and worktrees.'), meta('Tower', '任务线与工作树。'))

test('the shipped root, ui-bundle and generated row copy passes the copy gate (#137)', () => {
  const locales = {
    'locale/en.json': readJson('locale/en.json'),
    'locale/zh.json': readJson('locale/zh.json'),
    'ui-bundle/locale/en.json': readJson('ui-bundle/locale/en.json'),
    'ui-bundle/locale/zh.json': readJson('ui-bundle/locale/zh.json'),
  }
  const pairs = [
    pair(locales['locale/en.json'], locales['locale/zh.json']),
    pair(
      locales['ui-bundle/locale/en.json'],
      locales['ui-bundle/locale/zh.json'],
      'ui-bundle/locale/en.json',
      'ui-bundle/locale/zh.json',
    ),
    ...ROW_LOCALES.map((row) =>
      pair(
        readJson(`locale/${row.specifier}/en.json`),
        readJson(`locale/${row.specifier}/zh.json`),
        `locale/${row.specifier}/en.json`,
        `locale/${row.specifier}/zh.json`,
      ),
    ),
  ]
  assert.deepEqual(checkLocaleCopy(pairs), [])
  // The generated row labels are exactly the files the gate reads.
  for (const file of rowLocalePaths()) assert.ok(fs.existsSync(path.join(root, file)), file)
})

test('config-key syntax fails in both languages (#137)', () => {
  for (const [lang, description, code] of [
    ['en', 'Missions. With gates.requireTests:true planning is refused.', 'gates.requireTests'],
    ['zh', '任务线。若 gates.requireTests:true，规划会被拒绝。', 'gates.requireTests'],
    ['en', 'The row may not turn off review.requireReview.', 'review.requireReview'],
    ['en', 'A preset names spawn.requireLease here.', 'spawn.requireLease'],
  ]) {
    const findings =
      lang === 'en'
        ? checkLocaleCopy([pair(meta('Tower', description), meta('Tower', '任务线。'))])
        : checkLocaleCopy([pair(meta('Tower', 'Missions.'), meta('Tower', description))])
    assert.ok(
      findings.some((entry) => entry.code === 'locale-copy-config-key'),
      `${lang}: ${description}: ${JSON.stringify(findings)}`,
    )
    assert.ok(
      findings.some((entry) => entry.code === 'locale-copy-config-key' && entry.message.includes(code)),
      `${lang}: ${JSON.stringify(findings)}`,
    )
  }
})

test('bare tool ids, slash commands and module specifiers fail in both languages (#137)', () => {
  const enOnly = [
    ['tower_batch is not registered', 'locale-copy-tool-id'],
    ['Run /tower reload to pick it up', 'locale-copy-command'],
    ['Declared by dsh-tower/preset-worker', 'locale-copy-module'],
  ]
  for (const [description, code] of enOnly) {
    const findings = checkLocaleCopy([pair(meta('Tower', description), meta('Tower', '任务线。'))])
    assert.ok(
      findings.some((entry) => entry.code === code),
      `${description}: ${JSON.stringify(findings)}`,
    )
  }
  const zhFindings = checkLocaleCopy([
    pair(meta('Tower', 'Missions.'), meta('Tower', '不再注册 tower_batch；任务线继续工作。')),
  ])
  assert.ok(zhFindings.some((entry) => entry.code === 'locale-copy-tool-id'), JSON.stringify(zhFindings))
})

test('an untranslated English noun in Chinese copy fails (#137)', () => {
  for (const word of ['mission', 'preset', 'worktree', 'review', 'lease', 'host', 'state']) {
    const findings = checkLocaleCopy([
      pair(meta('Tower', 'Missions and presets.'), meta('Tower', `把 ${word} 放进任务线。`)),
    ])
    assert.ok(
      findings.some(
        (entry) => entry.code === 'locale-copy-untranslated' && entry.message.includes(word),
      ),
      `${word}: ${JSON.stringify(findings)}`,
    )
  }
  // Caps and product names are not untranslated prose.
  assert.deepEqual(
    checkLocaleCopy([pair(meta('Tower', 'Tower Worker preset.'), meta('Tower', 'Tower Worker 预设。'))]),
    [],
  )
})

test('glossary terms are enforced from English to Chinese (#137)', () => {
  const cases = [
    ['Mission planning.', '任务规划。', '任务线'],
    ['Evidence batches.', '证据分组。', '批次'],
    ['The mission board.', '任务线面板。', '看板'],
    ['Worktree isolation.', '隔离检出。', '工作树'],
    ['Independent review.', '独立评审。', '审查'],
    ['Advisory leases.', '协调式授权。', '租约'],
  ]
  for (const [en, zh, term] of cases) {
    const findings = checkLocaleCopy([pair(meta('Tower', en), meta('Tower', zh))])
    assert.ok(
      findings.some((entry) => entry.code === 'locale-glossary' && entry.message.includes(term)),
      `${en} / ${zh}: ${JSON.stringify(findings)}`,
    )
  }
})

test('glossary terms are enforced from Chinese to English, without role collisions (#137)', () => {
  const loose = checkLocaleCopy([
    pair(meta('Tower', 'Work packages and a quality pass.'), meta('Tower', '任务线与审查。')),
  ])
  assert.ok(
    hasMessage(loose, 'locale-glossary', /mission/) && hasMessage(loose, 'locale-glossary', /review/),
    JSON.stringify(loose),
  )
  // 审查代理 is its own glossary term; it must not also demand the shorter 审查.
  assert.deepEqual(
    checkLocaleCopy([pair(meta('Tower', 'The reviewer preset.'), meta('Tower', '审查代理预设。'))]),
    [],
  )
  assert.deepEqual(
    checkLocaleCopy([pair(meta('Tower', 'The worker preset.'), meta('Tower', '执行代理预设。'))]),
    [],
  )
})

test('zh/en parity and emptiness are reported with the field path (#137)', () => {
  const missingField = checkLocaleCopy([
    pair(
      {
        meta: { title: 'Tower', description: 'Missions.' },
        components: { tower: { title: 'Tower host', summary: 'Missions.', disables: 'Off.' } },
      },
      {
        meta: { title: 'Tower', description: '任务线。' },
        components: { tower: { title: 'Tower 控制塔', summary: '任务线。' } },
      },
    ),
  ])
  assert.ok(
    hasMessage(missingField, 'locale-copy-empty', /components\.tower\.disables/),
    JSON.stringify(missingField),
  )

  // A component that exists on one side only is a parity failure, not a silent
  // "nothing to compare".
  const missingComponent = checkLocaleCopy([
    pair(
      {
        meta: { title: 'Tower', description: 'Missions.' },
        components: { tower: { title: 'Tower host', summary: 'Missions.', disables: 'Off.' } },
      },
      { meta: { title: 'Tower', description: '任务线。' } },
    ),
  ])
  assert.ok(
    hasMessage(missingComponent, 'locale-copy-parity', /components\.tower\./),
    JSON.stringify(missingComponent),
  )

  const blank = checkLocaleCopy([pair(meta('Tower', '  '), meta('Tower', '任务线。'))])
  assert.ok(blank.some((entry) => entry.code === 'locale-copy-empty'), JSON.stringify(blank))
})

test('a missing side of a copy pair is reported, not silently skipped (#137)', () => {
  const findings = checkLocaleCopy([
    { en: { file: 'locale/en.json', payload: meta('Tower', 'Missions.') }, zh: { file: 'locale/zh.json', payload: null } },
  ])
  assert.ok(findings.some((entry) => entry.code === 'locale-copy-missing'), JSON.stringify(findings))
})

test('the ui-bundle meta label is pinned to the root source of truth (#137)', () => {
  const en = readJson('locale/en.json')
  const zh = readJson('locale/zh.json')
  const uiEn = readJson('ui-bundle/locale/en.json')
  const uiZh = readJson('ui-bundle/locale/zh.json')
  const locales = { 'locale/en.json': en, 'locale/zh.json': zh }
  const metaLocales = { 'ui-bundle/locale/en.json': uiEn, 'ui-bundle/locale/zh.json': uiZh }
  assert.deepEqual(checkMetaRowCopy(['tower-ui'], locales, metaLocales, OFF_EFFECT_LABEL), [])

  const drifted = {
    ...metaLocales,
    'ui-bundle/locale/en.json': {
      meta: { ...uiEn.meta, description: `${uiEn.meta.description} Extra copy.` },
    },
  }
  const findings = checkMetaRowCopy(['tower-ui'], locales, drifted, OFF_EFFECT_LABEL)
  assert.ok(findings.some((entry) => entry.code === 'meta-row-copy'), JSON.stringify(findings))
})

test('the glossary document exists and names every canonical term pair (#137)', () => {
  assert.deepEqual(checkGlossaryFile(root), [])
  for (const term of COMPONENT_GLOSSARY) {
    const text = read(GLOSSARY_FILE)
    assert.ok(text.includes(term.en) && text.includes(term.zh), `${term.en}/${term.zh}`)
  }

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-glossary-'))
  try {
    assert.ok(checkGlossaryFile(empty).some((entry) => entry.code === 'glossary-missing'))
    fs.writeFileSync(path.join(empty, GLOSSARY_FILE), '# GLOSSARY\n\nmission 任务线\n')
    const findings = checkGlossaryFile(empty)
    assert.ok(findings.some((entry) => entry.code === 'glossary-term'), JSON.stringify(findings))
  } finally {
    removeTemp(empty)
  }
})
