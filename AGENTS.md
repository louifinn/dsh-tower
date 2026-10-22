# Agent guide

Guidance for coding agents working in this repository.

## Agent skills

### Issue tracker

Issues live in GitHub Issues on `louifinn/dsh-tower`; skills use the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Execution workflow

This repository is delivered with the Matt Pocock skills workflow (triage → spec → tickets → TDD → two-axis review → retro) and the Tower delivery protocol (missions in isolated worktrees, scope fences, review/merge gates). The combined convention — who owns each stage, when to use subagents versus Tower, the verification gates, and the tag-only versus published release modes — is in `docs/agents/workflow.md`.
