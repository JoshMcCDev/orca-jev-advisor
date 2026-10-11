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
- **Three states per module: `off`, `shadow` and `active`.** Shadow runs the module and logs what it would do, with no effect on the turn; the pattern comes from jev-belay and Jev_steer_or_queue. A new module enters in shadow and becomes active only after a week of measurement. Where a module already has a measure mode, that mode is its shadow; a second shadow switch is not added.
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
- [x] T0 measure: per module, from the gate log, the mod logs and the last 7 days of transcripts: hook spawns per tool call and their latency, Jev calls per prompt and per turn, and worker wakeups per hour. The result is the baseline for the acceptance criteria. Script `scripts/measure-module-cost.mjs` (`npm run measure-module-cost -- --since 2026-10-04T22:00:00Z`); the rules live in `src/core/module_cost.ts` (14 unit tests). Strict TDD: RED (module missing), then GREEN 14/14.
  - **Window:** 2026-10-04T22:00Z to 2026-10-11T05:51Z, 6.3 days. That is the last 7 days minus the hours of the stale 0.6.10 install, when the gate and mod logs were not written. The gate log shows plugin 0.6.25 to 0.6.28.
  - **Totals from the transcripts:** 1223 person prompts on the main thread, 1460 completed turns and 25756 tool calls. Deduplicated by uuid and tool-use id, subagents included.
  - **Sources:**
    - the plugin cache dir: `gate-decisions-*`, `mod-skills-measurements-*`, `mod-tools-measurements-*`, `model-router-decisions-*`, `model-reclassifications-*`, `context-steward-decisions-*`;
    - the Claude transcripts;
    - the 5 settings.json files Claude Code reads: home plus 4 Orca accounts, all with the same 8 hooks of ours;
    - Orca's plugin audit log (`plugins-data/audit.log*`).

  | Module | Hook spawns (derived) | per matching tool call | Hook ms p50 / p90 (observed) | Jev calls (observed) | per prompt | per turn | Jev ms p50 / p90 (observed) | Jev failures (observed) |
  |---|---|---|---|---|---|---|---|---|
  | gate | 41101 | 1.93 | 596 / 720 (n=11307) | 12275 | 10.04 | 8.41 | 383 / 441 (n=11335) | 49: 44 unreachable, 5 hook timeouts |
  | model-router | 164 | 2 | not recorded | 1388: router 1306 (start 732, stage 495, subagent 79) + agent-model 82 | 1.13 | 0.95 | 381 / 444, agent-model only (n=82); the router logs none | 11 |
  | steward | 0 | - | - | 578 | 0.47 | 0.40 | not logged | 1 |
  | skill-selection | 0 | - | - | 8992: skills 3468 + tools 5524 | 7.35 | 6.16 | 327 / 593 (n=6576) | 41 |
  | board | 0 | - | - | 0 | 0 | 0 | - | 0 |

  - **How the hook figures were made:**
    - Spawns are derived: tool calls from the transcripts times the installed matchers. Pre counts every call, Post every success, PostFailure every error. PermissionDenied is not observable and counts 0.
    - Hook latency is observed only for the gate's PreToolUse:Bash, and only on the runs where Claude Code recorded it (the runs that printed something). The other hooks print nothing, so no transcript times them.
    - The mod (model-router, steward and skill-selection) runs inside Claude Code and spawns no process.
  - **How the Jev figures were counted:** one count per log row, with the rule each writer follows.
    - gate: a `jev` row is one call; `none`/`unreachable` is one failed call.
    - skills: wide is one call, plus fit when it ran.
    - tools: one wide call per batch of 255 (the roster held 114 to 643 tools), plus fit.
    - router: a row with a confidence, or `jev-failed`.
    - agent-model: one call per `model-decision`.
    - steward: one call per row.
  - **Worker:** cadences are derived from `adapters/orca/main.mjs`. Rates are observed in the audit log as `storage.set` writes with outcome `ok`, from 2026-10-10T01:49Z to 2026-10-11T05:51Z (28 h, the whole log after rotation). The worker never idled in those 28 h.
    - **The 15 s timer** runs 3 jobs, and each spawns one node sidecar:
      - measurements summary: shared by gate and skill-selection, 239.8/h;
      - model measurements: model-router, 233.5/h;
      - gate authorizations: gate, 235.8/h.

      That is about 709 node processes an hour.
    - **The 10 min timers** each run 6/h:
      - account quota mirror: model-router. Derived only, because it has no audit key. It runs 1 sidecar plus `orca account list`.
      - router status: model-router, 5.9/h.
      - model docs check: model-router, once a day.
      - consumption summary: shared by model-router and steward, 1 sidecar.
      - activity summary: shared by gate and model-router, 1 sidecar.
    - **Board:** the `agent.status.changed` handler wrote the board 164.4 times an hour. Its 30 s `orca` CLI cache was refreshed 19.1 times an hour. Each refresh runs `orca worktree list` and `orca repo list`, so about 38 CLI spawns an hour; that figure is derived. `worktree.created` is a no-op handler. `worktree.removed` writes nothing the audit log shows.
    - **Base, not a module:** the request poll and heartbeat ran 234.7 times an hour.
    - **Own timers per module:**
      - gate: 1, plus 2 shared;
      - model-router: 4, plus 2 shared;
      - steward: none, 1 shared;
      - skill-selection: none, 1 shared;
      - board: 3 event handlers.
  - **Findings:**
    - Every Agent spawn costs 2 Jev calls, one from the agent-model hook and one from the router's subagent point: 82 + 79 for 82 Agent calls. It also costs 2 hook processes.
    - `gate-files` makes no Jev call, although its status message says Jev checks the edit.
    - Both mod switches ran `active` all window: 1775 skills and 1773 tools decisions, with 0 measurement rows. That is 5.07 Jev calls per decision, so the "two Jev calls per prompt with both switches off" under Rules was not observable on this machine.
    - The mod made more decisions (1775) than this count of person prompts (1223). It also decides on prompts that count leaves out, such as notifications and wrapped prompts.
- [ ] T1 core registry: `src/core/feature_modules.ts`. It holds the module list (verified against the code), `parseFeatureModules(content)` (never throws; missing or malformed input gives today's behaviour), and `moduleState(id)` combining `off` with the existing mode. Strict TDD: RED, then GREEN.
- [ ] T2 gate protection: the module state file joins the gate's own-files refusal (`adapters/claude/gate-files.ts`, and the Bash gate's own-file rules). Subprocess tests for Edit, Write, heredoc, `sed -i`, `cp`, `mv` and `rm`.
- [ ] T3 installer: `install-claude-integration.mjs` installs only the hooks of the modules that are on, and uninstalls the hooks of the modules that are off. It stays idempotent and goes through the 0.6.26 never-go-back-a-version guard. The mod copy stays while any mod module is on. Verify whether a change to the mod copy needs a Claude Code reload; 0.6.24 showed that settings.json hooks do not. Write the answer here.
- [ ] T4 mod and worker: each mod feature returns before any Jev call when its module is off. The worker registers no timer or handler for a module that is off. Tests: zero Jev calls and zero timers for an off module.
- [ ] T5 panel: a Modules section at the top of the config page. Each module has a switch, one line on what it does, and what it costs from T0. The existing per-feature controls are hidden while their module is off. Strings in es and en. Turning a switch runs the installer through the worker's request/result channel, and the page shows the result. Screenshots at 1440, 768, 390 and 320 px in both themes, under `odd/qa/screens-<version>/`.
- [ ] T6 docs, version, release, catalog, and a live check of the marketplace install: turn each module off and on, confirm `~/.claude/settings.json` and the mod copy follow, and confirm a disabled module produces no Jev call in the logs.

### Next modules, after the registry ships
Each one is a registry entry that enters in `shadow`. Its own task file is written when it starts. The details and the first thing to verify are in `odd/backlog.md`, under "Candidate modules from similar tools".
- [ ] M1 Verify the "done" (jev-belay): a Stop hook that blocks an unverified "done".
- [ ] M2 Gate MCP tools against the goal (jev-browser's irreversible question). This could extend the `gate` module instead of being a new one; decide in its task file.
- [ ] M3 Browser steps judged by Jev (jev-browser).
- [ ] M4 Project rules on every edit (abide), turn level, shadow only.
- [ ] M5 Messages written mid-turn (Jev_steer_or_queue).
- [ ] M6 Cheap bulk classification (quicksilver).
- [ ] M7 Site audit (jev-seo).

Improvements to existing modules, from the same review (backlog, "Ideas from similar tools"):
- `gate`: the `authorized` mitigator from the task context; the write-then-run ledger.
- `steward`: the harm measure; staying inert outside interactive sessions.
- Base: the replay corpus with intervals; dead or noisy questions in `jev-health`; the doctor's hook check.

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
