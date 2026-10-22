// Shared CLI plumbing for the maintenance entry points under scripts/ (#94).
//
// scripts/release-check.mjs, scripts/issue-audit.mjs, scripts/mount-smoke.mjs
// and scripts/mount-smoke/fixtures.mjs had near-identical `parseArgs`,
// `UsageError`, `isMain` and exit-code blocks. This is that block once: each
// script declares its flags and keeps its own usage text, messages and codes.
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export class UsageError extends Error {}

function usageError(message) {
  const error = new UsageError(message)
  // Only argument-parsing failures print the usage block; a repository or file
  // problem exits 2 with its message only.
  error.showUsage = true
  return error
}

/** True when this module is the program entry point, not an imported module. */
export function isMain(importMetaUrl) {
  return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(importMetaUrl)
}

/**
 * Parse `--name <value>` and boolean flags into a plain object.
 *
 * - `initial`: the object to start from (a copy is returned).
 * - `flags`: flag -> property name for booleans.
 * - `values`: flag -> property name, or `{ key, parse }`.
 * - `error`: error factory for scripts whose argument errors are ordinary
 *   failures rather than usage errors (the mount smoke exits 1, not 2).
 * - `optionLikeValues`: reject a value that itself starts with `--`.
 */
export function parseArgs(
  argv,
  { initial = {}, flags = {}, values = {}, error = usageError, optionLikeValues = true } = {},
) {
  const parsed = { ...initial }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (Object.prototype.hasOwnProperty.call(flags, arg)) {
      parsed[flags[arg]] = true
      continue
    }
    if (!Object.prototype.hasOwnProperty.call(values, arg)) throw error(`unknown argument ${JSON.stringify(arg)}`)
    const next = argv[index + 1]
    if (next === undefined || (optionLikeValues && next.startsWith('--'))) throw error(`${arg} needs a value`)
    index += 1
    const spec = values[arg]
    if (typeof spec === 'string') parsed[spec] = next
    else parsed[spec.key] = spec.parse ? spec.parse(next) : next
  }
  return parsed
}

/** The finding recorder both gates use, so every call is `(code, level, message)`. */
export function findingRecorder(findings, base = {}) {
  return (code, level, message) => findings.push({ ...base, code, level, message })
}

/**
 * Run a CLI as the program entry point: the returned exit code becomes
 * `process.exitCode`. A UsageError exits 2 (printing the usage text when it
 * came from argument parsing); any other error exits 1.
 */
export async function runMain(importMetaUrl, run, { errorPrefix, usage = null } = {}) {
  if (!isMain(importMetaUrl)) return
  try {
    process.exitCode = await run()
  } catch (error) {
    console.error(`${errorPrefix}: ${error?.message ?? error}`)
    if (usage && error?.showUsage) console.error(usage)
    process.exitCode = error instanceof UsageError ? 2 : 1
  }
}
