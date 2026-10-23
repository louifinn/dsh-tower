# Hot reload (development)

Tower is a Host plugin: its tools and prompt sections are loaded when DSH boots. DSH already ships
`@deepseek-ai/dsh-hmr`, a service that **reconciles the profile in place** — it re-reads the profile
patch layers, replaces modules whose files changed (including a linked package such as a `dsh-tower`
checkout), restarts the affected Loader entries and reports anything that needs a full restart. Tower
uses that service in development so Host-side changes apply without restarting DSH.

This page covers the development loop. It is not required to use Tower.

## What HMR does and does not do

`dsh --profile <name> --dump-config` prints the composed hmr row:

```yaml
- id: hmr
  name: '@deepseek-ai/dsh-hmr'
  disabled: !!js '!ctx.get(''profileContext'')'
  config:
    root: []
```

- `root: []` is the shipped default: **no source files are watched**. HMR is mounted but idle for
  file-watching, so a running DSH does not reload when you edit the checkout.
- A reconciliation can still be requested explicitly (`/tower reload`, `tower_reload` or
  `plugin_manager`); it compares already-loaded modules with disk and replaces the changed ones even
  with `root: []`. Watching only makes that happen automatically after a save.
- HMR is only mounted for profile boots (`disabled` when there is no `profileContext`). A process
  booted without a profile reports reload as unavailable (`tower_reload` stays registered while
  `dev.hotReload` is on, so the tool returns `reload-unavailable` instead of disappearing).
- The profile patch layer is loaded when DSH boots. Editing it — in practice the hmr `root` list —
  takes effect after **one DSH restart**. Nothing in the running process re-reads the HMR row's own
  configuration.

## Enable watching for a checkout

From a checkout of this repository:

```powershell
npm run dev:hmr
# equivalent to:
node scripts/enable-dev-hmr.mjs
```

The script appends one marked block to the profile's user patch layer,
`<DSH_HOME>/profiles/<profile>/cordis.patch.yml` (`DSH_HOME` defaults to `~/.dsh`; on Windows
usually `C:\Users\<you>\.dsh`):

```yaml
# dsh-tower:dev-hmr
- id: hmr
  config:
    root:
      - 'D:/work/dsh-tower'
```

Options:

| Flag | Meaning |
|---|---|
| `--profile <name>` | Profile to edit. Default `desktop` (the profile the desktop app boots). |
| `--root <dir>` | Repository directory to watch. Default: the current working directory, canonicalised. |
| `--dry-run` | Print a diff of the patch file and exit without writing. |
| `--remove` | Delete the marked block again. |

Notes:

- The script is idempotent: re-running it replaces the marked block and leaves every other line of the
  patch file untouched. Run it from the repository root, or pass `--root D:\work\dsh-tower`.
- The value written is the `realpath` of the root, with forward slashes. **HMR `root` accepts
  absolute paths**; relative entries would resolve against the profile directory and are easy to get
  wrong, so the script always writes an absolute one.
- The profile must already exist. The script never creates a profile and never creates directories
  outside `<DSH_HOME>/profiles/<profile>/`.
- Pick the profile the desktop app actually boots (`desktop` by default). The desktop profile is
  managed by the Electron app, so restart it by quitting and relaunching DSH.

**Restart DSH once** after writing the block. After that restart:

- HMR watches the checkout (except `node_modules`, dot-directories, `cache` and `data`, which the
  shipped `ignored` list excludes) and reconciles the profile after edits while DSH stays open.
- `/tower reload` (and the `tower_reload` tool, when registered) reconciles on demand even for files
  the watcher does not cover.

To stop watching, run `npm run dev:hmr -- --remove` and restart DSH once.

## The edit loop

1. Edit `host/*.js`, `adapters/*.js`, `app/*.js`, `domain/**/*.js`, `index.js`, `worker.js`, `reviewer.js` or `skills.js`.
2. Save the file. The watcher debounces (DSH default 100 ms) and reconciles the profile; changed
   modules are replaced and the affected Loader entries restart.
3. Watch the DSH log for `reload plugin at <path>` / `restart required: …` messages.
4. Optionally call `/tower reload` or `tower_reload` to reconcile on demand instead of waiting.

Editing the repository's bundle patch (`cordis.patch.yml`) changes the plugin declaration itself;
restart DSH after such a change rather than assuming a hot replacement.

The bridge behind the tool follows the `dev` config group:

| Config key | Meaning |
|---|---|
| `dev.hotReload` | Register `tower_reload`; `/tower reload` is disabled when off (default `true`). Without the HMR service the tool is still registered so it can return `reload-unavailable`. |
| `dev.reloadDelayMs` | Delay before the scheduled reconciliation runs, in milliseconds (default `50`), so the tool/command result reaches the model before the plugin is replaced. |
| `dev.reloadRequiredIds` | Loader entry ids the profile must keep active (default `tower-bundle`, `tower`, `tower-skills`, `preset-tower-worker`, `preset-tower-reviewer`). An inactive required entry is reported as a reload failure even if it was already inactive. |

A reload is **scheduled, not awaited**: `/tower reload` and `tower_reload` return immediately with
`scheduled`, `delayMs`, `requiredIds` (and the current `lastError` when one is pending), then HMR
reconciles the profile after the delay. This is deliberate — the tool result must be delivered before
the Tower plugin replaces itself. Two consequences:

- a burst of reload requests inside the delay coalesces into a single reconciliation;
- a reconciliation failure is recorded as `lastError` instead of coming back from the tool call, so
  check `tower_mode.hotReload` and the DSH log after a reload.

### Reading a reload result

The outcome of the scheduled reconciliation surfaces in:

- **the DSH log** — `reload plugin at <path>` for replaced modules, plus HMR's warnings and
  `restart required: <reason>` messages from its own watcher.
- **`tower_mode.hotReload`** — `{available, requiredIds, delayMs, scheduled, lastRunAt, lastError}`;
  `lastError` keeps the most recent failure and is cleared by the next successful reload.

The reconciliation itself also returns `warnings`, `pending` (modules still on their previous code)
and an optional `restartReason`. When the reload was triggered from Tower those are not returned to
the model, so treat "new code does not appear" as a signal to restart DSH rather than to retry in a
loop.

If HMR is absent, `/tower reload` answers with an unavailable message and `tower_reload` is not
registered at all (both are gated on the HMR service at session start).

## Plugin manager and linked packages

`plugin_manager` actions (`install_bundle`, `set_plugin`, upgrades) apply to the running profile
immediately — they reconcile the profile themselves, so installing or updating a bundle does not
require a restart. This is the intended way to install `dsh-tower` while developing: add the checkout
as a bundle (`dsh plugin --profile <profile> add <repo-root>` or `install_bundle`), then let HMR and
the reload tool pick up code edits.

With the checkout linked as a package target, a changed file inside the checkout is replaced by the
next `reconcileProfile` or `plugin_manager` operation **without a restart**, even when `root: []`
means the change was not watched. What does need a restart:

- the hmr row's own configuration (`root`), because that list is read when the service activates;
- modules reported under `pending` or with a `restartReason`.

## Failure recovery

| Symptom | What to do |
|---|---|
| `[tower:reload-unavailable]` / "Tower reload is unavailable" | This process has no HMR service (booted without a profile, HMR disabled in the profile, or the service was disposed during shutdown). Restart DSH. To inspect the hmr row, run `dsh --profile <name> --dump-config` on a non-desktop profile (the desktop profile is managed by the Electron app and refuses the dump). |
| `[tower:reload-failed]` in `hotReload.lastError` with a syntax/import error | Fix the file, then restart DSH. A replacement that fails to import stops the previous plugin instance and its old code no longer runs; the reload itself cannot roll back. |
| `HMR is disposed` | The service shut down with the process. Restart DSH. |
| `HMR transactions cannot be nested` | An explicit reload was requested from inside another HMR transaction; call the tool from a normal tool turn instead. |
| `pending` is non-empty or `restartReason` is set | Restart DSH before trusting the reload result. |
| Edit saved but nothing reloads | Confirm the file is under the configured `root` (absolute path), is not excluded by `ignored` (`node_modules`, dot-directories, `cache`, `data`), and that the profile patch contains the marked block. Run `/tower reload` to reconcile manually. |
| Reload keeps reporting an inactive required entry | That Loader entry is disabled or failing: check the profile's plugins/bundles (a `preset-tower-*` entry is missing when a Tower preset bundle was removed) and restart after fixing it. |

The offline bridge tests are part of the normal suite:

```powershell
node --test tests/hmr.test.mjs
```

## Client bundles (`ui-bundle`) are different

HMR replaces **Host** plugins and prompt/tool code. The optional `ui-bundle` is a Client widget: its
JavaScript is downloaded and evaluated by the Web page, not by the Host process. After a Host reload
or a Client bundle install/update, the open page may keep the old widget — refresh the Web page (and,
if a tool schema changed, open a new session) before assuming the change failed. The Tower UI widget
is a hint only and is not required for hot reload.

For a live check of the reload path against an isolated profile, use
[`tests/live/hmr.cjs`](../../tests/live/hmr.cjs) with `DSH_TEST_URL` set to the throwaway server URL
(see [tests/README.md](../../tests/README.md)); it never touches the desktop profile or live sessions.

## Security

HMR executes the code it finds in the watched roots **inside the DSH Host process**, with your OS user
privileges, and it reloads it on save. Treat the profile patch layer like shell startup files:

- only point `root` at repositories you trust (this checkout), and keep the list small and absolute;
- do not add your home directory, a downloads folder, or a shared/network path;
- the patched profile is same-user trusted configuration; anyone who can write it can run code in
  your DSH process;
- remove the block (`--remove`) and restart once when you no longer need watching.

See also: [install, upgrade and migration](install-upgrade-migration.md),
[configuration reference](../reference/config.md), [error codes](../reference/errors.md).
