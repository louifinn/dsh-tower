# Tower events

Tower emits process-local Cordis events after successful tool calls (mutations and read-only tools), so
other plugins can observe a repository without polling. This release emits 28 process-local events.
Events are **not** sent over the network and carry no telemetry.

```js
ctx.on('tower/merge', (payload) => {
  // payload.tool, payload.repoRoot, payload.value (the tool's JSON result)
})
```

| Event | Emitted after |
|---|---|
| `tower/init` | `tower_init` created or re-anchored state |
| `tower/plan` | `tower_plan` created missions |
| `tower/mission` | `tower_mission` changed one mission |
| `tower/spawn` | `tower_spawn` recorded a worker/reviewer |
| `tower/complete` | `tower_complete` recorded a completion report |
| `tower/review` | `tower_review` recorded a verdict |
| `tower/merge` | `tower_merge` returned (including gate failures; inspect `value.ok`) |
| `tower/rebase` | `tower_rebase` returned |
| `tower/teardown` | `tower_teardown` removed worktrees |
| `tower/finding` | `tower_finding` created one finding |
| `tower/findings` | `tower_findings` read/listed/updated findings |
| `tower/send` | `tower_send` persisted a message |
| `tower/inbox` | `tower_inbox` acknowledged messages |
| `tower/interrupt` | `tower_interrupt` stopped a live agent |
| `tower/diff` | `tower_diff` read a mission diff |
| `tower/adopt` | `tower_adopt` reconciled the roster |
| `tower/roster` | `tower_roster` read the roster |
| `tower/status` | `tower_status` read the dashboard |
| `tower/preflight` | `tower_preflight` evaluated the gate |
| `tower/doctor` | `tower_doctor` completed its read-only checks |
| `tower/test` | `tower_test` ran discovery |
| `tower/batch` | `tower_batch` created, inspected or closed a batch |
| `tower/resource` | `tower_resource` acquired/released/inspected leases |
| `tower/import_legacy` | `tower_import_legacy` stored a legacy snapshot |
| `tower/legacy_map` | `tower_legacy_map` mapped or listed legacy ids |
| `tower/mode` | `tower_mode` read/changed the session stance (`value.mode`, `allowAgentControl`, `deniedWhileActive`) |
| `tower/control` | `tower_control` entered/left the mode (`value.mode`, actor/reason in `value`) |
| `tower/reload` | `tower_reload` returned a reload schedule/result |

Payloads are JSON: `{tool, repoRoot, value}`. Listener exceptions never affect the tool result.

For a durable audit trail use `<git-common-dir>/dsh-tower/activity.jsonl` and `MISSIONS.md` instead;
events are process-local and are not replayed.
