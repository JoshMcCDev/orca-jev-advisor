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

The modules and what each one owns today, verified against the code in T1. The registry in `src/core/feature_modules.ts` is the source of truth.

| Module | settings.json hooks | Shared mod copy | Worker jobs | Existing modes (where stored) |
|---|---|---|---|---|
| `gate` | Bash: PreToolUse (`gate-bash.ts`); Bash: PostToolUse, PostToolUseFailure, PermissionDenied (`gate-outcome.ts`); Edit\|Write\|MultiEdit\|NotebookEdit: PreToolUse (`gate-files.mjs`) | none | 15 s: gate authorizations (own), measurements summary (shared with skill-selection). Activity summary (shared with model-router). Activation: deny-tier status, trusted programs, gate defaults. Poll: deny-tier, authorization-forget and trusted-program requests | 9 deny-tier switches (`<configDir>/deny-tier-config.json`), queue mode (`queue-mode.json`), trusted programs (`trusted-programs.json`). No measure mode, so no shadow |
| `model-router` | Agent: PreToolUse, PostToolUse, PostToolUseFailure (`agent-model.ts`) | router tier (`prompt.submit` origin stamp, `turn.step`); subagent routing (`agent.spawn`, teammate `turn.step`, `tool.call`); subagent status band (no Jev); turn-usage log on every step (no Jev) | 15 s: model measurements. 10 min (quota timer): account quota, router status (shared with steward), model docs check. Consumption summary (shared with steward). Activity summary (shared with gate). Activation: models catalog seed, mirror and notice. Poll: router config and models requests | `routerMode` off/measure/active, `workKindMode` off/measure/active (account settings.json `pluginConfigs["orca-jev-mod-skills@skills-dir"].options`); legacy model switch measurement/active (Orca storage `modelsConfig.active`, mirrored to `models-catalog.json`); explicit models judge/keep (`explicit-models.json`) |
| `steward` | none | context steward (`turn.start`, `turn.complete` timer) and its person-turn counter in `prompt.submit` | none of its own. Router status (its settings ride on each row) and consumption summary (its decisions) are shared with model-router. Poll: router config request (`steward-set`) | `stewardMode` off/measure/active, `stewardSoftMode` measure/active for the 400k tier (same `pluginConfigs` options) |
| `skill-selection` | none | skill selection (`prompt.submit`, `prompt.attachment`, `skill.prompt`); tool selection (`prompt.submit`, `tool.call`) | measurements summary (shared with gate). Activation: mod-skills status. Poll: mod-skills config request | `active`, `activeTools` (`<configDir>/mod-skills-config.json`); off means measurement |
| `board` | none | none | `agent.status.changed` (its 30 s `orca worktree list` / `orca repo list` cache runs inside this handler), `worktree.created` (no-op), `worktree.removed` | none, so no shadow |

Corrections to the T0 draft:
- **Board.** "Catalog refresh" was not a board job. Catalog refresh, catalog proposals and the catalog/policies mirror feed the gate and `advisor.decide`, so they stay in the base.
- **Skill-selection.** It does own worker work: the shared measurements summary, its status at activation, and its config request.
- **Steward.** No "compaction measurement" job exists. Its decisions reach the panel through the shared consumption summary, and its settings through the shared router status. T0 listed router status as model-router only.
- **Model-router.** The mod part is more than tier judgement. It also covers subagent routing, the subagent status band and the turn-usage log. The last two make no Jev call.
- **Base, not a module:** the poll loop and heartbeat; key mirror; Claude integration install and rescan; locale; catalog/policies mirror (which also mirrors `queue-mode.json` and `explicit-models.json`); the `advisor.*` commands. Orca's own plugin enable/disable switch (`src/core/orca_enablement.ts`) sits above every module.
- **Installer header.** It says "Seven hook entries", but `hookSpecs` installs eight (`gate-files.mjs` was added in 0.6.17). T3 fixes the comment.

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
- [x] T0 measure: per module, from the gate log, the mod logs and the last 7 days of transcripts: hook spawns per tool call and their latency, Jev calls per prompt and per turn, and worker wakeups per hour. The result is the baseline for the acceptance criteria. Commits 21d050a, then a follow-up commit (advice-retry and fail-open rules, `--until`).
  - **Tooling.** The script is `scripts/measure-module-cost.mjs`, run as `npm run measure-module-cost -- --since 2026-10-04T22:00:00Z --until 2026-10-11T05:00:00Z`. The counting rules live in `src/core/module_cost.ts`, with 15 unit tests.
  - **Strict TDD.** RED: the module was missing. GREEN: 14/14. The follow-up was RED on 2 of 15, then GREEN 15/15.
  - **Window.** 2026-10-04T22:00Z to 2026-10-11T05:00Z, 6.3 days. That is the last 7 days minus the hours of the stale 0.6.10 install, when the gate and mod logs were not written. The gate log shows plugin 0.6.25 to 0.6.28.
  - **Transcript totals** (deduplicated by uuid and tool-use id, subagents included):
    - 1217 person prompts on the main thread;
    - 1455 completed turns;
    - 25630 tool calls.
  - **Sources:**
    - the plugin cache dir: `gate-decisions-*`, `mod-skills-measurements-*`, `mod-tools-measurements-*`, `model-router-decisions-*`, `model-reclassifications-*` and `context-steward-decisions-*`;
    - the Claude transcripts;
    - the 5 settings.json files Claude Code reads (home and 4 Orca accounts), all with the same 8 hooks of ours;
    - Orca's plugin audit log, `plugins-data/audit.log*`.

  | Module | Hook spawns (derived) | per matching tool call | Hook ms p50 / p90 (observed) | Jev calls (observed) | per prompt | per turn | Jev ms p50 / p90 (observed) | Jev failures (observed) |
  |---|---|---|---|---|---|---|---|---|
  | gate | 40899 | 1.93 | 597 / 720 (n=11271) | 11342 | 9.32 | 7.80 | 383 / 441 (n=11298) | 49: 44 unreachable, 5 hook timeouts |
  | model-router | 160 | 2 | not recorded | 1378: router 1298 (start 731, stage 490, subagent 77) plus agent-model 80 | 1.13 | 0.95 | 383 / 444, agent-model only (n=80); the router logs none | 11 |
  | steward | 0 | - | - | 573 | 0.47 | 0.39 | not logged | 1 |
  | skill-selection | 0 | - | - | 8959: skills 3454, tools 5505 | 7.36 | 6.16 | 327 / 593 (n=6550) | 41 |
  | board | 0 | - | - | 0 | 0 | 0 | - | 0 |

  - **Hook spawns.**
    - Derived: the transcripts' tool calls times the matchers installed today. Pre counts every call, Post every success, PostFailure every error. PermissionDenied is not observable and counts 0.
    - These derived spawns read today's settings.json across the whole window, so once T3 uninstalls a hook they show 0 by construction. The independent proof for T6 is the observed count of our hook records (`orca-jev-advisor:` hook_success/hook_cancelled) in the transcripts: 11271 timed PreToolUse:Bash runs and 5 cancelled in this window.
  - **Hook latency.**
    - Observed only for the gate's PreToolUse:Bash, on the runs Claude Code recorded: the ones that printed something, 11271 of the Bash calls.
    - The other hooks print nothing, so no transcript times them.
    - The mod (model-router, steward and skill-selection) runs inside Claude Code and spawns no process.
  - **Jev calls.** One count per log row, using the rule that row's writer follows:
    - **gate:** a `jev` row is one call. An `advice-retry` row with no latency is none: `tryAdviceRetryPass` passes it before any Jev call, and there were 896 of them. A `none`/`unreachable` row is one failed call.
    - **skills:** the wide stage is one call, plus one for fit when it ran.
    - **tools:** one wide call per batch of 255 (the roster held 114 to 643 tools), plus fit.
    - **router:** a row with a confidence, or one marked `jev-failed`.
    - **agent-model:** a `jev` decision, or a `none` decision that failed after asking.
    - **steward:** one call per row.
  - **Worker cadences.** Derived from `adapters/orca/main.mjs`. Rates are observed in the audit log as `storage.set` with outcome `ok`, from 2026-10-10T01:49Z to 2026-10-11T04:59Z. That is 27.2 h, the whole log after rotation.
    - The worker never idled in that time.
    - The worker has 3 intervals plus the poll loop. Each interval runs jobs for several modules.
  - **The 15 s interval** runs 3 jobs:

    | Job | Module | Observed |
    |---|---|---|
    | measurements summary | shared by gate and skill-selection | 239.8/h |
    | model measurements | model-router | 233.5/h |
    | gate authorizations | gate | 235.8/h |

    Each run spawns one node sidecar; that part is derived from the code, and model measurements spawns on every call. This comes to about 709 node processes an hour (observed runs times derived spawns).
  - **The 10 min interval** runs 3 jobs:
    - account quota mirror: model-router. Derived only, since it has no audit key; it spawns 1 sidecar plus `orca account list`.
    - router status: model-router, 5.9/h.
    - model docs check: model-router, gated to once a day.
  - **Two more 10 min intervals**, one job each:
    - consumption summary: shared by model-router and steward, 6/h, 1 sidecar.
    - activity summary: shared by gate and model-router, 6/h, 1 sidecar.
  - **Board.**
    - The `agent.status.changed` handler wrote the board 160 times an hour.
    - Its 30 s `orca` CLI cache was refreshed 18.8 times an hour. Each refresh runs `orca worktree list` and `orca repo list`, so about 38 CLI spawns an hour (derived).
    - `worktree.created` is a no-op handler.
    - `worktree.removed` writes nothing the audit log shows.
  - **Base, not a module:** the request poll and heartbeat ran 234.7 times an hour.
  - **Jobs per module:**
    - gate: 1 own job and 2 shared;
    - model-router: 4 own and 2 shared;
    - steward: 1 shared;
    - skill-selection: 1 shared;
    - board: 3 event handlers.
  - **Finding for T4.** No module owns a timer: the 15 s and 10 min intervals are each shared by several modules. "0 worker timers for an off module" can only hold if T4 either gives each module its own timer, or measures an off module as 0 jobs and 0 sidecar spawns while the shared timer still wakes.
  - **Findings:**
    - **Agent spawns.** Every Agent spawn costs 2 Jev calls: one from the agent-model hook and one from the router's subagent point (80 and 77 for 80 Agent calls). It also costs 2 hook processes.
    - **gate-files.** It makes no Jev call, although its status message says Jev checks the edit.
    - **Mod switches.**
      - Both mod switches ran `active` all window: 1768 skills and 1766 tools decisions, with 0 measurement rows.
      - That is 5.07 Jev calls per decision.
      - So the "two Jev calls per prompt with both switches off" under Rules could not be observed on this machine.
    - **Person prompts.** The router's start and stage points decided 1221 times, about one per person prompt (1217), which supports that count. The skills mod decided 1768 times. Its `prompt.submit` skips only empty and slash prompts and does not check the prompt's origin the way the router does, so it also decides on prompts that are not a person's own, such as notifications.
- [x] T1 core registry: `src/core/feature_modules.ts`. It holds the module list (verified against the code), `parseFeatureModules(content)` (never throws; missing or malformed input gives today's behaviour), and `moduleState(id)` combining `off` with the existing mode. Strict TDD: RED, then GREEN.
  - **Registry.** `FEATURE_MODULES` gives, per module:
    - `id`, `states`, `defaultState`;
    - `hooks`: event, matcher and script;
    - `modFeatures`: id, engine hooks, and whether it calls Jev;
    - `workerJobs`: id, function, triggers (activation, poll, one of the 4 intervals, or an Orca event) and sidecar;
    - `modes`: each existing switch, its values, default, store and `shadowValue`.

    The file is `FEATURE_MODULES_FILE = "feature-modules.json"` in the config dir, shaped `{ "modules": { "<id>": "off" | "shadow" | "active" } }`. The module is pure: no `node:` import, so the mod sandbox can load it.
  - **Defaults.** Every module defaults to `active`, which reproduces 0.6.28. The gate and the board offer only `off`/`active`: they have no measure mode, and a module offers shadow only when one of its modes has a measure value (a test asserts this).
  - **API.**
    - `parseFeatureModules` falls back per field: malformed input, unknown ids, wrong types and unsupported states.
    - `moduleState`.
    - `effectiveMode(state, own)`: `off` always gives off; `shadow` caps `active` at `measure` and never turns on an own `off`; `active` gives the own mode.
    - `switchMode(boolean)` maps the skills, tools and legacy model booleans to measure/active.
    - `hooksFor`, `modFeaturesOn`, `workerJobsOn` (a shared job is listed once, and runs while any owner is on), `modCopyNeeded`.
  - **Hook ownership.** The installer exports no list of its hooks, so the test holds a fixed list of the 8 that mirrors its header. It also parses the `hookSpecs` rows out of `install-claude-integration.mjs`'s source and checks them against that list, so a new hook with no owner fails.
  - **Strict TDD.** RED: `src/core/feature_modules.test.ts` failed with `ERR_MODULE_NOT_FOUND` (the module was missing). GREEN: 23/23. `npm run typecheck` reports 0 errors, and `npm test` passes 3607/3607.
  - **Findings for later tasks:**
    - **T2.** Add `FEATURE_MODULES_FILE` to `GATE_OWN_CONFIG_FILES` (`src/core/gate_own_paths.ts`). With the gate off, `gate-files` is uninstalled and nothing guards the file. That is acceptable, because the gate can only be turned off from the panel while it is on.
    - **T3.** `install()`, `uninstall()` and `status()` address `hookSpecs` by position (`specs[0..7]`, see its comments). Filtering it through `hooksFor` must not shift those indices. Match by event, matcher and script instead.
    - **T4, turn-usage and subagent band.** The turn-usage log and the subagent status band make no Jev call but belong to `model-router`. With the router off, the Consumption tab's usage, the turn-usage half of Activity and the subagent band stop. The alternative is a base mod feature, but that keeps the mod copy installed with every mod module off, so the router owns them.
    - **T4, other jobs.** The steward's person-turn counter runs in `prompt.submit` on every prompt. Activation jobs and poll request handlers also spawn sidecars, so "0 jobs" must cover them too. They are in the registry.
    - **T5.** The router's and steward's own `off` overlap with module `off`, though they never disagree, since off wins either way. The panel should hide the own `off` while the module switch is shown. The gate and the board show only off/on.
- [ ] T2 gate protection: the module state file joins the gate's own-files refusal (`adapters/claude/gate-files.ts`, and the Bash gate's own-file rules). Subprocess tests for Edit, Write, heredoc, `sed -i`, `cp`, `mv` and `rm`.
- [ ] T3 installer: `install-claude-integration.mjs` installs only the hooks of the modules that are on, and uninstalls the hooks of the modules that are off. It stays idempotent and goes through the 0.6.26 never-go-back-a-version guard. The mod copy stays while any mod module is on. Verify whether a change to the mod copy needs a Claude Code reload; 0.6.24 showed that settings.json hooks do not. Write the answer here.
- [ ] T4 mod and worker: each mod feature returns before any Jev call when its module is off. For the worker, the acceptance measure is 0 jobs and 0 sidecar spawns for an off module, per T0's finding that the 15 s and 10 min timers are shared; a timer is removed only when every module using it is off. Tests: zero Jev calls, zero jobs and zero sidecar spawns for an off module.
- [ ] T4b worker cadence (T0: the worker never rested in 27.2 h; the 15 s refresh spawns 3 node sidecars per tick, about 709 processes an hour, observed ticks times sidecars from the code). The measurement refreshes run only while a panel that shows them is open, plus once at activation, so Orca's 5-minute idle reap can stop the worker. Measure before and after with the T0 script and Orca's plugin audit log.
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
