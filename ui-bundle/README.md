# Tower UI (optional Client hint)

An **optional** Web Client bundle that shows a static `/tower` hint in the composer dock. It does not read or claim the live Tower-mode state from the Host: there is no Host → Client remote channel for it, so the hint is only a command reminder (`/tower on [message]` / `/tower off [message]`).

## Verification status

Verified against the live DSH **0.2.1-rc.2** slot catalog (`Slots.listSubTree`, `root: "conversation.composer.dock"`):

- The slot exists: `kind: "list"`, `scope: "session"`, purpose "Ambient entries below the composer card.", `replaceRisk: "none"`.
- Its registration options are `id` (required string), `order` (optional number), `label` (optional string or function) — exactly the options used by `client.js`.
- The owner passes **no** props (`ownerProps: []`), so a static component that ignores props is valid.
- Current occupants are the built-in `activity` and `usage` entries; `order: 6` appends this hint after them.
- The Client renders the slot outlet as `div[data-composer-dock]` inside the composer bar.

`client.js`, `index.js`, `cordis.patch.yml` and `package.json` follow DSH's shipped decoration template for this slot and are unchanged by the verification.

Visual/manual verification in an actual page is still opt-in: use `tests/live/ui-slots.cjs` against an isolated profile (it never installs into the desktop profile). The hint has not been installed in the live desktop profile.

## Why it is a separate bundle

It is not installed by default and does not affect installing or running the Host `dsh-tower` plugin. It is an optional Client decoration; the Host plugin is fully functional without it.

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

- No live mode state; the hint never reflects whether Tower mode is on.
- A hint only, not a control; mode changes still go through the `/tower` command.
- Client bundle updates are not auto-rebuilt: the DSH Client HMR receiver's reload transport only covers rebuilt bundles, so edit → reconcile/link → **refresh the page**. Profile patch or manifest changes may need a restart.
