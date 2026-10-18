# Tower UI (optional Client bundle)

An **optional** Web Client bundle for the Host `dsh-tower` plugin. It never touches Tower state directly: everything it renders is derived from the conversation the user is already looking at, or from the tool results already in that conversation. There is no Host → Client remote channel, no `host.call`, no DOM manipulation, no iframe, and no import of Harness Client packages (the only module it requires is `react` from the browser module table).

Version: **0.2.0** (private, not published). The Host plugin version is unchanged.

## What it registers

| Surface | Slot | Registration | Data source |
|---|---|---|---|
| Tower tool cards | `tool.call.toolview` (keyed, session) | 12 entries, one per `key`: `tower_status`, `tower_roster`, `tower_spawn`, `tower_mission`, `tower_complete`, `tower_review`, `tower_preflight`, `tower_merge`, `tower_teardown`, `tower_interrupt`, `tower_doctor`, `tower_batch` | The Chat tool-call tree's owner props: `toolName`, `phase` (`preparing` / `start` / `result`), `block` (streaming start block or settled `tool/result` block), `callId`. |
| Composer dock | `conversation.composer.dock` (list, session) | `id: "tower-hint"`, `order: 6` | Without a Tower tool result in the current conversation: the static `/tower` hint (unchanged). With one: a compact latest-status line derived from the `useChat` standard selector hook (the legacy chat slice: `legacy.nodes` for settled results, `legacy.runningCalls` for live calls). |
| Overlay status strip | `shell.overlay` (list, root) | `id: "tower-status-strip"`, `order: 20` | The overlay slot is root-scoped, so it receives no chat hooks. The chat-driven toolview components publish a start/result notice into a module-local observable that this entry injects as `useTowerNotice`; a single timer auto-dismisses it after 4.5 s and is disposed by `ctx.effect`. |
| Locale | Client locale service | namespace `tower-ui` (`en`, `zh`) | Bound `t` seats come from each registration's `locale` option. |

The cards are deliberately compact: mission status/counts, task checklist progress, blockers, roster live/stale counts, review verdict, merge/preflight state, and check/test evidence (exit codes included). All of it is rendered as React elements with inline styles; **theme references are restricted to `--dsw-alias-*` tokens**, so light/dark and token renames degrade gracefully.

The overlay strip is `pointer-events: none` end-to-end and uses `role="status"` / `aria-live="polite"`; it never blocks the composer or the page.

## Verification status

Verified **statically** against the installed DSH **0.2.1-rc.2** sources:

- `tool.call.toolview`: declared by `@deepseek-ai/dsh-client-ui-tool` as `{ kind: "keyed", scope: "session" }`; the Chat tool-call tree dispatches with `entryKey = toolName` and passes `{ callId, toolName, ...call, openFile, cwd, home, loadImage, useDisclosure, inspect }`, where `call` is `{ phase, block }`. A keyed hit replaces the generic tool row; a miss falls back to it.
- `conversation.composer.dock`: declared by `@deepseek-ai/dsh-client-ui-conversation` as `{ kind: "list", scope: "session" }`, rendered as `div[data-composer-dock]`. Owner props are empty; session-scope standard props (including `useSession`, `useChat`, `useConversation`) are supplied by the renderer.
- `shell.overlay`: declared by `@deepseek-ai/dsh-client-ui-layout` as `{ kind: "list", scope: "root" }`, rendered inside `[data-shell-overlay]`. Root standard props are `useSessions`, `useSessionStatus`, `useWorkspaces`, `usePanelInfo` and keyed access hooks — **no chat hook**; hence the toolview-published notice design above.
- Locale: `ctx.locale.register(ns, { en, zh })`, dictionaries are flat `key → template` maps with `{param}` interpolation; a slot declaration's `locale` option supplies the bound `t` seat.
- The bundle's `dsh.client.inject` orders activation after `ui-conversation` and `ui-tool`, the two packages that declare the slots it targets. `ctx.slots.inject` only installs a registration while its owner declaration exists; each injection is guarded and reported in diagnostics instead of crashing the whole Client half.

Automated offline coverage: `tests/ui-bundle.test.mjs` loads `client.js` through a fake `window.__ModuleLoader__`, asserts the 12 keys / dock id / overlay id, en–zh dictionary parity, theme-token discipline, and renders every card plus the dock/overlay components with fake hooks — no browser required. `node --check ui-bundle/client.js` is part of the test.

Live/browser verification is **opt-in** (`tests/live/ui-slots.cjs`) because it needs an isolated profile with the bundle installed. From a teammate/subagent session the Client `Slots` inspect query times out by design (the page answers only the agent whose session it displays), so this phase did not run a live inspection; the source-level contract above is the evidence. When the script runs against an installed profile it asserts, through the read-only `window.__TOWER_UI_DIAG__` report, that apply() ran without errors, that all 12 toolview keys and the dock/overlay entries registered, and that the dock outlet is visible.

## Tests

```powershell
# offline, no browser
node --check ui-bundle/client.js
node --test tests/ui-bundle.test.mjs

# opt-in live check (isolated profile only)
node tests/live/ui-slots.cjs
```

`tests/live/ui-slots.cjs` prints `SKIP` and exits 0 when `DSH_TEST_URL` (or Playwright) is missing; it never installs anything and never opens the desktop profile. Set `DSH_TEST_EXPECT_HINT=1` when the bundle is installed so a missing client module or missing `/tower` hint fails instead of skipping the assertion.

## Why it is a separate bundle

It is not installed by default and does not affect installing or running the Host `dsh-tower` plugin. The Host plugin is fully functional without it; the UI half only decorates the conversation that is already on screen.

## Install (isolated profile only)

```text
# throwaway profile, not the desktop profile
dsh --profile towertest --from-default-profile web --dump-config
dsh plugin --profile towertest add <absolute path to this ui-bundle>
dsh --profile towertest --port 59001 --no-open
# open the tokenized URL printed at boot, then verify:
$env:DSH_TEST_URL='http://127.0.0.1:59001/?token=<token>'
$env:DSH_TEST_EXPECT_HINT='1'; node tests/live/ui-slots.cjs
```

From a session in that profile, `plugin_manager({ action: "install_bundle", target: "<absolute path to this ui-bundle>" })` performs the same add + enable. Do not install it into the live desktop profile without the user's explicit request.

## Remove

```text
dsh plugin --profile towertest remove dsh-tower-ui
```

Without HMR a bundle that has been running since process start may need a DSH restart for removal; with HMR a reconcile can unload it. A page refresh (or hard refresh) is enough to update the Client half after a linked-directory change.

## Known limitations

- **No live Host state / no new RPC.** The cards show the tool results that are already durable in the conversation. The dock summary is the latest Tower tool result or running call in the current conversation; it is not a second dashboard and does not poll.
- **The overlay is root-scoped.** It cannot read chat state directly, so a result that lands while every Tower toolview is unmounted (for example the user switches sessions before the result renders) shows no strip. The strip itself carries no actionable content by design.
- A tool result whose payload is not JSON (older/foreign shape) renders as a plain one-line summary rather than a card; errors render as an error card.
- Client bundle updates are not auto-rebuilt: edit → reconcile/link → **refresh the page**. Profile patch or manifest changes may need a restart.
- `window.__TOWER_UI_DIAG__` is a read-only diagnostic seam for the live test. It contains no session content — only plugin version, applied flag, slot/toolview names, and guarded registration errors.
