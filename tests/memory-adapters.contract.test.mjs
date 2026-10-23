// Contract tests for the no-disk/no-git doubles under tests/support (#50).
//
// The doubles exist so a future Tower lifecycle can inject a store and a vcs
// instead of importing adapters/store.js and adapters/git.js. These tests pin the two
// properties that make that possible:
//
//   1. surface parity - the doubles expose what app/tower.js actually calls;
//   2. storage semantics - serialization under withLock, atomic visibility for
//      writeJsonAtomic, and complete lines for appendJsonl;
//   3. purity - the doubles themselves never import fs or child_process.
//
// Run with: node --test tests/memory-adapters.contract.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import * as realStore from '../adapters/store.js'
import * as realGit from '../adapters/git.js'
import { Tower } from '../host/tower.js'
import { registerTowerTools } from '../host/tool-registry.js'
import { PORTS } from '../ports/index.js'
import { createDefaultDeps } from '../adapters/default.js'
import { TowerToolError } from '../domain/errors.js'
import { createMemoryStore, MEMORY_SCHEME } from './support/memory-store.js'
import { createScriptedVcs } from './support/scripted-vcs.js'

const COMMON_DIR = '/virtual/repo/.git'
const STORE_SURFACE = ['pathsFor', 'readJson', 'writeJsonAtomic', 'appendJsonl', 'withLock']
const STORE_EXTRA_SURFACE = ['exists', 'ensureDir']
const VCS_SURFACE = ['git', 'tryGit', 'revParse', 'isClean', 'isAncestor']

function freshStore(options) {
  const store = createMemoryStore(options)
  const paths = store.pathsFor(COMMON_DIR)
  return { store, paths }
}

function seedState(value = { schemaVersion: 1, revision: 0, missions: [] }) {
  return { schemaVersion: 1, revision: 0, missions: [], ...value }
}

test('memory store exposes the state-store surface app/tower.js imports', () => {
  const store = createMemoryStore()
  const paths = store.pathsFor(COMMON_DIR)
  const realPaths = realStore.pathsFor(COMMON_DIR)

  assert.deepEqual(Object.keys(paths).sort(), Object.keys(realPaths).sort())
  for (const name of [...STORE_SURFACE, ...STORE_EXTRA_SURFACE]) {
    assert.equal(typeof store[name], typeof realStore[name], `store.${name} must match adapters/store.js`)
  }
  for (const value of Object.values(paths)) {
    assert.ok(value.startsWith(MEMORY_SCHEME), `pathsFor values must be virtual, saw ${value}`)
    assert.ok(!value.includes('\\'), `pathsFor values must be normalized, saw ${value}`)
  }
})

test('scripted vcs exposes the git surface Tower calls', () => {
  const vcs = createScriptedVcs()
  for (const name of VCS_SURFACE) {
    assert.equal(typeof realGit[name], 'function', `adapters/git.js must export ${name}`)
    assert.equal(typeof Tower.prototype[name], 'function', `Tower must expose ${name}`)
    assert.equal(typeof vcs[name], 'function', `scripted vcs must expose ${name}`)
  }
})

test('writeJsonAtomic is atomic for an interleaved reader', async () => {
  let blockNext = false
  let staged = false
  let releaseWrite
  const blocked = new Promise((resolve) => {
    releaseWrite = resolve
  })
  const { store, paths } = freshStore({
    hooks: {
      beforeCommit: async () => {
        if (!blockNext) return
        blockNext = false
        staged = true
        await blocked
      },
    },
  })
  await store.ensureDir(paths.dir)
  const before = seedState()
  await store.writeJsonAtomic(paths.state, before)

  blockNext = true
  const pending = store.writeJsonAtomic(paths.state, seedState({ revision: 1, missions: [{ id: 'M1' }] }))
  while (!staged) await new Promise((resolve) => setImmediate(resolve))
  // The commit has not happened yet: a reader sees the complete previous value,
  // never a half-serialized document.
  assert.deepEqual(await store.readJson(paths.state), before)
  releaseWrite()
  await pending
  assert.equal((await store.readJson(paths.state)).revision, 1)
})

test('writeJsonAtomic keeps the previous value when serialization or commit fails', async () => {
  const { store, paths } = freshStore()
  await store.ensureDir(paths.dir)
  const before = seedState()
  await store.writeJsonAtomic(paths.state, before)

  const circular = {}
  circular.self = circular
  await assert.rejects(() => store.writeJsonAtomic(paths.state, circular), /circular/i)
  assert.deepEqual(await store.readJson(paths.state), before)
  // A failed write must not leave a temporary artifact behind in the store.
  assert.deepEqual(store.inspect.paths(), [paths.state])

  let failNext = false
  const flaky = createMemoryStore({
    hooks: {
      beforeCommit: async () => {
        if (!failNext) return
        failNext = false
        throw new Error('simulated crash before commit')
      },
    },
  })
  const flakyPaths = flaky.pathsFor(COMMON_DIR)
  await flaky.ensureDir(flakyPaths.dir)
  await flaky.writeJsonAtomic(flakyPaths.state, before)
  failNext = true
  await assert.rejects(() => flaky.writeJsonAtomic(flakyPaths.state, seedState({ revision: 9 })), /simulated crash/)
  assert.deepEqual(await flaky.readJson(flakyPaths.state), before)
  // The next write still succeeds once the injected failure is gone.
  await flaky.writeJsonAtomic(flakyPaths.state, seedState({ revision: 2 }))
  assert.equal((await flaky.readJson(flakyPaths.state)).revision, 2)
})

test('withLock serializes concurrent read-modify-write mutations without lost updates', async () => {
  const { store, paths } = freshStore()
  await store.ensureDir(paths.dir)
  await store.writeJsonAtomic(paths.state, seedState())

  const jobs = 24
  await Promise.all(
    Array.from({ length: jobs }, (_, index) =>
      store.withLock(paths, async () => {
        const state = await store.readJson(paths.state)
        // Force interleaving opportunities between every read and write.
        await new Promise((resolve) => setTimeout(resolve, index % 3))
        state.revision += 1
        state.missions.push({ id: `M${index + 1}` })
        await store.writeJsonAtomic(paths.state, state)
        await store.appendJsonl(paths.activity, { type: 'mutation', revision: state.revision })
      }),
    ),
  )

  const final = await store.readJson(paths.state)
  assert.equal(final.revision, jobs, 'every locked mutation must be observed')
  assert.equal(final.missions.length, jobs)
  assert.equal(new Set(final.missions.map((mission) => mission.id)).size, jobs)
  assert.equal(store.inspect.stats.maxConcurrentLocks, 1, 'lock bodies must never overlap')
  assert.equal(store.inspect.stats.activeLocks, 0)
  assert.equal(store.inspect.isLocked(paths.lock), false)

  const events = store.inspect.readActivity(paths.activity)
  assert.equal(events.length, jobs)
  assert.deepEqual(
    events.map((event) => event.revision),
    Array.from({ length: jobs }, (_, index) => index + 1),
    'activity lines must follow lock order',
  )
})

test('two-phase writers revalidate the revision inside the lock and the loser fails closed', async () => {
  const { store, paths } = freshStore()
  await store.ensureDir(paths.dir)
  await store.writeJsonAtomic(paths.state, seedState())

  // Both callers prepare against revision 0, like Tower.complete (two-phase #51).
  const preparedRevision = (await store.readJson(paths.state)).revision
  const attempt = () =>
    store.withLock(paths, async () => {
      const state = await store.readJson(paths.state)
      if (state.revision !== preparedRevision) {
        throw new TowerToolError('stale-base', 'tower state changed while the operation was being prepared; retry')
      }
      state.revision += 1
      state.missions.push({ id: 'M1' })
      await store.writeJsonAtomic(paths.state, state)
      await store.appendJsonl(paths.activity, { type: 'complete', revision: state.revision })
    })

  const results = await Promise.allSettled([attempt(), attempt()])
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  const failed = results.find((result) => result.status === 'rejected')
  assert.equal(failed.reason.code, 'stale-base')
  assert.match(failed.reason.message, /\[tower:stale-base\]/)
  assert.equal((await store.readJson(paths.state)).revision, 1, 'the stale writer must not overwrite the winner')
  assert.equal(store.inspect.stats.maxConcurrentLocks, 1)
})

test('withLock releases the lock when a mutation throws', async () => {
  const { store, paths } = freshStore()
  await store.ensureDir(paths.dir)
  await store.writeJsonAtomic(paths.state, seedState())

  await assert.rejects(
    () =>
      store.withLock(paths, async () => {
        throw new Error('boom')
      }),
    /boom/,
  )
  assert.equal(store.inspect.stats.activeLocks, 0)
  assert.equal(store.inspect.isLocked(paths.lock), false)

  await store.withLock(paths, async () => {
    const state = await store.readJson(paths.state)
    state.revision += 1
    await store.writeJsonAtomic(paths.state, state)
  })
  assert.equal((await store.readJson(paths.state)).revision, 1)
  assert.equal(store.inspect.stats.maxConcurrentLocks, 1)
  assert.equal(store.inspect.stats.lockHolds.length, 2)
})

test('appendJsonl keeps every line whole under concurrent appends', async () => {
  const { store, paths } = freshStore()
  await store.ensureDir(paths.dir)
  const count = 50
  await Promise.all(
    Array.from({ length: count }, (_, index) =>
      store.appendJsonl(paths.activity, { index, text: 'x'.repeat(100) }),
    ),
  )
  const text = store.inspect.readText(paths.activity)
  const lines = text.split('\n').filter(Boolean)
  assert.equal(lines.length, count)
  for (const line of lines) {
    const record = JSON.parse(line)
    assert.equal(record.text.length, 100)
    assert.equal(typeof record.index, 'number')
  }
})

test('scripted vcs models the commands Tower issues and rejects everything else', async () => {
  const vcs = createScriptedVcs()
  const repo = vcs.repoRoot
  const seed = vcs.seed({ branch: 'main', message: 'seed' })
  assert.equal(await vcs.revParse(repo, 'HEAD'), seed)
  assert.equal(await vcs.isClean(repo), true)

  const base = await vcs.revParse(repo, 'main')
  const worktree = '/virtual/worktrees/M1'
  await vcs.git(repo, ['worktree', 'add', '-b', 'tower/m1-test', worktree, base])
  assert.equal(await vcs.isClean(worktree), true)
  assert.deepEqual(vcs.worktreePaths(), [worktree])

  const workTip = vcs.commit(worktree, 'feat: scripted work')
  assert.ok(await vcs.isAncestor(repo, base, workTip))
  assert.equal(await vcs.isAncestor(repo, workTip, base), false)

  await vcs.git(repo, ['merge', '--no-ff', workTip, '-m', 'tower: merge M1'])
  const merged = await vcs.revParse(repo, 'HEAD')
  assert.deepEqual(vcs.mergeParents(merged), [seed, workTip])
  assert.ok(await vcs.isAncestor(repo, workTip, merged))

  await vcs.git(repo, ['worktree', 'remove', '--force', worktree])
  await vcs.git(repo, ['branch', '-d', 'tower/m1-test'])
  assert.equal(vcs.branchTip('tower/m1-test'), null)
  assert.deepEqual(vcs.worktreePaths(), [])

  await assert.rejects(
    () => vcs.git(repo, ['push']),
    (error) => error.name === 'GitError' && /unsupported scripted git command: push/.test(error.message),
  )
  assert.equal(await vcs.tryGit(repo, ['push']), null)
  assert.equal(vcs.unscripted.length, 2)
  assert.ok(vcs.calls.length > 0)
  assert.ok(vcs.calls.every((call) => call.cwd.startsWith('/virtual/')), 'every scripted call stays virtual')
})

test('the default adapters implement every port declared in ports/', () => {
  const deps = createDefaultDeps()
  for (const [member, port] of Object.entries(PORTS)) {
    assert.ok(deps[member], `default deps must expose the ${member} port`)
    for (const method of port.contract.methods) {
      assert.equal(
        typeof deps[member][method],
        'function',
        `${member}.${method} must exist at runtime on the ${port.contract.name} implementation`,
      )
    }
  }
})

test('the in-memory doubles implement the store and vcs port contracts', () => {
  const store = createMemoryStore()
  const vcs = createScriptedVcs()
  const implementations = new Map([
    [PORTS.store, store],
    [PORTS.vcs, vcs],
  ])
  for (const [port, impl] of implementations) {
    for (const method of port.contract.methods) {
      assert.equal(typeof impl[method], 'function', `${port.contract.name}.${method} must exist on the double`)
    }
  }
})

test('Tower validates its injected ports at construction', () => {
  const repo = { root: '/virtual/repo', commonDir: '/virtual/repo/.git' }
  assert.throws(() => new Tower(repo, {}, {}), /store: expected an object implementing StorePort/)
  assert.throws(() => new Tower(repo, {}, null), /requires an injected deps object/)
})

/** The minimal registration context: tools are captured, effects are disposable. */
function makeRegistrationCtx() {
  const tools = new Map()
  const disposers = []
  const ctx = {
    effect(fn) {
      const dispose = fn()
      const disposer = typeof dispose === 'function' ? dispose : () => {}
      disposers.push(disposer)
      return disposer
    },
    get() {
      return undefined
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => {}
      },
      guard() {
        return () => {}
      },
    },
    systemPrompt: { section() {} },
  }
  return { ctx, tools, dispose: () => disposers.forEach((dispose) => dispose()) }
}

/**
 * Every `deps.<port>.<method>` call under `root`, recursively.
 * Returns `{ calls, files }`, where `calls` maps `member.method` to the source
 * files that call it and `files` counts the modules scanned.
 */
function collectPortCalls(root) {
  const calls = new Map()
  let files = 0
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(new URL(`${entry.name}/`, dir))
      } else if (entry.name.endsWith('.js')) {
        files += 1
        const file = new URL(entry.name, dir)
        const source = fs.readFileSync(file, 'utf8')
        for (const match of source.matchAll(/deps\.([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
          const key = `${match[1]}.${match[2]}`
          if (!calls.has(key)) calls.set(key, new Set())
          calls.get(key).add(file.pathname)
        }
      }
    }
  }
  walk(root)
  return { calls, files }
}

test('every deps port call in app/** and tools/** is declared by its port', () => {
  // #69: the contracts are only a substitutability guarantee if they declare
  // every method the receiving layers call. Both layers receive the same deps
  // object (app through Tower, tools through openTower), so both are scanned:
  // tools/recover.js calling an undeclared store.rename is exactly the kind of
  // gap an app-only scan misses.
  const roots = {
    app: new URL('../app/', import.meta.url),
    tools: new URL('../tools/', import.meta.url),
  }
  const calls = new Map()
  const scanned = {}
  for (const [name, root] of Object.entries(roots)) {
    const found = collectPortCalls(root)
    scanned[name] = found.files
    for (const [key, files] of found.calls) {
      if (!calls.has(key)) calls.set(key, new Set())
      for (const file of files) calls.get(key).add(file)
    }
  }
  assert.ok(scanned.app > 0 && scanned.tools > 0, `both layers must be scanned, saw ${JSON.stringify(scanned)}`)
  assert.ok(calls.size > 0, 'the app and tools layers must reach their dependencies through deps')
  const missing = []
  for (const key of [...calls.keys()].sort()) {
    const [member, method] = key.split('.')
    const port = PORTS[member]
    if (!port) missing.push(`${key} (no such port member: ${member})`)
    else if (!port.contract.methods.includes(method)) missing.push(`${key} <- ${[...calls.get(key)].join(', ')}`)
  }
  assert.deepEqual(missing, [], `ports must declare every deps call in app/** and tools/**: ${missing.join('; ')}`)
})

test('the composition root supplies the ports the registry injects', async () => {
  // #69: index.js constructs the adapter set once and passes it to
  // registerTowerTools; the registry must inject that set into every Tower.
  const deps = createDefaultDeps()
  const sentinel = {
    ...deps,
    vcs: {
      ...deps.vcs,
      resolveRepo: async () => {
        throw new Error('sentinel-composition-root: injected ports were used')
      },
    },
  }
  const { ctx, tools, dispose } = makeRegistrationCtx()
  try {
    registerTowerTools(ctx, { deps: sentinel })
    const status = tools.get('tower_status')
    assert.ok(status, 'tower_status is registered')
    await assert.rejects(
      () => status.execute({ repoRoot: '/virtual/repo' }, { agent: { id: 'contract-test' } }),
      /sentinel-composition-root/,
      'the registry must open the Tower with the host-supplied port set',
    )
  } finally {
    dispose()
  }
})

test('the doubles have no filesystem or process dependency', () => {
  const supportDir = new URL('./support/', import.meta.url)
  const sources = new Map(
    ['memory-store.js', 'scripted-vcs.js'].map((name) => [name, fs.readFileSync(new URL(name, supportDir), 'utf8')]),
  )

  // Only the neutral error type is imported: no store/git adapter, no node: modules.
  const expectedImports = new Map([['memory-store.js', ['../../domain/errors.js']], ['scripted-vcs.js', []]])
  for (const [name, source] of sources) {
    const specifiers = [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1])
    assert.deepEqual(specifiers, expectedImports.get(name), `${name} must not import infrastructure`)
    assert.doesNotMatch(
      source,
      /(from|require\()\s*['"]node:(fs|fs\/promises|child_process|os|net|http|https|worker_threads)['"]/,
      `${name} must not import a node: I/O module`,
    )
    assert.doesNotMatch(
      source,
      /\b(execFile|execFileSync|spawnSync|spawn|readFileSync|writeFileSync|createReadStream|createWriteStream|openSync)\b/,
      `${name} must not call a disk or process API`,
    )
    assert.doesNotMatch(source, /require\s*\(/, `${name} must stay ESM`)
  }
})
