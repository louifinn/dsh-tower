// #137/#F22: component labels are user-facing copy, not a config dump. These
// are the unit proofs for the copy gate that `docs:check:components` runs over
// the root locale, the generated row locales, the ui-bundle meta label, the Web
// client string catalogue and the preset runtime failures:
//
//   - a config key, tool id, slash command or module specifier in copy fails;
//   - an English noun left untranslated in Chinese fails;
//   - the recorded glossary is enforced in both directions;
//   - zh/en field paths and non-empty text must agree;
//   - a preset failure names the plugin-page row and a remedy, and leaves no
//     placeholder unfilled.
//
// Each negative fixture is paired with the shipped copy passing, so the tests
// prove both "the leak is caught" and "the current copy is clean".
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  CLIENT_CATALOG_FILE,
  CLIENT_COMMAND_KEYS,
  COMPONENT_GLOSSARY,
  GLOSSARY_FILE,
  PRESET_ERROR_FILE,
  capabilityRowTitles,
  checkClientCopy,
  checkClientDictionaries,
  checkCopyGateSelfTest,
  checkGlossaryFile,
  checkLocaleCopy,
  checkMetaRowCopy,
  checkPresetErrorCopy,
  loadClientCatalog,
  normalizeCopy,
  parseErrorCopy,
  presetCopyFindings,
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

// The client-side dictionary is shipped as a browser chunk, not JSON, so the
// copy gate has to load it the same way the Web client does.
function loadClientLocales() {
  const loaded = loadClientCatalog(root)
  assert.equal(loaded.error, undefined, loaded.error)
  return { EN: loaded.EN, ZH: loaded.ZH }
}
// A throwaway root holding one planted client catalogue, so the planted leak is
// exercised through the real file-loading path (not only the pure dictionary
// check).
function clientRoot(transform) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-client-copy-'))
  fs.mkdirSync(path.join(dir, 'ui-bundle'), { recursive: true })
  fs.writeFileSync(path.join(dir, CLIENT_CATALOG_FILE), transform(read(CLIENT_CATALOG_FILE)))
  return dir
}
const presetSource = () => read(PRESET_ERROR_FILE)
const presetTitles = () => capabilityRowTitles(readJson('locale/en.json'))
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

test('the Web client catalogue and preset failure copy pass the copy gate (#F22)', () => {
  const { EN, ZH } = loadClientLocales()
  assert.deepEqual(checkClientDictionaries(EN, ZH), [])
  assert.deepEqual(checkClientCopy(root), [])
  assert.deepEqual(checkPresetErrorCopy(root, presetTitles()), [])
  // The self-test is part of the shipped gate: a green result here proves the
  // planted fixtures below still trip their codes.
  assert.deepEqual(checkCopyGateSelfTest(), [])
})

test('a planted config key or tool id in the client catalogue fails the gate (#F22)', () => {
  for (const [from, to, code] of [
    ["'card.title': ['Tower', 'Tower']", "'card.title': ['Gates.requireTests is on', 'Tower']", 'client-copy-config-key'],
    ["'tool.batch': ['Batch', '批次']", "'tool.batch': ['Batch', 'tower_batch 批次']", 'client-copy-tool-id'],
  ]) {
    const dir = clientRoot((source) => {
      assert.ok(source.includes(from), from)
      return source.replace(from, to)
    })
    try {
      const findings = checkClientCopy(dir)
      assert.ok(findings.some((entry) => entry.code === code), `${to}: ${JSON.stringify(findings)}`)
    } finally {
      removeTemp(dir)
    }
  }
})

test('the client-copy gate catches glossary drift and a missing dictionary key (#F22)', () => {
  const { EN, ZH } = loadClientLocales()
  const drifted = checkClientDictionaries(EN, { ...ZH, 'tool.review': '复核' })
  assert.ok(drifted.some((entry) => entry.code === 'client-copy-glossary'), JSON.stringify(drifted.slice(0, 5)))

  const missing = { ...ZH }
  delete missing['tool.batch']
  const parity = checkClientDictionaries(EN, missing)
  assert.ok(parity.some((entry) => entry.code === 'client-copy-parity'), JSON.stringify(parity.slice(0, 5)))
})

test('a command is allowed only in the documented instruction keys (#F22)', () => {
  const allowed = checkClientDictionaries(
    { 'dock.mode.tooltip': 'Run /tower to check Tower mode' },
    { 'dock.mode.tooltip': '运行 /tower 检查 Tower 模式' },
  )
  assert.equal(
    allowed.filter((entry) => entry.code === 'client-copy-command').length,
    0,
    JSON.stringify(allowed),
  )
  const denied = checkClientDictionaries(
    { 'card.title': 'Run /tower off first' },
    { 'card.title': '先运行 /tower off' },
  )
  assert.ok(denied.some((entry) => entry.code === 'client-copy-command'), JSON.stringify(denied))
})

test('a planted tool id or config key in a preset failure message fails the gate (#F22)', () => {
  const presetWith = (text) =>
    [
      'const ERROR_COPY = Object.freeze({',
      `  requireTests: ${JSON.stringify(text)},`,
      '})',
      "export function boom() { throw new TowerToolError('config-invalid', fillCopy(ERROR_COPY.requireTests)) }",
    ].join('\n')
  const clean =
    'Test evidence is required before merging, but the Test evidence capability is switched off. ' +
    'Switch the Test evidence capability back on in the plugin page.'
  assert.deepEqual(presetCopyFindings(presetWith(clean), ['Test evidence']), [])
  for (const [label, text, code] of [
    [
      'tool id',
      'The tower_resource tool is missing. Switch the Test evidence capability back on in the plugin page.',
      'preset-copy-tool-id',
    ],
    [
      'config key',
      'gates.requireTests is on. Switch the Test evidence capability back on in the plugin page.',
      'preset-copy-config-key',
    ],
    [
      'module specifier',
      'Import dsh-tower/presets to check. Switch the Test evidence capability back on in the plugin page.',
      'preset-copy-module',
    ],
  ]) {
    const findings = presetCopyFindings(presetWith(text), ['Test evidence'])
    assert.ok(findings.some((entry) => entry.code === code), `${label}: ${JSON.stringify(findings)}`)
  }
})

test('preset failure copy must stay in the table, name a row and a remedy (#F22)', () => {
  const base = (entries) =>
    [
      'const ERROR_COPY = Object.freeze({',
      ...entries,
      '})',
      "export function boom() { throw new TowerToolError('config-invalid', fillCopy(ERROR_COPY.requireTests)) }",
    ].join('\n')
  const rowAndRemedy = 'Switch the Test evidence capability back on in the plugin page.'
  assert.deepEqual(checkCopyGateSelfTest(), [])
  assert.ok(
    presetCopyFindings(base(["  requireTests: 'Test evidence is switched off.',"]), ['Test evidence']).some(
      (entry) => entry.code === 'preset-copy-remedy',
    ),
  )
  assert.ok(
    presetCopyFindings(
      base(["  requireTests: 'The capability is off; switch it back on in the plugin page.',"]),
      ['Test evidence'],
    ).some((entry) => entry.code === 'preset-copy-row'),
  )
  assert.ok(
    presetCopyFindings(base([`  requireTests: 'Test evidence is off for {name}; ${rowAndRemedy}',`]), ['Test evidence']).some(
      (entry) => entry.code === 'preset-copy-placeholder',
    ),
  )
  const unparsed = [
    'const ERROR_COPY = Object.freeze({',
    `  requireTests: 'Test evidence is off; ${rowAndRemedy}',`,
    '})',
    "export function boom() { throw new TowerToolError('config-invalid', 'Something went wrong') }",
  ].join('\n')
  assert.ok(presetCopyFindings(unparsed, ['Test evidence']).some((entry) => entry.code === 'preset-copy-unparsed'))
})

test('config-key syntax fails in both languages (#137)', () => {
  for (const [lang, description, code] of [
    ['en', 'Missions. With gates.requireTests:true planning is refused.', 'gates.requireTests'],
    ['zh', '任务线。若 gates.requireTests:true，规划会被拒绝。', 'gates.requireTests'],
    ['en', 'The row may not turn off review.mode.', 'review.mode'],
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

test('role nouns match an initial capital but not the product names (#137 review P3)', () => {
  // EN -> ZH: "Workers" / "Reviewers" at the start of a sentence are the role,
  // so the Chinese copy owes 执行代理 / 审查代理.
  for (const [en, term] of [
    ['Workers plan missions.', '执行代理'],
    ['Reviewers return a verdict.', '审查代理'],
  ]) {
    const findings = checkLocaleCopy([pair(meta('Tower', en), meta('Tower', '任务线。'))])
    assert.ok(
      findings.some((entry) => entry.code === 'locale-glossary' && entry.message.includes(term)),
      `${en}: ${JSON.stringify(findings)}`,
    )
  }
  // "Tower Worker" / "Tower Reviewer" are product names, not the generic role.
  assert.deepEqual(
    checkLocaleCopy([pair(meta('Tower', 'The Tower Worker preset.'), meta('Tower', 'Tower Worker 预设。'))]),
    [],
  )
  assert.deepEqual(
    checkLocaleCopy([pair(meta('Tower', 'The Tower Reviewer preset.'), meta('Tower', 'Tower Reviewer 预设。'))]),
    [],
  )
  // ZH -> EN: the Chinese role term still demands the English role noun.
  const zhOnly = checkLocaleCopy([pair(meta('Tower', 'A preset.'), meta('Tower', '执行代理预设。'))])
  assert.ok(hasMessage(zhOnly, 'locale-glossary', /worker/), JSON.stringify(zhOnly))
})

test('case variants and full-width punctuation cannot bypass the copy gate (#137 review P3)', () => {
  assert.equal(normalizeCopy('gates。requireTests'), 'gates.requireTests')
  assert.equal(normalizeCopy('Tower＿batch'), 'Tower_batch')
  assert.equal(normalizeCopy('ｔｏｗｅｒ＿ｂａｔｃｈ'), 'tower_batch')
  const cases = [
    ['en', 'Missions. Gates.requireTests is on.', 'locale-copy-config-key', 'Gates.requireTests'],
    ['en', 'Tower_batch is not registered.', 'locale-copy-tool-id', 'Tower_batch'],
    ['en', 'Run /Tower reload to pick it up.', 'locale-copy-command', '/Tower'],
    ['en', 'Declared by DSH-Tower/preset-worker.', 'locale-copy-module', 'DSH-Tower/preset-worker'],
    ['zh', '任务线。gates。requireTests 已开启。', 'locale-copy-config-key', 'gates.requireTests'],
    ['zh', '任务线。Tower＿batch 不可用。', 'locale-copy-tool-id', 'Tower_batch'],
    ['zh', '任务线。ｔｏｗｅｒ＿ｂａｔｃｈ 不可用。', 'locale-copy-tool-id', 'tower_batch'],
  ]
  for (const [lang, description, code, token] of cases) {
    const findings = checkLocaleCopy(
      lang === 'en'
        ? [pair(meta('Tower', description), meta('Tower', '任务线。'))]
        : [pair(meta('Tower', 'Missions.'), meta('Tower', description))],
    )
    assert.ok(
      findings.some((entry) => entry.code === code && entry.message.includes(token)),
      `${lang} ${description}: ${JSON.stringify(findings)}`,
    )
  }
})

test('the reviewed off copy and Chinese terms stay corrected (#137 review P2)', () => {
  const en = readJson('locale/en.json')
  const zh = readJson('locale/zh.json')
  // With tower-tests off and the test requirement on, merges stay blocked; the
  // copy must say so instead of promising that merges keep working.
  const testsOff = en.components['tower-tests'].disables
  assert.match(testsOff, /merges stay blocked/)
  assert.doesNotMatch(testsOff, /merges .* keep working/)
  assert.match(zh.components['tower-tests'].disables, /合并也会持续受阻/)
  // The reviewer preset is usable while review is optional, and a precondition
  // for merging only once review is required.
  const reviewerSummary = en.components['preset-tower-reviewer'].summary
  assert.doesNotMatch(reviewerSummary, /Only used when/)
  assert.match(reviewerSummary, /Usable while review before merging is optional/)
  assert.match(zh.components['preset-tower-reviewer'].summary, /可以使用/)
  // The group description must not present review before merging as the
  // default: review.mode defaults to optional (domain/config/schema.js), so the
  // merge clause has to be scoped to the configured-required case.
  assert.doesNotMatch(en.meta.description, /merge only after review/)
  assert.match(en.meta.description, /merge after review when review before merging is required/)
  assert.match(zh.meta.description, /在把合并前审查设为必须时，审查通过后再合并/)
  // The reviewed Chinese calques must not come back.
  const zhText = JSON.stringify(zh)
  for (const calque of ['收口', '在线状态文件', '锁状态的恢复出口', '关闭该行', '本行', '认领一项命名工作', '允许关闭本行']) {
    assert.equal(zhText.includes(calque), false, `zh copy still contains the calque "${calque}"`)
  }
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
