// Bundled Tower skills: protocol, review checklist, and recovery playbook.
// The provider is mounted by the bundle patch so every agent sees the catalog;
// the short system-prompt sections stay authoritative for safety rules.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-tower/skills'
export const inject = ['skills']

const ASSETS = fileURLToPath(new URL('./skills/', import.meta.url))

const SKILLS = [
  {
    name: 'tower-worker-protocol',
    description:
      'Follow the Tower worker workflow: work only in the assigned mission worktree, update the mission, commit the branch, and report a complete handoff. Use when spawned as a Tower worker.',
    file: 'tower-worker-protocol.md',
  },
  {
    name: 'tower-review',
    description:
      'Run an independent Tower review: inspect the mission diff read-only, verify scope/tasks/reviewed tip, and submit exactly one clean or p1/p2 review verdict. Use when spawned as a Tower reviewer.',
    file: 'tower-review.md',
  },
  {
    name: 'tower-recovery',
    description:
      'Recover a Tower mission from a merge hook failure, an already-landed merge, a stale branch, a stuck state lock, or a missing worktree. Use when tower_merge, tower_rebase, or tower_preflight reports a blocker.',
    file: 'tower-recovery.md',
  },
]

const provider = {
  name: 'dsh-tower',
  list: async () =>
    SKILLS.map((skill) => ({
      name: skill.name,
      description: skill.description,
      invocation: { modelInvocable: true, userInvocable: true },
      provider: 'dsh-tower',
      source: 'bundled',
      resourceBase: { kind: 'directory', path: ASSETS },
      rank: 600,
      locator: new URL(skill.file, new URL('./skills/', import.meta.url)),
    })),
  async get(candidate) {
    const skill = SKILLS.find((entry) => entry.name === candidate.name)
    if (!skill) throw new Error(`unknown dsh-tower skill: ${candidate.name}`)
    return {
      name: skill.name,
      description: skill.description,
      invocation: { modelInvocable: true, userInvocable: true },
      provider: 'dsh-tower',
      source: 'bundled',
      resourceBase: { kind: 'directory', path: ASSETS },
      content: await readFile(new URL(skill.file, new URL('./skills/', import.meta.url)), 'utf8'),
    }
  },
}

export function apply(ctx) {
  ctx.skills.registerProvider(() => provider)
}
