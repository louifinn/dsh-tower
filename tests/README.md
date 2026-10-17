# Tower tests

The test suite has three layers: pure functions, protocol end-to-end, and a real DSH Web runtime. The first two need no DSH process; the third runs in a **throwaway profile** on another port and never touches the profile you are using.

All commands below run from the **repository root** (the directory containing `package.json`). `$DSH_HOME` is the DSH data directory (default `~/.dsh`; on Windows usually `C:\Users\<you>\.dsh`).

## 1. Offline suite (run before every change)

```powershell
npm test
# equivalent to: node --test "tests/*.test.mjs"
```

> Node's `--test` no longer accepts a directory argument; pass a glob instead. A bare directory fails with `Cannot find module`.

- `unit.test.mjs` — pure helpers: scope overlap, scope validation, printable-ASCII titles, glob matching.
- `protocol.e2e.test.mjs` — drives the `Tower` class through a real temporary Git repository: init → plan → worktree → tasks → unread-inbox block → complete → finding → review → preflight → merge → teardown, plus automatic dependency for overlapping scopes and rejection of unknown dependencies.
- `plugin.test.mjs` — loads the real `apply()` from the repository-root `index.js` against a minimal mock Cordis context: every `/tower` input form, attachment forwarding, a complete `UserMessage` reaching `agent.steer`, guard denials, the dynamic prompt section, goal pausing, `tower_control` gating and reason validation, and mode persistence. It points `$DSH_HOME` at a temp directory and never writes the real store.

All temporary repositories and state are created under the OS temp directory and cleaned up automatically.

## 2. Real Web runtime (isolated profile)

Purpose: verify command registration, real `agent.steer`, `ctx.goals`, the guard, and tool output. It uses **another profile and another port**, so your active profile is untouched.

```powershell
# 1) Create a throwaway profile from the shipped web template
#    (do not use `desktop`: it can only be started by the Electron app)
dsh --profile towertest --from-default-profile web --dump-config
# 2) Add this repository to that profile (the repo root is the bundle root;
#    it is registered into dsh.profile.bundles automatically)
dsh plugin --profile towertest add <repo-root>
# 3) Start the isolated server (note the tokenized URL it prints)
dsh --profile towertest --port 59001 --no-open
```

The `tests/live/*.cjs` scripts require Playwright installed globally (`NODE_PATH` may point at the global `node_modules`; on Windows, `npm root -g` prints the path). Browsers come from Playwright by default; set `DSH_TEST_CHROME` to force a specific executable.

### Command semantics (no model required)

```powershell
$env:DSH_TEST_URL='http://127.0.0.1:59001/?token=<token printed at boot>'
node tests/live/command.cjs
```

The script opens a new session and submits `/tower on 继续`, `/tower`, `/tower off 继续`, and `/tower 继续` in order, saving screenshots and a log under `tests/live/`.

### Model-driven tools and guard (requires a usable account)

The `towertest` profile name is not `desktop`, so the account route is unavailable by default. Mount the account platform with the overlay:

```powershell
dsh --profile towertest --patch <repo-root>\tests\live\account.patch.yml --port 59002 --no-open
$env:DSH_TEST_URL='http://127.0.0.1:59002/?token=<token printed in the previous step>'
node tests/live/model.cjs
```

`model.cjs` asks the model to: `tower_control enter` → read `tower_mode` → call `create_goal` (must be denied by the guard) → `tower_control exit`.

### Cleanup

```powershell
# After stopping the servers:
Remove-Item -Recurse -Force "$env:USERPROFILE\.dsh\profiles\towertest"
# Delete only the sessions created by this test run; never delete by timestamp,
# and remove the test entries left in $DSH_HOME/tower-mode/modes.json.
```

`*.log`, `*.png`, and `backup/` under `tests/live/` are local acceptance artifacts. They are excluded by `.gitignore` and never enter the repository.

### Diagnostic and repair scripts (`tests/live/`)

These scripts resolve `$DSH_HOME` from the environment and derive the session directory from the **current working directory** by default; set `DSH_SESSION_ROOT` to override.

- `scan-session.cjs <text>` — search all session logs for a text fragment (decodes concatenated zstd frames).
- `dump-session.cjs <session-suffix> <from> <to>` — print events by sequence number; useful for locating a malformed message.
- `validate-messages.cjs <session-suffix>` — verify every user/assistant/system/tool message and inbox splice has an `id` and `role` (`problems=0` means clean).
- `repair-session.cjs <session-suffix>` — repair the 1.0.0 `missing field role` corruption: it only accepts exactly two role-less user messages, backs up the original under `tests/live/backup/`, replaces it atomically, and writes a validation copy under a fresh session id.
- `steer-role.cjs` — isolated Web regression for 1.0.1: `/tower 这是一条测试消息` must produce a normal model reply.

## 3. Manual acceptance checklist for a desktop install

After installing/restarting desktop (Host plugins load at process start, so a code change requires a DSH restart):

> The desktop Web UI answers plain browsers with 401 (it requires the boot token), so automation cannot type `/tower` for you. Items 1–4 must be typed by a human in the desktop composer. Items 5–8 can be verified by calling `tower_control` / `tower_mode` directly, by a human or by the model.

1. `/tower` → mode on; `tower_mode` reports `mode:"on"`.
2. `/tower on 继续` → mode on, and “继续” becomes the next user message.
3. `/tower off 继续` → mode off, and “继续” becomes the next user message.
4. `/tower 继续` → mode on with the instruction forwarded.
5. While the mode is on: `create_goal`, `todo_write`, `spawn_teammate`, and `update_goal(resume)` are refused by the guard.
6. With an active goal: after `/tower on`, the goal becomes paused (`tower_mode.pausedGoal` is set).
7. After `/tower off`, `todo_write` works again and the tower guard no longer blocks `update_goal`.
8. After a restart, `tower_mode` is still on for the same session id (`$DSH_HOME/tower-mode/modes.json`).
9. With `allowAgentControl: true`, `tower_control` exists; with the default `false` it does not.
10. Full chain: `tower_init → plan → spawn(worker) → inbox → complete → spawn(reviewer) → review → preflight → merge → teardown`, exercising all 13 blocker codes (see the repository `README.md`).
