# orca-jev-advisor (Orca plugin)

The `orca-supervisor` project's Orca adapter: the container for a
Jev-backed (TypeSafe) decision layer that runs *inside* Orca,
as a plugin, instead of as a separate CLI. It only sees its own
worktree for direct actions (`terminal.sendText`, `workspace.readContext`),
but maintains a cross-worktree board through `storage` and the
only global event that exists (`agent.status.changed`).

It doesn't duplicate logic: all the decision-making (Jev, the three
verdicts, the typed storage, the log) lives in `../../src/core/` and is
the same one used by the `tools/` CLIs and the Claude Code hook in
`adapters/claude/`. This directory is just Orca's surface: the manifest,
the worker, and the two panels.

## What's here

```
orca-plugin.json           manifest: panels, commands, events, capabilities
main.mjs                    worker: activate(host) -> { commands, teardown }
config-web.mjs              short-lived loopback bridge for the config page
write-secret-mirror.mjs      sidecar: writes/reads the key mirror (see below)
panels/board.html            navigation panel: the board, in four tabs
                             (Gate, Activity, Consumption, Skills)
panels/config.html           settings panel: key, catalog, policies, thresholds
icons/advisor.svg            icon used by both panels
```

## Commands

- **`advisor.decide`** — receives `{ actions: string[] }`, runs
  `decideDestination` (policy first, risk after, same as
  `tools/decide.ts`) on each one, logs each verdict in the log
  (`src/core/log.ts`), and shows a notification with the summary.
  Returns the array of decisions.
- **`advisor.board`** — returns the current contents of `storage`'s
  `board`: the `{worktreeId, project, projectName, rama, paneKey, state,
  receivedAt, updatedAt}` table that `main.mjs` keeps updated by listening
  to `agent.status.changed`. `project` is Orca's raw projectId;
  `projectName` is the name the board shows, resolved the way the
  measurement log names a project (null when nothing can name it).
- **`advisor.doctor`** — checks four things and returns
  `{ok, checks[]}`:
  - `api-key`: not just that there's a resolved key (`secrets` or the
    environment/file fallback) -- it makes a real, minimal call to
    Jev and reports what actually happened: valid key (Jev responded),
    rejected key (401/403), no network (timeout or connection error),
    or no key. A dead key shows up red here, not green.
  - `secret-mirror`: whether the mirror file (see the next
    section) matches what's currently in `secrets`.
  - `orca-cli`: whether the platform-selected Orca CLI responds to
    `status --json` (the registered Linux CLI shim by default; the worker
    launches it as a child process and does not send anything to a terminal).
  - `catalog`: whether the catalog stored in `storage` has a valid
    shape.
- **`advisor.doctor`** checks the configuration, then opens the configuration
  page in an Orca Browser tab. Orca 1.4.235 does not allow its embedded plugin
  panels to access plugin storage, so this is the supported way to load and
  save settings.

## The key mirror (`~/.config/orca-supervisor/env`)

The configuration page stores the TypeSafe key in `secrets` (encrypted by
Orca with Electron's `safeStorage`), but the `tools/`
CLIs and `adapters/claude/gate-bash.ts` run as plain Node, outside
of Electron, and can't read `secrets` -- it's a real boundary, not an
oversight. On Orca 1.4.235, however, sandboxed panels cannot call
`storage.*` or `secrets.*`, so this panel cannot load or save settings.
The worker itself can still read and write its own `secrets` store. When
a worker-side key change does happen, or when the worker activates,
`main.mjs` mirrors its value to `~/.config/orca-supervisor/env`
(`TYPESAFE_API_KEY=...`, the same fallback already documented by
`src/core/secrets.ts`), with **`0600`** permissions and an atomic
write (temp file + `rename`). When the key is deleted, the mirror is
deleted too (or just that line is removed from it, if the file had
other content).

The worker can't write that file itself: its permission sandbox
only lets it read its own plugin root (measured, not assumed --
writing there threw instead of resolving). The write instead runs in
`write-secret-mirror.mjs`, a clean child process (`mandoSinValla`, the
same `/usr/bin/env -u NODE_OPTIONS` pattern already used by
`orca-wa-inbox/main.mjs` for this same class of problem). The key
crosses to that child only via **stdin**, never via argv (visible in
any `ps`) nor in any `orca.log`.

The fallback file is plaintext, though only its owner can read it.
The embedded settings panel cannot call `storage.*` or `secrets.*` on Orca
1.4.235. **Advisor: Check configuration** serves the same HTML from a
short-lived server bound only to `127.0.0.1`; a random token in the URL
fragment authorizes that browser tab to forward only `storage.get` and
`storage.set` to the worker. The fragment is not sent in HTTP requests, the
server does not expose secret methods, and the API key stays in the worker's
encrypted `secrets` store. The worker handles the secret request and writes
the existing 0600 fallback mirror for tools and hooks.

## How the board gets filled across worktrees

`terminal.sendText` and `workspace.readContext` are **limited to
the plugin's active worktree** -- that's verified, not an assumption.
`agent.status.changed`, on the other hand, is the only global event: it
carries `worktreeId` in its payload regardless of which worktree the
worker instance that receives it is running in. Since `storage` doesn't
appear on the list of capabilities limited to the active worktree, this
plugin treats it as the shared channel: every instance that receives
the event writes the same `board` key, so any worktree that opens the
panel sees the state of all of them. Crossing into *action* on another
worktree (not just reading) would still need `process:spawn` to invoke
`orca terminal send` from outside -- that's exactly what this skeleton
does NOT do yet (see below).

## What's built

- The Jev client, the three decision families, the typed store, the
  log, and key resolution -- all in `../../src/core/`, with
  explicit guards and no `any` anywhere.
- The manifest declares panels, commands, events, and capabilities,
  and every path it declares (`main`, each `panel.entry`, each `icon`)
  exists on disk -- verified with a script that reads the JSON and
  checks each path.
- `main.mjs` subscribes to the three events, keeps the board
  updated, exposes the three commands, and its `teardown` cancels the
  three subscriptions -- nothing is left running after Orca kills the
  worker.
- The two panels are plain HTML+CSS+JS, no build, no external
  request, readable at narrow width (visually tested against 320px of
  content width, the tightest case for a side panel).

## What's NOT built (and why)

- **The panel ↔ worker bridge is a documented proposal, not a
  confirmed contract.** The two HTML files assume a `postMessage`
  protocol (`advisor:ready`, `advisor:requestBoard`,
  `advisor:board`, `advisor:requestConfig`, `advisor:config`,
  `advisor:saveSecret`, `advisor:clearSecret`, `advisor:saveConfig`,
  `advisor:saveResult`) because the panel runs in a sandboxed iframe
  with an opaque origin and that's the only channel possible. There
  was no access to the real runtime that instantiates an Orca panel to
  confirm the exact names of those messages -- adjust them here and in
  `main.mjs` as soon as they're confirmed. Today `main.mjs` doesn't
  have the side that listens for those messages: it only exposes the
  three manifest commands.
- **The activation contract (`activate(host) -> {commands, teardown}`)
  is a reasoned assumption, documented in `main.mjs`'s header**,
  not something verified against Orca's runtime. The 13 host methods
  (`workspace.readContext`, `terminal.sendText`, `notifications.show`,
  `storage.*`, `secrets.*`, `settings.*`, `events.subscribe`) are
  verified; how Orca invokes `activate` and dispatches an invoked
  command to the `commands` map is not.
- **No automations.** Orca 1.4.235's strict `contributes` schema does
  not allow `automations`, so the manifest does not declare it.
- **No action crosses worktrees yet.** `advisor.decide` judges
  actions; it doesn't execute them on any worktree. Executing on
  another worktree would require a separate action implementation; this
  adapter does not send commands to terminals or create terminals.
- **Manifest capability boundary.** The manifest lists the supported
  host capabilities used here: `notifications:show`, `storage`,
  `secrets`, and `events:subscribe`. Orca 1.4.235's capability schema
  does not include `process:spawn` or `net:fetch`. The worker uses Node
  `child_process` and `fetch` directly; Orca's host capability review
  does not gate those calls.
- **Plugin activation still needs a live Orca check.** The manifest has
  been aligned with the 1.4.235 schema, but loading, worker command
  registration, and panel communication have not been exercised.
- **Agent hooks have their own runtime boundary.** Codex setup installs
  hook definitions; Codex's trust review and actual execution still require
  a live check. Successful Codex setup selects it as the preferred integration
  and suppresses automatic Claude setup on subsequent activation.

## How to load it as a development plugin

The development plugin path must point to the repository root, where
`orca-plugin.json` lives. Orca resolves the manifest's `main`, panel,
and icon paths relative to that root.

1. Open Orca's plugin settings and add the repository root (the folder
   containing `orca-plugin.json`) as a development plugin path
   (`devPluginPaths` in Orca's configuration). Do not add
   `adapters/orca/`; that folder does not contain the manifest.
2. Refresh the plugin list. Review and enable Jev Advisor if Orca
   prompts for permission review.
3. The `Jev Advisor` settings panel cannot read or save settings on
   Orca 1.4.235 because the host does not expose plugin storage or
   secrets to sandboxed panels. Run **Advisor: Check configuration** to
   check the setup and open the working settings page in Orca Browser. Do not
   assume a key entered into the embedded panel was saved.
4. Save the key in that browser page, then run **Advisor: Check
   configuration** again to confirm it before using `advisor.decide`.

## Codex integration

The configuration page has Codex setup/revert controls and matching
`advisor.installCodex` / `advisor.uninstallCodex` commands. Native hooks
share the gate, policies and key mirror without a Claude installation.
Setup preserves other hooks and requires review through Codex's `/hooks`.
See the [Codex guide](../codex/README.md) for supported features and runtime
verification limits.

## Node and dependencies

Node ≥24, `"type": "module"`, zero dependencies, no build step.
`main.mjs` imports `.ts` files directly from `../../src/core/` thanks
to Node's native "type stripping" -- the same mechanism already used
by `tools/*.ts` and `adapters/claude/gate-bash.ts`.
