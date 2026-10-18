#!/usr/bin/env node
// dsh-tower — enable DSH HMR for this repository inside one DSH profile.
//
// DSH's `@deepseek-ai/dsh-hmr` service watches the directories listed in its
// `root` config and reconciles the profile when files change. The shipped
// profile keeps `root: []` (nothing is watched), so a development checkout has
// to append one loader override to the *user* patch layer:
//
//   <DSH_HOME>/profiles/<profile>/cordis.patch.yml
//
// This script owns exactly one marked block in that file:
//
//   # dsh-tower:dev-hmr
//   - id: hmr
//     config:
//       root:
//         - '<absolute repo path with forward slashes>'
//
// It is idempotent (re-running replaces the block), preserves every other
// line, supports --dry-run and --remove, and never creates a profile.
//
// Usage:
//   node scripts/enable-dev-hmr.mjs [--profile desktop] [--root <dir>]
//                                   [--dry-run] [--remove]
//
// Exit codes: 0 = success or nothing to do, 1 = bad arguments or I/O failure.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** Comment line that starts the managed block. */
export const MARKER = '# dsh-tower:dev-hmr'
const PATCH_FILENAME = 'cordis.patch.yml'

/** Render the managed block (no leading or trailing blank line). */
export function renderBlock(root) {
  const quoted = String(root).replaceAll("'", "''")
  return [MARKER, '- id: hmr', '  config:', '    root:', `      - '${quoted}'`].join('\n')
}

/** Convert a native path to the forward-slash form DSH HMR configs use. */
export function forwardSlashes(value) {
  return String(value).replaceAll('\\', '/')
}

function eolOf(text) {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

// Split into content lines without the trailing empty string produced by a
// final newline. Line endings are normalised to \n while editing.
function contentLines(text) {
  const lines = String(text).replaceAll('\r\n', '\n').split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

function serializeLines(lines, eol) {
  return lines.length === 0 ? '' : `${lines.join(eol)}${eol}`
}

function isTopLevelEntry(line) {
  return /^-[ \t]/.test(line) || line === '-'
}

/**
 * Locate the managed block in a list of lines.
 * The marker names the block; the block is the first loader entry after it
 * plus every indented continuation line. A blank line or an unindented line
 * ends the block, so unrelated comments and entries after it stay untouched.
 * @returns {{ start: number, end: number } | null} half-open line range
 */
export function findBlock(lines) {
  const start = lines.findIndex((line) => line.trim() === MARKER)
  if (start === -1) return null
  let index = start + 1
  while (index < lines.length && lines[index].trim() === '') index += 1
  if (index >= lines.length) return { start, end: lines.length }
  if (!isTopLevelEntry(lines[index])) return { start, end: index }
  index += 1
  while (index < lines.length) {
    const line = lines[index]
    if (line.trim() === '' || !/^[ \t]/.test(line)) break
    index += 1
  }
  return { start, end: index }
}

function findAllBlocks(lines) {
  const spans = []
  let cursor = 0
  while (cursor < lines.length) {
    const span = findBlock(lines.slice(cursor))
    if (span === null) break
    spans.push({ start: span.start + cursor, end: span.end + cursor })
    cursor = span.end + cursor
  }
  return spans
}

/**
 * Insert the managed block, or replace the existing one in place.
 * All lines outside the block are preserved.
 */
export function upsertBlock(text, root) {
  const eol = eolOf(text)
  const lines = contentLines(text)
  const block = renderBlock(root).split('\n')
  const spans = findAllBlocks(lines)

  if (spans.length === 0) {
    if (lines.length > 0 && lines[lines.length - 1].trim() !== '') lines.push('')
    lines.push(...block)
    return serializeLines(lines, eol)
  }

  // Keep the first block, drop any accidental duplicates, then replace.
  for (let index = spans.length - 1; index >= 1; index -= 1) {
    const span = spans[index]
    lines.splice(span.start, span.end - span.start)
  }
  const first = spans[0]
  lines.splice(first.start, first.end - first.start, ...block)

  // Keep one blank line between the block and the next top-level entry so the
  // generated file stays canonical and idempotent.
  const next = first.start + block.length
  if (lines[next] !== undefined && lines[next].trim() !== '') lines.splice(next, 0, '')
  return serializeLines(lines, eol)
}

/** Remove the managed block; other lines are preserved. No block means no change. */
export function removeBlock(text) {
  const eol = eolOf(text)
  const lines = contentLines(text)
  const spans = findAllBlocks(lines)
  if (spans.length === 0) return text
  for (let index = spans.length - 1; index >= 0; index -= 1) {
    const span = spans[index]
    lines.splice(span.start, span.end - span.start)
    // Collapse only the blank run left at this seam; never touch blank lines
    // elsewhere in the user's file.
    const seam = span.start
    if (seam > 0 && seam < lines.length && lines[seam - 1].trim() === '' && lines[seam].trim() === '') {
      lines.splice(seam, 1)
    }
  }
  // The append path adds one separating blank line before the block; drop a
  // trailing blank run so removing the block restores the previous EOF.
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
  return serializeLines(lines, eol)
}

function expandHome(value) {
  const raw = String(value ?? '').trim()
  if (raw === '~') return os.homedir()
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return path.join(os.homedir(), raw.slice(2))
  return raw
}

/** Resolve the DSH home directory exactly as `_env.cjs` does. */
export function resolveHome(env = process.env) {
  const configured = expandHome(env.DSH_HOME)
  return path.resolve(configured.length > 0 ? configured : path.join(os.homedir(), '.dsh'))
}

/** Resolve, canonicalise and forward-slash the watched repository root. */
export function resolveRoot(value, cwd = process.cwd()) {
  const raw = value === undefined || value === null ? cwd : String(value)
  if (/[\r\n]/.test(raw)) throw new Error(`--root must not contain line breaks: ${raw}`)
  const absolute = path.resolve(cwd, raw)
  let real
  try {
    real = fs.realpathSync(absolute)
  } catch (error) {
    throw new Error(`--root must be an existing directory: ${absolute} (${error.message})`)
  }
  if (!fs.statSync(real).isDirectory()) throw new Error(`--root is not a directory: ${real}`)
  return forwardSlashes(real)
}

export function parseArgs(argv) {
  const options = { profile: 'desktop', root: undefined, dryRun: false, remove: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index])
    if (arg === '--dry-run') {
      options.dryRun = true
    } else if (arg === '--remove') {
      options.remove = true
    } else if (arg === '--help' || arg === '-h') {
      options.help = true
    } else if (arg === '--profile' || arg === '--root') {
      const value = argv[index + 1]
      if (value === undefined || String(value).startsWith('--')) throw new Error(`${arg} requires a value`)
      index += 1
      if (arg === '--profile') options.profile = String(value)
      else options.root = String(value)
    } else if (arg.startsWith('--profile=')) {
      options.profile = arg.slice('--profile='.length)
    } else if (arg.startsWith('--root=')) {
      options.root = arg.slice('--root='.length)
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  return options
}

function printUsage() {
  console.log(`Usage: node scripts/enable-dev-hmr.mjs [options]

Options:
  --profile <name>  DSH profile to edit (default: desktop)
  --root <dir>      repository directory DSH HMR should watch
                    (default: the current working directory, realpath'ed)
  --dry-run         print the patch diff without writing
  --remove          remove the dsh-tower dev-hmr block
  --help            show this help

Target file: <DSH_HOME>/profiles/<profile>/cordis.patch.yml
DSH_HOME defaults to ~/.dsh. The script never creates a profile and writes
nothing outside the user patch layer.`)
}

function printNextSteps(root) {
  console.log('Restart DSH once so the profile patch (and the HMR watch roots) takes effect.')
  console.log('After the restart:')
  console.log(`  - HMR watches ${root} and reloads Tower code after edits while DSH stays open.`)
  console.log('  - Run /tower reload (or call the tower_reload tool) to reconcile on demand.')
  console.log('  - Run this script with --remove to disable the watcher again (restart once after).')
  console.log('Note: the HMR root list accepts absolute paths; the value above is absolute and uses forward slashes.')
}

function printDiff(writeLine, file, before, after) {
  const beforeLines = String(before).replaceAll('\r\n', '\n').split('\n')
  const afterLines = String(after).replaceAll('\r\n', '\n').split('\n')
  let prefix = 0
  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix += 1
  }
  let suffix = 0
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix += 1
  }
  writeLine(`--- ${file}`)
  writeLine(`+++ ${file} (dsh-tower dev-hmr)`)
  writeLine(`@@ line ${prefix + 1} @@`)
  for (let index = prefix; index < beforeLines.length - suffix; index += 1) {
    writeLine(`-${beforeLines[index]}`)
  }
  for (let index = prefix; index < afterLines.length - suffix; index += 1) {
    writeLine(`+${afterLines[index]}`)
  }
}

function profilePatchPath(home, profile) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(profile) || profile === '.' || profile === '..') {
    throw new Error(`invalid profile name: ${profile}`)
  }
  const profileDir = path.join(home, 'profiles', profile)
  if (!fs.existsSync(profileDir) || !fs.statSync(profileDir).isDirectory()) {
    throw new Error(
      `DSH profile "${profile}" does not exist at ${profileDir}. ` +
        `Create it first (for example: dsh --profile ${profile} --from-default-profile web --dump-config); ` +
        'this script never creates a profile.',
    )
  }
  return path.join(profileDir, PATCH_FILENAME)
}

/**
 * Run the CLI. Returns the process exit code; throws nothing.
 * `env` and `cwd` are injectable so tests can isolate $DSH_HOME.
 */
export function main(argv = process.argv.slice(2), env = process.env, cwd = process.cwd()) {
  try {
    const options = parseArgs(argv)
    if (options.help) {
      printUsage()
      return 0
    }
    const home = resolveHome(env)
    const file = profilePatchPath(home, options.profile)
    const original = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''

    if (options.remove) {
      const next = removeBlock(original)
      if (next === original) {
        console.log(`No dsh-tower dev-hmr block in ${file}; nothing to remove.`)
        return 0
      }
      if (options.dryRun) {
        printDiff(console.log, file, original, next)
        console.log('Dry run: no file written.')
        return 0
      }
      fs.writeFileSync(file, next, 'utf8')
      console.log(`Removed the dsh-tower dev-hmr block from ${file}.`)
      console.log('Restart DSH once so the profile patch is reloaded without the HMR root.')
      return 0
    }

    const root = resolveRoot(options.root, cwd)
    const next = upsertBlock(original, root)
    if (next === original) {
      console.log(`The dsh-tower dev-hmr block in ${file} is already up to date for ${root}.`)
      printNextSteps(root)
      return 0
    }
    if (options.dryRun) {
      printDiff(console.log, file, original, next)
      console.log('Dry run: no file written.')
      return 0
    }
    fs.writeFileSync(file, next, 'utf8')
    console.log(`Wrote the dsh-tower dev-hmr block to ${file}`)
    printNextSteps(root)
    return 0
  } catch (error) {
    console.error(`enable-dev-hmr: ${error?.message ?? error}`)
    return 1
  }
}

// Only run when invoked as a script; importing this file from a test is inert.
const invokedDirectly = (() => {
  try {
    const entry = process.argv[1]
    if (entry === undefined) return false
    return pathToFileURL(path.resolve(entry)).href === import.meta.url
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  process.exitCode = main()
}
