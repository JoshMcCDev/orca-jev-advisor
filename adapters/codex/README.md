# Codex integration

In Orca's configuration page, use **Codex integration → Set up**, then
restart Codex and review and trust the new definitions through `/hooks` in
every account. Claude does not need to be installed. The command palette
also provides **Advisor: Install the Codex side** and **Advisor: Revert the
Codex side**.

Successful Codex setup becomes the preferred integration. Subsequent Orca
activation and module changes do not automatically install the Claude side.
Explicitly setting up Claude selects it again.

The installer merges native hooks into `~/.codex/hooks.json`, the active
`CODEX_HOME/hooks.json` when different, and existing Orca-managed
`<userData>/codex-accounts/<id>/home/hooks.json` directories whose ownership
marker matches the account ID. Run setup again after adding accounts.
Host-side setup does not reach remote or WSL homes.

Existing hooks survive setup and revert. The first changed existing file
is backed up once as `hooks.json.jev-advisor.bak`, with owner-only POSIX
permissions. Writes use a temporary file and rename and refuse a concurrent
edit detected before replacement. Revert removes only advisor entries;
backups, policy mirrors and keys remain available.

For standalone or remote Codex, run with Node 24 or newer from this plugin's
root (set `CODEX_HOME` first for a custom home):

```sh
node adapters/orca/install-codex-integration.mjs install .
node adapters/orca/install-codex-integration.mjs status .
node adapters/orca/install-codex-integration.mjs uninstall .
```

Hook commands contain absolute Node and plugin paths; rerun setup after
moving the plugin.

## Supported behavior

- `PreToolUse` on `Bash` runs the existing Node command gate: local rules,
  Jev/Clef decisions, destination policies, key resolution, caches and logs.
  The implementation is shared with the Claude adapter; no Claude executable
  or Claude settings are needed.
- `PreToolUse` on `apply_patch` protects advisor decision files and Codex's
  `hooks.json` and `config.toml`, including both paths in a move.
- `PostToolUse` on `Bash` records execution for pending gate decisions,
  including failed commands. Codex does not expose Claude's PermissionDenied
  event; missing outcomes remain unknown.
- The Gate module's Off switch is checked on every invocation. Passing the
  advisor gate leaves Codex's own approvals in control.
- Policies requiring human approval block the tool with a reason. Codex
  currently rejects PreToolUse's `ask` response and continues the call;
  forwarding it would lose the policy stop.

Model routing, context stewardship, the Claude skills mod, consumption and
Claude quota reporting are not ported by these hooks. The cross-worktree
board continues to use Orca's agent events.

Installation status confirms configuration only. Trust and execution inside
Orca's Codex runtime need a live check. Hosted and specialized tool paths,
and input sent to existing exec sessions, can bypass Codex's PreToolUse path.
Hooks are not a complete enforcement boundary.

References: [official Codex hooks](https://learn.chatgpt.com/docs/hooks) and
[Orca 1.4.235 managed homes](https://github.com/stablyai/orca/blob/v1.4.235/src/main/codex-accounts/codex-managed-home-path.ts).
