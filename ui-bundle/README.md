# Tower UI (optional Client bundle)

An **optional** Web Client bundle for the Host `dsh-tower` plugin. It never touches Tower state directly: everything it renders is derived from the conversation the user is already looking at, or from the tool results already in that conversation. There is no Host → Client remote channel, no `host.call`, no DOM manipulation, no iframe, and no import of Harness Client packages. The browser module-table words it resolves are `react` and the Web shell's `@deepseek-ai/dsh-client-ui-primitives` namespace — a static-table name declared in `dsh.client.external`, not an installed package.

Version: **0.2.2** (private, not published). The Host plugin version is unchanged.

This revision fixes GitHub **#11** (persistent, history-derived Tower-mode indicator in the composer dock) and **#12** (mode-aware `Tower mode · disabled` rows for guard-denied tools), see below.

## What it registers

| Surface | Slot | Registration | Data source |
|---|---|---|---|
| Tower tool cards | `tool.call.toolview` (keyed, session) | 9 entries, one per `key`: `tower_inspect` (status/roster/diff/preflight/doctor views), `tower_spawn`, `tower_mission`, `tower_complete`, `tower_review`, `tower_merge`, `tower_teardown`, `tower_interrupt`, `tower_batch` | The Chat tool-call tree's owner props: `toolName`, `phase` (`preparing` / `start` / `result`), `block` (streaming start block or settled `tool/result` block), `callId`, and the native disclosure seat `useDisclosure()` (`{ expanded, toggle }`). The card renders the primitives `DisclosureRow`, so collapsed it is the host tool row. |
| Composer dock | `conversation.composer.dock` (list, session) | `id: "tower-hint"`, `order: 6` | `useChat` standard selector hook (the durable Chat legacy slice). In Tower mode: a `Tower · on` chip. Otherwise, a Tower tool result in the conversation: a compact latest-status line. Otherwise: the static `/tower` hint. |
| Denied-tool rows | `tool.call.toolview` (keyed, session) | dynamic entries for the Tower-mode deny list, `priority: -10`, plus `update_goal` | The same history-derived Tower mode. Registered only while the displayed session is in Tower mode and disposed when it leaves, so the native toolviews (priority 0) return. |
| Overlay status strip | `shell.overlay` (list, root) | `id: "tower-status-strip"`, `order: 20` | The overlay slot is root-scoped, so it receives no chat hooks. The chat-driven toolview components publish a start/result notice into a module-local observable that this entry injects as `useTowerNotice`; a single timer auto-dismisses it after 4.5 s and is disposed by `ctx.effect`. |
| Locale | Client locale service | namespace `tower-ui` (`en`, `zh`) | Bound `t` seats come from each registration's `locale` option. |

The cards reuse the native row chrome instead of building their own: a collapsed Tower card is the host tool row (primitives icon, localized tool label, one-line headline, hover chevron), and the curated detail — mission status/counts, task checklist progress, blockers, roster live/stale counts, review verdict, merge/preflight state, and check/test evidence (exit codes included) — is rendered only while the row is expanded. All of it is rendered as React elements with inline styles; **theme references are restricted to `--dsw-alias-*` tokens**, so light/dark and token renames degrade gracefully.

The overlay strip is `pointer-events: none` end-to-end and uses `role="status"` / `aria-live="polite"`; it never blocks the composer or the page.

## Source layout (#71)

The bundle is split along the surfaces above. `client.js` is the entry: it owns
the diagnostics seam and the registrations, and loads the package-local chunks
through the DSH client module system's `require.async("./client.<surface>.js")`
(bundles execute as classic scripts, so the entry cannot require a sibling
synchronously). Every chunk registers through the same `window.__ModuleLoader__`
surface as `{ id: 'dsh-tower-ui', chunk: 'client.<surface>.js', factory }` and
receives the shared helpers/styles/locales through the `env` the entry composes;
no chunk reaches the Host or another chunk.

| File | Surface |
|---|---|
| `client.js` | entry: diagnostics, module-table resolution (`react` + primitives), `apply`, the five registrations |
| `client.toolview.js` | toolview card: lifecycle + the native `DisclosureRow` card |
| `client.cards.js` | the per-tool card models behind the card |
| `client.dock.js` | composer dock: mode chip, unknown state, latest summary |
| `client.mode.js` | history-derived mode model + observable |
| `client.denied.js` | mode-aware `Tower mode · disabled` rows |
| `client.overlay.js` | transient `shell.overlay` status strip + notice store |
| `client.locales.js` | `en`/`zh` dictionaries and the `t`-seat helpers |
| `client.styles.js` | the `--dsw-alias-*` inline style table (headline/summary helpers) |
| `client.helpers.js` | tool vocabulary + defensive payload helpers |
| `index.js` | Host half (empty `apply`) |

## Native tool-row contract

A keyed `tool.call.toolview` entry **replaces** the host's generic tool row, so a
Tower card cannot delegate its collapsed state to the host component — it must
render the same chrome itself. `client.js` therefore resolves the Web shell's
`@deepseek-ai/dsh-client-ui-primitives` namespace once through the module table
and hands it to the toolview chunk as `env.primitives`; the package declares the
specifier in `dsh.client.external` so the module graph treats it as a static
seed word rather than a package row to await.

`client.toolview.js` renders `primitives.DisclosureRow` with the host's own
contract: the `icon` comes from the primitives icon family, `title` is the
localized tool label, `running` follows `phase !== "result"`, `expandOnRowClick`
and `keepContentWhenOpen` are on, and `open`/`onToggle` come from the
`useDisclosure()` seat that the host passes to every keyed toolview. `open` is
`expanded && expandable`, and `expandable` is true only for a settled result
with curated detail rows, so a running row shows the native shimmer and no
chevron. The curated rows are passed as `children` and are computed only while
open, matching `DisclosureRow`'s `open && children` render rule. The outer
element carries only `data-tower-toolview` and `data-tower-phase`; no border,
background, card header, status dot, or layout lives outside the native
component.

If the shell does not expose the primitives word, the entry records the failure
in diagnostics and **skips the toolview registrations entirely** (the dock,
overlay and denied rows still register), so the host renders its own native
rows. A hand-built lookalike is never the fallback.

The client tier is gated by `scripts/architecture.mjs` like any other source
root: `client-no-node` (no `node:*` imports; DOM globals are fine),
`client-size` (800-line ceiling per file) and `client-ambient` (no module-level
`let`; state lives in the `create*` closure), each with a seeded fixture in
`tests/architecture.test.mjs`. Every client source file stays under 400 lines
and the split-size ratchet measures client **logic** — the sum of
`ui-bundle/*.js` excluding the translation catalogue `client.locales.js` —
within 10% of the pre-split 1,980-line `client.js` (#71; today 2,058 lines
against the 2,178 ceiling). The catalogue is data, not logic:
`tests/ui-bundle.test.mjs` guards it with en/zh key-set parity, a 133-key floor
and 260-key ceiling, non-empty string values of at most 240 characters, and a
no-executable-construct check on the catalogue region. See
[ADR 0011](../docs/adr/0011-client-budget-covers-logic-not-locale-data.md).

## Persistent Tower-mode indicator (#11)

Tower mode is a Host-side session stance and there is no Client RPC for it. The dock derives it from the durable session history that the Chat projection exposes in `useChat(snapshot.legacy)`:

- the `/tower on|off` command node (`kind: "command"`, `name: "tower"`, `args`, `outcome.kind`); bare `/tower` and `/tower <message>` mean "ensure on", while `/tower ack`, `/tower takeover [reason]`, `/tower reload` and `/tower base <branch>` operate on other state and leave the stance unchanged; a failed command is ignored;
- `tower_mode` results (`mode: "on" | "off" | "unknown"`, `deniedWhileActive`, `workspaceLock`, `lastChange`), including a write acknowledgement (`action: enter|exit|takeover`, `mode`, `changedBy`, `reason`); a `tower_control` result recorded before 2.9.0 is still read from older history.

The last recognized event wins. A page refresh re-derives the same stance from the loaded history; when that history window no longer contains a mode event, the dock falls back to a browser-local last-known value for the same session and labels it as such. An old value expires after seven days and never drives the denied-tool shadowing by itself.

While the mode is on the dock shows a `Tower · on` chip with `role="status"` / `aria-live="polite"`, and its tooltip carries the actionable hint plus, when known, the repository basename, workspace-lock state (`held`/`free`), and who changed the mode last. The chip is **deliberately non-interactive**: the only existing standard affordance is `inputActions.setDraft` + `inputActions.submit`, which submits the composer draft and would clobber what the user is typing. The tooltip tells the user to run `/tower off`; the bundle itself does not toggle the mode (the model's supported path is the Host `tower_mode` tool with `active: true|false` and a non-empty `reason` — plus `authorization` for a takeover — when `allowAgentControl` is enabled).

## Mode-aware denied-tool rows (#12)

The Host guard returns a plain tool error like `tower mode: <tool> is disabled while Tower mode is active; use the Tower tools or run /tower off`, or — for an agent in a repository whose workspace lock another Tower session holds — `tower mode: <tool> is disabled because this repository is under Tower mode (…); run /tower off in that session first, or /tower takeover <reason> here once it is gone`.

While the displayed session is in Tower mode the bundle dynamically registers `tool.call.toolview` entries for:

- `tower_mode.deniedWhileActive` when the latest `tower_mode` output lists it, otherwise the static mirror of `domain/deny-owners.js` `DEFAULT_DENY_TOOLS` — every tool the foreign orchestration owners register (`create_goal`, `get_goal`, `update_goal`, `interrupt_agent`, `list_agents`, `send_message`, `spawn_teammate`, `subagent`, `subagent_fork`, `team_task_create`, `team_task_get`, `team_task_list`, `team_task_update`, `todo_write`, `wait_agent`, `workflow`, `ralph`);
- `update_goal` also when an older `tower_mode` result (≤ 2.8.0, whose list omitted it) is the latest visible one.

Those entries register with `priority: -10`. The slot core renders the lowest priority for a key, so this shadows the native keyed views without replacing them; disposing the entries (mode off) restores the native views exactly. A denial result renders as a distinct **`Tower mode · disabled`** row (warn marker, label, the preserved denial message, and the `/tower off` hint) — not the generic error text styling. `update_goal` resume denials get the same row. A non-denial result that lands in one of those slots while the mode is on renders a defensive generic row (there is no native view to delegate to while the registration shadows it); ordinary tool errors are not misclassified as Tower-mode denials.

## Accessibility and persisted state contract

The bundle is mostly a status surface; the tool cards reuse the host's native
disclosure row, so their keyboard and ARIA behaviour is the host's rather than a
second implementation. The rest is non-interactive, and the minimum contract is
deliberately small and test-enforced in `tests/ui-bundle.test.mjs`:

- **Dock chip / unknown state**: `role="status"`, `aria-live="polite"`,
  `aria-atomic="true"`, and an `aria-label` carrying the same text as the
  tooltip. The chip is non-interactive on purpose (see above), so it has no
  focus target and no click handler.
- **Dock summary**: `role="status"`, `aria-live="polite"`, `aria-atomic="true"`,
  and an `aria-label` with the tool label plus the localized summary text.
- **Tool cards**: the chrome is the native primitives `DisclosureRow` — same row
  geometry, icon, title shimmer and hover chevron as the host tool row. A
  settled card with curated detail expands on click, Enter or Space, with the
  `role="button"` / `aria-expanded` and focus ring that `DisclosureRow` owns;
  the expanded body exists only while open, and a running card is not
  expandable. Detail rows whose tone is error/warning/success carry
  `data-tower-tone`, `role="note"`, and an `aria-label` of the localized tone
  word plus the row text, so status is never conveyed by colour alone.
- **Overlay strip**: `role="status"`, `aria-live="polite"`,
  `aria-atomic="true"`, `aria-label` equal to the notice text, and
  `pointer-events: none` end-to-end.
- **Review-policy settings control** (root `client.js`, native radios): the
  section is a labelled group with a heading, the radiogroup is named by the
  heading and described by the intro, each input is labelled and described by
  its option spans, and the current/saved state is `role="status"` with
  `aria-live="polite"`/`aria-atomic="true"`. The restart note, inserted only
  after a save away from a profile that started with review off, is
  `role="note"` with `aria-live="polite"` and `aria-atomic="true"` so the
  dynamic insertion is announced instead of silently appearing beside the
  "Saved." status. Keyboard and focus behaviour is the browser's native radio
  group; nothing is implemented with a div that only looks interactive.

The dock stores a last-known mode per browser session. It validates the whole
snapshot before display (plain object, exact keys, boolean `on`, bounded text,
`denied` and `lock` shapes, a sane timestamp, and a 4 KiB raw cap) and discards
foreign, corrupt, stale or oversized values in a `try`/`catch`; storage failure
never breaks the dock, which then falls back to the history-derived model.

The client locale dictionary is gated in `tests/locale-copy.test.mjs`: the test
loads `client.locales.js` as a browser chunk, requires identical `en`/`zh` key
sets, and runs the shared copy gate for empty text, the glossary terms and
untranslated English. The banned config-key/tool-id/command/module rules are
not applied to this dictionary because a few tooltips intentionally quote
`/tower` and `tower_mode`.

## Verification status

Verified **statically** against the installed DSH **0.2.2-rc.3** sources:

- `tool.call.toolview`: declared by `@deepseek-ai/dsh-client-ui-tool` as `{ kind: "keyed", scope: "session" }`; the Chat tool-call tree dispatches with `entryKey = toolName` and passes `{ callId, toolName, ...call, openFile, cwd, home, loadImage, useDisclosure, inspect }`, where `call` is `{ phase, block }`. A keyed hit replaces the generic tool row; a miss falls back to it.
- Native row chrome: the Web shell's static module table seeds `@deepseek-ai/dsh-client-ui-primitives`. Its `DisclosureRow` renders `open && children`, keeps `collapsedContent` when `keepContentWhenOpen`, and makes the header row a clickable/keyboard `button` when `expandable && expandOnRowClick`. The native `ToolRow` passes `open = expanded && expandable`, `expandOnRowClick: true`, `keepContentWhenOpen: true`, and `onToggle` from the same `useDisclosure()` seat; the Tower card mirrors that contract and reuses the primitives icon family instead of adding assets.
- `dsh.client.external`: an entry may be a package row or a static-table name that adds no module-graph edge and resolves straight from the seed table. `@deepseek-ai/dsh-client-ui-primitives` is declared that way; a shell without the word leaves the toolview registrations out (reported in diagnostics) and the host renders its native rows.
- Keyed priority/shadowing: the Client slot core (in the web shell bundle) allows a second keyed registration only at a different `priority` and resolves a key with the **lowest** priority first — `register at a different priority to shadow it (lowest renders)`. Native views use the default priority 0.
- `conversation.composer.dock`: declared by `@deepseek-ai/dsh-client-ui-conversation` as `{ kind: "list", scope: "session" }`, rendered as `div[data-composer-dock]`. Owner props are empty; session-scope standard props (including `useSession`, `useChat`, `useConversation`) are supplied by the renderer.
- `shell.overlay`: declared by `@deepseek-ai/dsh-client-ui-layout` as `{ kind: "list", scope: "root" }`, rendered inside `[data-shell-overlay]`. Root standard props are `useSessions`, `useSessionStatus`, `useWorkspaces`, `usePanelInfo` and keyed access hooks — **no chat hook**; hence the toolview-published notice design above.
- `/tower` history: DSH logs `command/run` with `{ name, args: parsed.rawInput, source }` and `command/done` with `{ kind, text }`, which the Chat command node exposes as `{ kind: "command", name, args, outcome }` in the legacy slice.
- Guard denial shape: the Host tools pipeline materializes a denial as `{ content: [{ type: "text", text: "Error: <reason>" }], isError: true, error: { message: <reason> } }`.
- Locale: `ctx.locale.register(ns, { en, zh })`, dictionaries are flat `key → template` maps with `{param}` interpolation; a slot declaration's `locale` option supplies the bound `t` seat.
- The bundle's `dsh.client.inject` orders activation after `ui-conversation` and `ui-tool`, the two packages that declare the slots it targets, and `dsh.client.external` names the primitives static-table word. `ctx.slots.inject` only installs a registration while its owner declaration exists; each injection is guarded and reported in diagnostics instead of crashing the whole Client half.

Automated offline coverage: `tests/ui-bundle.test.mjs` loads `client.js` through a fake `window.__ModuleLoader__` (and each split chunk through the same loader when the entry calls `require.async`), seeds a fake primitives namespace whose `DisclosureRow` renders `open && children` like the host's, asserts the 9 keys / dock id / overlay id, en–zh dictionary parity, theme-token discipline, every file's loader format and the split-size budget, and renders every card plus the dock/overlay components with fake hooks. The tool-card tests drive the host `useDisclosure()` seat: a collapsed card asserts `open: false` with no curated body, clicking the row routes through the supplied toggle, an expanded card renders the curated rows, every card keeps its `data-tower-*` attributes, and a shell without the primitives word registers no toolviews at all. It also drives fake chat history through the dock to assert the off hint, the on chip (including refresh re-derivation), `tower_mode`/command updates, dynamic registration for default and configured deny lists, disposal on mode off, `update_goal`, denial-row treatment, generic fallbacks, and locale parity — no browser required.

Live/browser verification is **opt-in** (`tests/live/ui-slots.cjs`) because it needs an isolated profile with the bundle installed. From a teammate/subagent session the Client `Slots` inspect query times out by design (the page answers only the agent whose session it displays), so this phase did not run a live inspection; the source-level contract above is the evidence. When the script runs against an installed profile it binds a session with a bare `/tower` command and asserts, through the read-only `window.__TOWER_UI_DIAG__` report, that apply() ran without errors, that all 9 toolview keys and the dock/overlay entries registered, that the dock outlet is visible, and — since the bind command turns the Host mode on — that the history-derived `Tower · on` chip rendered (#11). The chip can be inspected visually in the same run (`data-tower-ui="dock-mode"`).

## Tests

```powershell
# offline, no browser
node --check ui-bundle/client.js
Get-ChildItem ui-bundle -Filter 'client*.js' | ForEach-Object { node --check $_.FullName }
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

- **No live Host state / no new RPC.** The mode chip is inferred from the **loaded history window** of the displayed session. If the `/tower on` command (or a `tower_mode` result) sits outside that window, the dock falls back to the static hint and the mode-aware rows are not registered; a later `/tower`, `tower_mode`, or pre-2.9.0 control result corrects it. The dock summary is likewise the latest visible Tower tool result, not a dashboard, and does not poll.
- **Mode-driven registration is slot-global.** The dock follows the displayed session. While that session is in Tower mode, the denied-tool shadow entries also apply to other sessions' rows for those tools (they render the defensive generic row); leaving the mode disposes them globally and restores the native views.
- **A custom `mode.denyTools` list needs a `tower_mode` result in the visible history.** The dock learns `deniedWhileActive` only from a `tower_mode` output; if the mode was inferred from `/tower on` alone (or the `tower_mode` result is outside the loaded window), the bundle shadows the default list instead, and a custom denied tool falls back to the native error row until a `tower_mode` output appears.
- **The on-chip is not a button.** `inputActions.submit()` submits the composer draft, so programmatically sending `/tower off` would overwrite the user's draft; the actionable tooltip asks the user to run it. There is no click handler and no automatic toggle from the bundle; the Host `tower_mode` tool (a write with `active`) remains the model's supported path.
- **The overlay is root-scoped.** It cannot read chat state directly, so a result that lands while every Tower toolview is unmounted (for example the user switches sessions before the result renders) shows no strip. The strip itself carries no actionable content by design.
- A tool result whose payload is not JSON (older/foreign shape) renders as a plain one-line summary rather than a card; errors render as an error card.
- Client bundle updates are not auto-rebuilt: edit → reconcile/link → **refresh the page**. Profile patch or manifest changes may need a restart.
- `window.__TOWER_UI_DIAG__` is a read-only diagnostic seam for tests. It contains no session content — only plugin version, applied flag, slot/toolview names, current mode summary, dynamic deny keys, and guarded registration errors.
