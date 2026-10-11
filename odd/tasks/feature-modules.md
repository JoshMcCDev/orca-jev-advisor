# Feature modules: one plugin, each feature switched on or off

## Objective
The owner, 2026-10-10:
- "Me gustaria tener un plugin base que se encargue de la configuracion y autenticacion de proveedores y los demas sean addons o plugins que se complementen y que pueda instalar lo que necesite o activar y desactvar";
- "cual me recomiendas para mejorar el performance y que Orca no se ponga lento y ademas que sea algo que pueda ir agregando o quitando facilmente".

The decision was option B: one Orca plugin owns provider configuration and the key, and each feature is a module with its own switch in our settings page. Separate Orca plugins (option A) were rejected on evidence from `orca-oss/src`:
- No plugin dependencies. `shared/plugins/plugin-manifest.ts:104-167` has no such field, and an unknown top-level key is stripped. The marketplace entry is a strict object (`shared/plugins/plugin-marketplace.ts:76-86`).
- No plugin-to-plugin API (`shared/plugins/plugin-host-api.ts:122-263`).
- A per-plugin secret vault that no other plugin can read (`main/plugins/plugin-secrets-store.ts:31-32`). Addons would have to read the plaintext `~/.config/orca-supervisor/env` mirror.
- Remove runs no plugin code (`main/ipc/plugins.ts:230-245`), so each addon would leave its hooks in `~/.claude`.
- One forked process per plugin (`main/plugins/plugin-host-process.ts:78`), and at most 5 active workers (`shared/plugins/plugin-host-protocol.ts:114`). Workers start lazily and are reaped after 5 idle minutes, so the 5-slot limit only bites when several plugins keep a cadence awake. That is a cost of A, not a certainty.

## Scope
A module is a feature the owner can turn off so it costs nothing:
- no hook process;
- no Jev call;
- no worker timer or event handler.

The modules and what each one owns today:

| Module | settings.json hooks | Shared mod copy | Worker work |
|---|---|---|---|
| `gate` | Bash: PreToolUse, PostToolUse, PostToolUseFailure, PermissionDenied (`gate-bash`, `gate-outcome`); Edit\|Write\|MultiEdit\|NotebookEdit: PreToolUse (`gate-files`) | none | gate stats, gate authorizations status |
| `model-router` | Agent: PreToolUse, PostToolUse, PostToolUseFailure (`agent-model`) | router tier judgement | model measurement |
| `steward` | none | context steward | compaction measurement |
| `skill-selection` | none | skill and tool selection (`active`, `activeTools`) | none |
| `board` | none | none | `agent.status.changed`, `worktree.*` events, catalog refresh |

The table is a draft. T1 verifies every row against the code before the registry is written.

What "off" means depends on the kind of artifact:
- **settings.json hooks:** the entries are uninstalled.
- **Shared mod copy:** it stays installed while any module that uses it is on. A module that is off returns before any Jev call.
- **Worker work:** the timer and the handler are never registered.

Rules:
- **One registry.** A pure list in `src/core/feature_modules.ts` says, for each module, its id, hooks, mod features, worker tasks and default. The installer, the worker, the mod and the panel all read it. Adding a module is one entry.
- **One switch per feature.** `off` is a new top state in front of each module's existing modes:
  - the router's `off`/`measure`/`active`;
  - the steward's `measure`/`active` and its tier switch;
  - the skills mod's `active`/`activeTools`;
  - the legacy model switch;
  - the deny-tier switches.
  
  It is never a second boolean that can disagree with them. `off` is not `measure`: today the skills mod makes two Jev calls per prompt with both switches off, because that is measurement mode.
- **Upgrade keeps behaviour.** With no module file present, every module defaults to what runs today. An upgrade never turns a module off.
- **The gate protects its own switch.** The module state file is refused by `gate-files` and by the Bash gate, both by Edit/Write and by heredoc, `sed -i`, `cp`, `mv` or `rm` on it. Only the panel can change it.
- The provider key keeps its current home: Orca `secrets` (`typesafeApiKey`) plus the 0600 env mirror. This feature does not move it.

## Out of scope
Splitting into separate Orca plugins, or changing Orca. If Orca later gains manifest dependencies and shared secrets, each module can be extracted as its own plugin; that would be a new feature.

## Checklist
- [ ] T0 measure: per module, from the gate log, the mod logs and the last 7 days of transcripts: hook spawns per tool call and their latency, Jev calls per prompt and per turn, and worker wakeups per hour. The result is the baseline for the acceptance criteria. Script under `scripts/`, numbers recorded here.
- [ ] T1 core registry: `src/core/feature_modules.ts`. It holds the module list (verified against the code), `parseFeatureModules(content)` (never throws; missing or malformed input gives today's behaviour), and `moduleState(id)` combining `off` with the existing mode. Strict TDD: RED, then GREEN.
- [ ] T2 gate protection: the module state file joins the gate's own-files refusal (`adapters/claude/gate-files.ts`, and the Bash gate's own-file rules). Subprocess tests for Edit, Write, heredoc, `sed -i`, `cp`, `mv` and `rm`.
- [ ] T3 installer: `install-claude-integration.mjs` installs only the hooks of the modules that are on, and uninstalls the hooks of the modules that are off. It stays idempotent and goes through the 0.6.26 never-go-back-a-version guard. The mod copy stays while any mod module is on. Verify whether a change to the mod copy needs a Claude Code reload; 0.6.24 showed that settings.json hooks do not. Write the answer here.
- [ ] T4 mod and worker: each mod feature returns before any Jev call when its module is off. The worker registers no timer or handler for a module that is off. Tests: zero Jev calls and zero timers for an off module.
- [ ] T5 panel: a Modules section at the top of the config page. Each module has a switch, one line on what it does, and what it costs from T0. The existing per-feature controls are hidden while their module is off. Strings in es and en. Turning a switch runs the installer through the worker's request/result channel, and the page shows the result. Screenshots at 1440, 768, 390 and 320 px in both themes, under `odd/qa/screens-<version>/`.
- [ ] T6 docs, version, release, catalog, and a live check of the marketplace install: turn each module off and on, confirm `~/.claude/settings.json` and the mod copy follow, and confirm a disabled module produces no Jev call in the logs.

## Acceptance criteria
- Strict TDD per task: RED observed, then GREEN. `npm run typecheck` reports 0, and `npm test` and `npm run test:panels` are green.
- A module that is off causes 0 hook spawns, 0 Jev calls and 0 worker timers. This is measured the same way as T0.
- An upgrade with no module file behaves exactly as 0.6.28.
- An agent cannot turn the gate off: an edit of the module file by any tool or shell route is refused.
- Turning a module back on restores its hooks with no restart, or the panel says clearly that a reload is needed (per T3's finding).

## Checks
`npm run typecheck`, `npm test`, `npm run test:panels`, `npm run shots`, the T0 measurement script, and a live check of the marketplace install.

## Memory
The Engram mirror `odd/feature-modules/tasks` is pending: the Engram MCP server failed to start in the 2026-10-10 session (ENOENT on `/opt/homebrew/Cellar/engram/1.20.0/bin/engram`).
