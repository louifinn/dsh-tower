# Tower UI (optional Client widget, unverified)

An **optional** Web Client widget that shows a static `/tower` hint in the composer dock. It does not read the live Tower-mode state from the Host.

## Why it is not installed by default

- The Client half targets `conversation.composer.dock`, whose slot API and props have not been verified against a live page in this repository's test setup. Installing an unverified Client bundle can affect the Web UI.
- It is therefore a separate bundle from `dsh-tower` and does not affect installing or running the Host plugin.

## Install

```text
plugin_manager({ action: "install_bundle", target: "<absolute path to this ui-bundle>" })
```

Before installing, confirm in a test-enabled DSH session:

1. The `conversation.composer.dock` slot still exists (`Slots.listSubTree`).
2. `ctx.slots.register` still accepts the options and component signature used in `client.js`.
3. The hint appears in the composer area with no console errors, and disappears after the bundle is removed.

## Known limitations

- No live mode state (there is no Host → Client remote channel).
- A hint only, not a control; mode changes still go through the `/tower` command.
