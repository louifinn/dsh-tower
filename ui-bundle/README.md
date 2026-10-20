# Tower UI (optional Client bundle)

An **optional** Web Client bundle for the Host `dsh-tower` plugin. It never touches Tower state directly: everything it renders is derived from the conversation the user is already looking at, or from the tool results already in that conversation. There is no Host → Client remote channel, no `host.call`, no DOM manipulation, no iframe, and no import of Harness Client packages (the only module it requires is `react` from the browser module table).

Version: **0.2.1** (private, not published). The Host plugin version is unchanged.

This revision fixes GitHub **#11** (persistent, history-derived Tower-mode indicator in the composer dock) and **#12** (mode-aware `Tower mode · disabled` rows for guard-denied tools), see below.

## What it registers

| Surface | Slot | Registration | Data source |
|---|---|---|---|
| Tower tool cards | `tool.call.toolview` (keyed, session) | 12 entries, one per `key`: `tower_status`, `tower_roster`, `tower_spawn`, `tower_mission`, `tower_complete`, `tower_review`, `tower_preflight`, `tower_merge`, `tower_teardown`, `tower_interrupt`, `tower_doctor`, `tower_batch` | The Chat tool-call tree's owner props: `toolName`, `phase` (`preparing` / `start` / `result`), `block` (streaming start block or settled `tool/result` block), `callId`. |
| Composer dock | `conversation.composer.dock` (list, session) | `id: "tower-hint"`, `order: 6` | `useChat` standard selector hook (the durable Chat legacy slice). In Tower mode: a `Tower · on` chip. Otherwise, a Tower tool result in the conversation: a compact latest-status line. Otherwise: the static `/tower` hint. |
| Denied-tool rows | `tool.call.toolview` (keyed, session) | dynamic entries for the Tower-mode deny list, `priority: -10`, plus `update_goal` | The same history-derived Tower mode. Registered only while the displayed session is in Tower mode and disposed when it leaves, so the native toolviews (priority 0) return. |
| Overlay status strip | `shell.overlay` (list, root) | `id: "tower-status-strip"`, `order: 20` | The overlay slot is root-scoped, so it receives no chat hooks. The chat-driven toolview components publish a start/result notice into a module-local observable that this entry injects as `useTowerNotice`; a single timer auto-dismisses it after 4.5 s and is disposed by `ctx.effect`. |
| Locale | Client locale service | namespace `tower-ui` (`en`, `zh`) | Bound `t` seats come from each registration's `locale` option. |

The cards are deliberately compact: mission status/counts, task checklist progress, blockers, roster live/stale counts, review verdict, merge/preflight state, and check/test evidence (exit codes included). All of it is rendered as React elements with inline styles; **theme references are restricted to `--dsw-alias-*` tokens**, so light/dark and token renames degrade gracefully.

The overlay strip is `pointer-events: none` end-to-end and uses `role="status"` / `aria-live="polite"`; it never blocks the composer or the page.

## Persistent Tower-mode indicator (#11)

Tower mode is a Host-side session stance and there is no Client RPC for it. The dock derives it from the durable session history that the Chat projection exposes in `useChat(snapshot.legacy)`:

- the `/tower on|off` command node (`kind: "command"`, `name: "tower"`, `args`, `outcome.kind`); bare `/tower` and `/tower <message>` mean "ensure on", `/tower reload` and `/tower base <branch>` leave the stance unchanged, and a failed command is ignored;
- `tower_mode` results (`mode: "on" | "off" | "unknown"`, `deniedWhileActive`, `workspaceLock`, `lastChange`);
- `tower_control` results (`action: enter|exit`, `mode`, `changedBy`, `reason`).

The last recognized event wins. A page refresh re-derives the same stance from the loaded history; when that history window no longer contains a mode event, the dock falls back to a browser-local last-known value for the same session and labels it as such. An old value expires after seven days and never drives the denied-tool shadowing by itself.

While the mode is on the dock shows a `Tower · on` chip with `role="status"` / `aria-live="polite"`, and its tooltip carries the actionable hint plus, when known, the repository basename, workspace-lock state (`held`/`free`), and who changed the mode last. The chip is **deliberately non-interactive**: the only existing standard affordance is `inputActions.setDraft` + `inputActions.submit`, which submits the composer draft and would clobber what the user is typing. The tooltip tells the user to run `/tower off`; the bundle itself does not toggle the mode (the model's supported path is the Host `tower_control` tool when `allowAgentControl` is enabled).

## Mode-aware denied-tool rows (#12)

The Host guard returns a plain tool error like `tower mode: <tool> is disabled while Tower mode is active; use the Tower tools or /tower off` (and `tower mode: goals cannot be resumed while Tower mode is active; use /tower off first` for `update_goal` resume).

While the displayed session is in Tower mode the bundle dynamically registers `tool.call.toolview` entries for:

- `tower_mode.deniedWhileActive` when the latest `tower_mode` output lists it, otherwise `lib/config.js` `DEFAULT_DENY_TOOLS` (`create_goal`, `todo_write`, `team_task_create`, `team_task_update`, `team_task_reopen`, `team_task_list`, `spawn_teammate`, `wait_agent`, `workflow`, `ralph`, `subagent`, `subagent_fork`);
- `update_goal` unconditionally, because the guard special-cases its `action: "resume"`.

Those entries register with `priority: -10`. The slot core renders the lowest priority for a key, so this shadows the native keyed views without replacing them; disposing the entries (mode off) restores the native views exactly. A denial result renders as a distinct **`Tower mode · disabled`** row (warn marker, label, the preserved denial message, and the `/tower off` hint) — not the generic error text styling. `update_goal` resume denials get the same row. A non-denial result that lands in one of those slots while the mode is on renders a defensive generic row (there is no native view to delegate to while the registration shadows it); ordinary tool errors are not misclassified as Tower-mode denials.

## Verification status

Verified **statically** against the installed DSH **0.2.1-rc.2** sources:

- `tool.call.toolview`: declared by `@deepseek-ai/dsh-client-ui-tool` as `{ kind: "keyed", scope: "session" }`; the Chat tool-call tree dispatches with `entryKey = toolName` and passes `{ callId, toolName, ...call, openFile, cwd, home, loadImage, useDisclosure, inspect }`, where `call` is `{ phase, block }`. A keyed hit replaces the generic tool row; a miss falls back to it.
- Keyed priority/shadowing: the Client slot core (in the web shell bundle) allows a second keyed registration only at a different `priority` and resolves a key with the **lowest** priority first — `register at a different priority to shadow it (lowest renders)`. Native views use the default priority 0.
- `conversation.composer.dock`: declared by `@deepseek-ai/dsh-client-ui-conversation` as `{ kind: "list", scope: "session" }`, rendered as `div[data-composer-dock]`. Owner props are empty; session-scope standard props (including `useSession`, `useChat`, `useConversation`) are supplied by the renderer.
- `shell.overlay`: declared by `@deepseek-ai/dsh-client-ui-layout` as `{ kind: "list", scope: "root" }`, rendered inside `[data-shell-overlay]`. Root standard props are `useSessions`, `useSessionStatus`, `useWorkspaces`, `usePanelInfo` and keyed access hooks — **no chat hook**; hence the toolview-published notice design above.
- `/tower` history: DSH logs `command/run` with `{ name, args: parsed.rawInput, source }` and `command/done` with `{ kind, text }`, which the Chat command node exposes as `{ kind: "command", name, args, outcome }` in the legacy slice.
- Guard denial shape: the Host tools pipeline materializes a denial as `{ content: [{ type: "text", text: "Error: <reason>" }], isError: true, error: { message: <reason> } }`.
- Locale: `ctx.locale.register(ns, { en, zh })`, dictionaries are flat `key → template` maps with `{param}` interpolation; a slot declaration's `locale` option supplies the bound `t` seat.
- The bundle's `dsh.client.inject` orders activation after `ui-conversation` and `ui-tool`, the two packages that declare the slots it targets. `ctx.slots.inject` only installs a registration while its owner declaration exists; each injection is guarded and reported in diagnostics instead of crashing the whole Client half.

Automated offline coverage: `tests/ui-bundle.test.mjs` loads `client.js` through a fake `window.__ModuleLoader__`, asserts the 12 keys / dock id / overlay id, en–zh dictionary parity, theme-token discipline, and renders every card plus the dock/overlay components with fake hooks. It also drives fake chat history through the dock to assert the off hint, the on chip (including refresh re-derivation), `tower_mode`/`tower_control`/command updates, dynamic registration for default and configured deny lists, disposal on mode off, `update_goal`, denial-row treatment, generic fallbacks, and locale parity — no browser required.

Live/browser verification is **opt-in** (`tests/live/ui-slots.cjs`) because it needs an isolated profile with the bundle installed. From a teammate/subagent session the Client `Slots` inspect query times out by design (the page answers only the agent whose session it displays), so this phase did not run a live inspection; the source-level contract above is the evidence. When the script runs against an installed profile it binds a session with a bare `/tower` command and asserts, through the read-only `window.__TOWER_UI_DIAG__` report, that apply() ran without errors, that all 12 toolview keys and the dock/overlay entries registered, that the dock outlet is visible, and — since the bind command turns the Host mode on — that the history-derived `Tower · on` chip rendered (#11). The chip can be inspected visually in the same run (`data-tower-ui="dock-mode"`).

## Tests

```powershell
# offline, no browser
node --check ui-bundle/client.js
node --test tests/ui-bundle.test.mjs

# opt-in live check (isolated profile only)
node tests/live/ui-slots.cjs
```

`tests/live/ui-slots.cjs` prints `SKIP` and exits 0 when `DSH_TEST_URL` (or Playwright) is missing; it never installs anything and never opens the desktop profile. Set `DSH_TEST_EXPECT_HINT=1` when the bundle is installed so a missing client module or missing dock entry fails instead of skipping the assertion, and `DSH_TEST_EXPECT_MODE=1` to require the history-derived `Tower · on` chip after the script's `/tower` bind step (otherwise that check is a warning, since the bind step is best-effort).

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

- **No live Host state / no new RPC.** The mode chip is inferred from the **loaded history window** of the displayed session. If the `/tower on` command (or a `tower_mode` result) sits outside that window, the dock falls back to the static hint and the mode-aware rows are not registered; a later `/tower`, `tower_control`, or `tower_mode` result corrects it. The dock summary is likewise the latest visible Tower tool result, not a dashboard, and does not poll.
- **Mode-driven registration is slot-global.** The dock follows the displayed session. While that session is in Tower mode, the denied-tool shadow entries also apply to other sessions' rows for those tools (they render the defensive generic row); leaving the mode disposes them globally and restores the native views.
- **A custom `mode.denyTools` list needs a `tower_mode` result in the visible history.** The dock learns `deniedWhileActive` only from a `tower_mode` output; if the mode was inferred from `/tower on` alone (or the `tower_mode` result is outside the loaded window), the bundle shadows the default list instead, and a custom denied tool falls back to the native error row until a `tower_mode` output appears.
- **The on-chip is not a button.** `inputActions.submit()` submits the composer draft, so programmatically sending `/tower off` would overwrite the user's draft; the actionable tooltip asks the user to run it. There is no click handler and no automatic toggle from the bundle; the Host `tower_control` tool remains the model's supported path.
- **The overlay is root-scoped.** It cannot read chat state directly, so a result that lands while every Tower toolview is unmounted (for example the user switches sessions before the result renders) shows no strip. The strip itself carries no actionable content by design.
- A tool result whose payload is not JSON (older/foreign shape) renders as a plain one-line summary rather than a card; errors render as an error card.
- Client bundle updates are not auto-rebuilt: edit → reconcile/link → **refresh the page**. Profile patch or manifest changes may need a restart.
- `window.__TOWER_UI_DIAG__` is a read-only diagnostic seam for tests. It contains no session content — only plugin version, applied flag, slot/toolview names, current mode summary, dynamic deny keys, and guarded registration errors.
