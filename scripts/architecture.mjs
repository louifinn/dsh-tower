// Architecture fitness functions (#55).
//
// Rules are intentionally staged: rules for not-yet-migrated areas are
// warnings (printed, exit 0) and flip to errors in the PR that makes them true.
// The evaluator is exported so tests can seed one fixture violation per rule.
//
// Exemptions are justified data, not bare sets (#80). Every waiver lives in
// scripts/architecture-waivers.json and carries a reason plus an owner or
// reference; an unexplained waiver is itself a blocking `waiver-contract`
// violation, so a bare path can no longer turn the gate green. The
// ambient-state waivers must also name the exact top-level binding, which
// exempts one variable rather than the whole file. The scan is
// statement-aware: it records every binding of every top-level `let`
// declaration, so a new top-level `let` in a previously exempt file — even a
// second declarator or a second statement on the waived binding's line — is
// still a violation. The green summary prints the number of waivers applied.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = path.resolve(MODULE_DIR, '..')
const WAIVER_FILE = path.join(MODULE_DIR, 'architecture-waivers.json')
const WAIVER_LABEL = 'scripts/architecture-waivers.json'
const ROOTS = ['lib', 'app', 'domain', 'tools', 'adapters', 'ports']
const RULES = new Set([
  'domain-pure',
  'child-process-surface',
  'fs-surface',
  'app-ports-only',
  'composition-root',
  'port-shape',
  'tools-thin',
  'tools-vocabulary',
  'aggregate-size',
  'ambient-state',
])
// #69: the app layer may import only these. App siblings (`./x.js`), the pure
// domain, and the explicit ports are the whole dependency surface.
const APP_ALLOWED_PREFIXES = ['./', '../domain/', '../ports/']
const APP_ALLOWED_EXACT = new Set(['node:path'])
// #69: only the host entries (index.js/worker.js/reviewer.js, outside this scan
// set) and the adapters may import adapters. lib/ is the infrastructure layer
// below the ports and is retired by #70; until then it is the one documented
// importer exemption, and app/tools/domain/ports never may.
const COMPOSITION_ROOT_EXEMPT_PREFIXES = ['lib/']
const ADAPTER_IMPORT = /^(?:\.\.\/)?adapters(?:\/|$)/
// #69: a port must be a runtime contract, not a comment plus `export {}`.
const RUNTIME_PORT_EXPORT = /^export\s+(?:const|function|class)\s/m
// #69: port modules must not reach into an implementation.
const PORT_IMPLEMENTATION_IMPORT = /^(?:\.\.\/)?(?:adapters|lib|app|tools)(?:\/|$)/
const LITERAL_PATTERN = /enum:\s*\[\s*'(?:planned|active|completed|blocked|paused|abandoned|worker|reviewer|bug|improve|vuln|idea|low|medium|high|critical|open|triaged|fixed|wontfix)'/
const TOOL_LITERAL_PATTERN = /(?:===|!==|==|!=|\.includes\(|case\s+)'?(?:planned|active|completed|blocked|paused|abandoned|worker|reviewer|bug|improve|vuln|idea|low|medium|high|critical|open|triaged|fixed|wontfix|create|abandon|close|status|merge|fix-then-merge|hold|acquire|release|map|user|failure|resource|dependency|json|markdown)'/
// #80: ambient-state is per binding, and the scan is statement-aware rather
// than line-based. A top-level `let` is a declaration only at module top level
// (brace, bracket and paren depths all zero) when it starts a statement: the
// first token of a line, the start of the file, or a token after `;`, `}` or
// `export`. Every declarator is recorded, so both `let a = 1, b = 2` and
// `let a = 1; let b = 2` need a waiver for `b`; only the named binding is
// exempt. Strings, comments, template literals and regex literals are skipped so
// their contents can neither hide nor fake a binding.
const REGEX_ALLOWED_PUNCT = new Set([
  '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '/', '%',
  '<', '>', '^', '~', '=>', '...', '==', '===', '!=', '!==', '<=', '>=', '&&', '||', '??',
  '?.', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**', '<<', '>>', '>>>', '**=', '<<=', '>>=', '>>>=',
])
const REGEX_ALLOWED_WORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw',
  'case', 'do', 'else', 'yield', 'await', 'export', 'default',
])
const PUNCT_OPERATORS = [
  '>>>=', '...', '===', '!==', '**=', '>>=', '<<=', '>>>', '=>', '==', '!=', '<=', '>=',
  '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**', '<<', '>>',
]
// A `let` initializer ends at `;`, at a top-level `,`, or at automatic semicolon
// insertion: a newline before a token that cannot continue the expression.
// Without that stop a single-declarator initializer would run on into the next
// statement and duplicate or invent bindings.
const CONTINUATION_PUNCT = new Set([
  '.', '?.', '(', '[', '+', '-', '*', '/', '%', '**', '&&', '||', '??', '?', ':', '=', '=>',
  '==', '===', '!=', '!==', '<', '>', '<=', '>=', '&', '|', '^', '<<', '>>', '>>>',
  '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**=', '<<=', '>>=', '>>>=',
])
const CONTINUATION_WORDS = new Set(['instanceof', 'in', 'of'])

function endsExpression(token) {
  if (!token) return false
  if (token.type === 'word') return !REGEX_ALLOWED_WORDS.has(token.value)
  if (token.type === 'punct') {
    return token.value === ')' || token.value === ']' || token.value === '}' || token.value === '++' || token.value === '--'
  }
  return true // string, number, template or regex literal
}

function continuesExpression(token) {
  if (!token) return false
  if (token.type === 'punct') return CONTINUATION_PUNCT.has(token.value)
  if (token.type === 'word') return CONTINUATION_WORDS.has(token.value)
  return token.type === 'template' // tagged template
}

function isIdentifierStart(code) {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95 || code === 36
}

function isIdentifierPart(code) {
  return isIdentifierStart(code) || (code >= 48 && code <= 57)
}

function isDigit(code) {
  return code >= 48 && code <= 57
}

function skipLineComment(source, start) {
  let index = start
  while (index < source.length && source[index] !== '\n') index += 1
  return index
}

function skipBlockComment(source, start) {
  const end = source.indexOf('*/', start + 2)
  return end === -1 ? source.length : end + 2
}

function skipQuoted(source, start, quote) {
  let index = start + 1
  while (index < source.length) {
    if (source[index] === '\\') index += 2
    else if (source[index] === quote) return index + 1
    else index += 1
  }
  return source.length
}

function skipTemplate(source, start) {
  let index = start + 1
  while (index < source.length) {
    const char = source[index]
    if (char === '\\') index += 2
    else if (char === '`') return index + 1
    else if (char === '$' && source[index + 1] === '{') index = skipInterpolation(source, index + 2)
    else index += 1
  }
  return source.length
}

function skipInterpolation(source, start) {
  let depth = 1
  let index = start
  while (index < source.length) {
    const char = source[index]
    if (char === "'" || char === '"') index = skipQuoted(source, index, char)
    else if (char === '`') index = skipTemplate(source, index)
    else if (char === '/' && source[index + 1] === '/') index = skipLineComment(source, index)
    else if (char === '/' && source[index + 1] === '*') index = skipBlockComment(source, index)
    else if (char === '{') { depth += 1; index += 1 }
    else if (char === '}') {
      depth -= 1
      index += 1
      if (depth === 0) return index
    } else index += 1
  }
  return source.length
}

function skipRegex(source, start) {
  let index = start + 1
  let inClass = false
  while (index < source.length) {
    const char = source[index]
    if (char === '\\') index += 2
    else if (char === '\n') return -1
    else if (char === '[') { inClass = true; index += 1 }
    else if (char === ']') { inClass = false; index += 1 }
    else if (char === '/' && !inClass) {
      index += 1
      while (index < source.length && /[a-z]/i.test(source[index])) index += 1
      return index
    } else index += 1
  }
  return -1
}

function regexAllowed(previous) {
  if (!previous) return true
  if (previous.type === 'word') return REGEX_ALLOWED_WORDS.has(previous.value)
  if (previous.type === 'punct') return REGEX_ALLOWED_PUNCT.has(previous.value)
  return false
}

function tokenize(source) {
  const tokens = []
  let index = 0
  let newline = false
  const push = (type, value) => {
    tokens.push({ type, value, newlineBefore: newline })
    newline = false
  }
  while (index < source.length) {
    const code = source.charCodeAt(index)
    if (code === 10) { newline = true; index += 1; continue }
    if (code === 13 || code === 32 || code === 9 || code === 11 || code === 12 || code === 0xa0 || code === 0xfeff) { index += 1; continue }
    const char = source[index]
    if (char === '#' && source[index + 1] === '!') {
      index = skipLineComment(source, index)
      newline = true
      continue
    }
    if (char === '/' && source[index + 1] === '/') {
      index = skipLineComment(source, index)
      continue
    }
    if (char === '/' && source[index + 1] === '*') {
      const end = skipBlockComment(source, index)
      if (source.slice(index, end).includes('\n')) newline = true
      index = end
      continue
    }
    if (char === "'" || char === '"') {
      const end = skipQuoted(source, index, char)
      push('string', source.slice(index, end))
      index = end
      continue
    }
    if (char === '`') {
      const end = skipTemplate(source, index)
      push('template', source.slice(index, end))
      index = end
      continue
    }
    if (char === '/' && regexAllowed(tokens[tokens.length - 1])) {
      const end = skipRegex(source, index)
      if (end !== -1) {
        push('regex', source.slice(index, end))
        index = end
        continue
      }
    }
    if (isIdentifierStart(code)) {
      let end = index + 1
      while (end < source.length && isIdentifierPart(source.charCodeAt(end))) end += 1
      push('word', source.slice(index, end))
      index = end
      continue
    }
    if (isDigit(code)) {
      let end = index + 1
      while (end < source.length && (isIdentifierPart(source.charCodeAt(end)) || source[end] === '.')) end += 1
      push('number', source.slice(index, end))
      index = end
      continue
    }
    let operator = char
    for (const candidate of PUNCT_OPERATORS) {
      if (source.startsWith(candidate, index)) { operator = candidate; break }
    }
    push('punct', operator)
    index += operator.length
  }
  return tokens
}

function skipBalanced(tokens, start) {
  const open = tokens[start].value
  const close = open === '{' ? '}' : open === '[' ? ']' : ')'
  let depth = 0
  for (let index = start; index < tokens.length; index += 1) {
    if (tokens[index].value === open) depth += 1
    else if (tokens[index].value === close) {
      depth -= 1
      if (depth === 0) return index + 1
    }
  }
  return -1
}

function skipExpression(tokens, start, stops) {
  let depth = 0
  for (let index = start; index < tokens.length; index += 1) {
    const token = tokens[index]
    const value = token.value
    if (depth === 0) {
      if (stops.has(value)) return index
      if (token.newlineBefore && endsExpression(tokens[index - 1]) && !continuesExpression(token)) {
        // Automatic semicolon insertion ends the declaration here.
        return index
      }
    }
    if (value === '(' || value === '[' || value === '{') depth += 1
    else if (value === ')' || value === ']' || value === '}') {
      if (depth === 0) return index
      depth -= 1
    }
  }
  return tokens.length
}

function readPattern(tokens, start) {
  const isObject = tokens[start].value === '{'
  const close = isObject ? '}' : ']'
  const names = []
  let index = start + 1
  while (index < tokens.length) {
    const token = tokens[index]
    if (token.value === close) return { names, next: index + 1 }
    if (token.value === ',') { index += 1; continue }
    if (token.value === '...') {
      const target = readBindingTarget(tokens, index + 1)
      if (!target) return { names, next: index + 1 }
      names.push(...target.names)
      index = target.next
    } else if (!isObject) {
      const target = readBindingTarget(tokens, index)
      if (!target) { index += 1; continue }
      names.push(...target.names)
      index = target.next
    } else if (token.value === '[') {
      // A computed key is an expression, not a binding.
      const next = skipBalanced(tokens, index)
      if (next === -1) return { names, next: index + 1 }
      index = next
      if (tokens[index]?.value !== ':') continue
      index += 1
      const target = readBindingTarget(tokens, index)
      if (!target) return { names, next: index }
      names.push(...target.names)
      index = target.next
    } else if (token.type === 'word' && tokens[index + 1]?.value === ':') {
      index += 2
      const target = readBindingTarget(tokens, index)
      if (!target) return { names, next: index }
      names.push(...target.names)
      index = target.next
    } else if (token.type === 'word') {
      names.push(token.value) // shorthand `{ name }`
      index += 1
    } else {
      index += 1
      continue
    }
    if (tokens[index]?.value === '=') index = skipExpression(tokens, index + 1, new Set([',', close]))
  }
  return { names, next: index }
}

function readBindingTarget(tokens, index) {
  const token = tokens[index]
  if (!token) return null
  if (token.type === 'word') return { names: [token.value], next: index + 1 }
  if (token.value === '{' || token.value === '[') return readPattern(tokens, index)
  return null
}

function readLetBindings(tokens, start) {
  const names = []
  let index = start + 1
  while (index < tokens.length) {
    const target = readBindingTarget(tokens, index)
    if (!target) break
    names.push(...target.names)
    index = target.next
    if (tokens[index]?.value === '=') index = skipExpression(tokens, index + 1, new Set([',', ';']))
    if (tokens[index]?.value !== ',') break
    index += 1
  }
  return names
}

function scanAmbientBindings(source) {
  const tokens = tokenize(source)
  const bindings = []
  let braces = 0
  let brackets = 0
  let parens = 0
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token.type === 'punct') {
      if (token.value === '{') braces += 1
      else if (token.value === '}') braces = Math.max(0, braces - 1)
      else if (token.value === '[') brackets += 1
      else if (token.value === ']') brackets = Math.max(0, brackets - 1)
      else if (token.value === '(') parens += 1
      else if (token.value === ')') parens = Math.max(0, parens - 1)
    }
    if (braces !== 0 || brackets !== 0 || parens !== 0) continue
    if (token.type !== 'word' || token.value !== 'let') continue
    const previous = tokens[index - 1]
    const startsStatement =
      !previous ||
      token.newlineBefore ||
      previous.value === ';' ||
      previous.value === '}' ||
      (previous.type === 'word' && previous.value === 'export')
    if (!startsStatement) continue
    bindings.push(...readLetBindings(tokens, index))
  }
  return bindings
}

function walk(root, relative = '') {
  const dir = path.join(root, relative)
  if (!fs.existsSync(dir)) return []
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const next = path.join(relative, entry.name)
    if (entry.isDirectory()) out.push(...walk(root, next))
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) out.push(next.split(path.sep).join('/'))
  }
  return out
}

function loadWaivers(file = WAIVER_FILE) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  const waivers = Array.isArray(parsed) ? parsed : parsed?.waivers
  if (!Array.isArray(waivers)) throw new Error('waivers must be an array or an object with a waivers array')
  return waivers
}

function evaluator(root, options = {}) {
  const files = ROOTS.flatMap((dir) => walk(root, dir)).filter((file) => !file.includes('/node_modules/'))
  const violations = []
  const record = (rule, file, detail, level, match) => {
    violations.push(match === undefined ? { rule, file, detail, level } : { rule, file, detail, level, match })
  }

  let waivers
  if (options.waivers !== undefined) {
    waivers = options.waivers
    if (!Array.isArray(waivers)) {
      record('waiver-contract', WAIVER_LABEL, 'waivers must be an array', 'error')
      waivers = []
    }
  } else {
    try {
      waivers = loadWaivers(options.waiverFile)
    } catch (error) {
      record('waiver-contract', WAIVER_LABEL, `cannot read waivers: ${error?.message ?? error}`, 'error')
      waivers = []
    }
  }

  // Every waiver is validated before it is allowed to suppress a violation.
  // An invalid entry names its rule and path in the failure so the reviewer can
  // see exactly which decision is missing.
  const validWaivers = []
  waivers.forEach((waiver, index) => {
    const label = `waiver[${index}]`
    if (waiver === null || typeof waiver !== 'object' || Array.isArray(waiver)) {
      record('waiver-contract', WAIVER_LABEL, `${label} is not an object`, 'error')
      return
    }
    const rule = typeof waiver.rule === 'string' ? waiver.rule.trim() : ''
    const file = typeof waiver.path === 'string' ? waiver.path.trim() : ''
    const reason = typeof waiver.reason === 'string' ? waiver.reason.trim() : ''
    const owner = typeof waiver.owner === 'string' ? waiver.owner.trim() : ''
    const ref = typeof waiver.ref === 'string' ? waiver.ref.trim() : ''
    const match = typeof waiver.match === 'string' ? waiver.match.trim() : ''
    const where = file || '<unknown path>'
    let valid = true
    if (!rule) {
      record('waiver-contract', where, `${label} has no rule${file ? ` for ${file}` : ''}`, 'error')
      valid = false
    } else if (!RULES.has(rule)) {
      record('waiver-contract', where, `${label} for ${where} names unknown rule "${rule}"`, 'error')
      valid = false
    }
    if (!file) {
      record('waiver-contract', where, `${label}${rule ? ` for rule "${rule}"` : ''} has no path`, 'error')
      valid = false
    } else if (path.isAbsolute(file) || file.includes('\\') || file.split('/').includes('..')) {
      record(
        'waiver-contract',
        where,
        `${label} for rule "${rule}" uses a repo-relative path with forward slashes: ${file}`,
        'error',
      )
      valid = false
    }
    if (!reason) {
      record('waiver-contract', where, `${label} for rule "${rule}" on ${where} has no reason`, 'error')
      valid = false
    }
    if (!owner && !ref) {
      record('waiver-contract', where, `${label} for rule "${rule}" on ${where} has no owner or reference`, 'error')
      valid = false
    }
    if (rule === 'ambient-state' && !match) {
      record(
        'waiver-contract',
        where,
        `${label} for rule "ambient-state" on ${where} must name the exact binding with "match"`,
        'error',
      )
      valid = false
    }
    // domain-pure and domain/** are load-bearing: there is no exemption path
    // for them, not even a justified one (#80).
    if (rule === 'domain-pure') {
      record('waiver-contract', where, `${label} for rule "domain-pure" on ${where} cannot be waived`, 'error')
      valid = false
    }
    if (file.startsWith('domain/')) {
      record('waiver-contract', where, `${label} for rule "${rule}" on ${where} cannot waive domain/**`, 'error')
      valid = false
    }
    if (valid) validWaivers.push({ rule, path: file, match: match || undefined, reason, owner: owner || undefined, ref: ref || undefined })
  })

  for (const file of files) {
    const text = fs.readFileSync(path.join(root, file), 'utf8')
    const lines = text.split('\n')
    const imports = [...text.matchAll(/from\s+'([^']+)'|require\('([^']+)'\)/g)].map((match) => match[1] ?? match[2])
    if (file.startsWith('domain/') && imports.some((spec) => /^(node:fs|node:fs\/promises|node:child_process|\.\.\/adapters|adapters\/)/.test(spec))) {
      record('domain-pure', file, 'domain imports I/O or adapters', 'error')
    }
    if (imports.includes('node:child_process')) {
      record('child-process-surface', file, 'only adapters/** may spawn processes', 'error')
    }
    if (imports.some((spec) => spec === 'node:fs' || spec === 'node:fs/promises')) {
      record('fs-surface', file, 'only adapters/** may use fs', 'error')
    }
    // #69 app-ports-only: the app depends on ports, the pure domain, and Node's
    // path module. Adapters and lib/ infrastructure are reached through deps.
    if (file.startsWith('app/')) {
      for (const spec of imports) {
        const allowed =
          APP_ALLOWED_EXACT.has(spec) ||
          APP_ALLOWED_PREFIXES.some((prefix) => spec.startsWith(prefix))
        if (!allowed) {
          record(
            'app-ports-only',
            file,
            `imports ${spec}; app/** may import only app siblings, domain/**, ports/** and node:path`,
            'error',
          )
        }
      }
    }
    // #69 composition-root: only the host entries and the adapters may import an
    // adapter; lib/ is the documented infrastructure lapse until #70.
    if (!COMPOSITION_ROOT_EXEMPT_PREFIXES.some((prefix) => file.startsWith(prefix)) && !file.startsWith('adapters/')) {
      for (const spec of imports) {
        if (ADAPTER_IMPORT.test(spec)) {
          record('composition-root', file, `imports ${spec}; adapters are composed once in the host entry`, 'error')
        }
      }
    }
    // #69 port-shape: a port module exports a runtime contract and imports no
    // implementation. `export {}` alone is a comment, not a seam.
    if (file.startsWith('ports/')) {
      if (!RUNTIME_PORT_EXPORT.test(text)) {
        record('port-shape', file, 'port modules must export a runtime contract (const/function/class)', 'error')
      }
      for (const spec of imports) {
        if (PORT_IMPLEMENTATION_IMPORT.test(spec)) {
          record('port-shape', file, `imports ${spec}; ports must not depend on an implementation`, 'error')
        }
      }
    }
    if (file.startsWith('tools/')) {
      if (imports.some((spec) => spec.startsWith('node:') && spec !== 'node:path')) {
        record('tools-thin', file, 'tools/** may import only node:path', 'error')
      }
      if (LITERAL_PATTERN.test(text) || TOOL_LITERAL_PATTERN.test(text)) {
        record('tools-vocabulary', file, 'status/type/role literal in tools/**', 'error')
      }
      if (lines.length < 40 || lines.length > 200) {
        record('aggregate-size', file, `${lines.length} lines outside 40-200`, 'error')
      }
    } else if (lines.length > 800) {
      record('aggregate-size', file, `${lines.length} lines exceeds 800`, 'error')
    }
    if (file.startsWith('lib/') || file.startsWith('app/') || file.startsWith('domain/')) {
      for (const binding of scanAmbientBindings(text)) {
        record('ambient-state', file, `top-level let '${binding}' has no justified waiver`, 'error', binding)
      }
    }
  }

  // A waiver only suppresses the violation it names. Path-only waivers cover
  // per-file rules; ambient-state waivers must also match the binding.
  const remaining = []
  let waived = 0
  for (const violation of violations) {
    const waiver = validWaivers.find(
      (entry) =>
        entry.rule === violation.rule &&
        entry.path === violation.file &&
        (entry.match === undefined || entry.match === violation.match),
    )
    if (waiver && violation.level === 'error') {
      waived += 1
      continue
    }
    remaining.push(violation)
  }
  return {
    ok: remaining.every((violation) => violation.level !== 'error'),
    violations: remaining,
    waivers: validWaivers.length,
    waived,
  }
}

const rootArg = process.argv.indexOf('--root')
const root = rootArg > 0 ? path.resolve(process.argv[rootArg + 1]) : PACKAGE_ROOT
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const result = evaluator(root)
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    for (const violation of result.violations) {
      const line = `architecture ${violation.level}: [${violation.rule}] ${violation.file}: ${violation.detail}`
      if (violation.level === 'error') console.error(line)
      else console.warn(line)
    }
    if (result.violations.length === 0) console.log(`architecture: ok (waivers: ${result.waived})`)
  }
  process.exit(result.ok ? 0 : 1)
}

export { evaluator, loadWaivers, WAIVER_FILE }
