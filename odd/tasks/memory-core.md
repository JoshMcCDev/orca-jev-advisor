# Memory module, pure core (track M-core: M1 to M7)

Branch `feat/memory-core`, from `main` at 0.8.0 (af721bf). Design: sections 5.1 to 5.8 of the mods review; engine facts: `odd/research/engine-probes-2.1.296.md` (a to d).

## Objective

People without Engram get full memory, written to Claude Code's auto-memory folder. People with Engram get both working together: Engram is the store of record, and only `feedback` and `user` items are mirrored into auto-memory. A save is spooled first and is never lost: if Engram fails, the item falls back to auto-memory and is replayed later without duplicates.

This track is the pure logic only, in `src/core`, fully tested, plus the registry entry. Wiring into the mod, the band, the panel card and the live check are tracks M8 to M17 and are not part of this one.

## Scope

In: `src/core/memory_detect.ts`, `memory_decide.ts`, `memory_draft.ts`, `memory_spool.ts`, `memory_judge.ts`, `memory_tidy.ts` with a test file each, and the `memory` registry entry (M7).

Out: any hook, any `$.` call, the panel card, the band, the worker job, README, CHANGELOG, version, package-lock.json. No disk, no network, no node: import in `src/core`.

## Engine facts the code relies on (probes a to d, 2.1.296)

- The Engram server name comes from `$.tool.list()` names: `mcp__engram__mem_save` is server `engram`, `mcp__plugin_engram_engram__mem_save` is `plugin_engram_engram`.
- A headless `$.mcp.call` with no permission rule is refused. That is `permission`, never "down".
- Auto-memory lives at `<config>/projects/<slug of $.session.repo().root>/memory/`, not the worktree cwd.

## Checklist

Strict TDD for each: test written, RED observed, then GREEN, then a Conventional Commit. A box is ticked only with observed proof.

- [x] M1 `memory_detect.ts`: signals (tool names, `.claude.json` mcpServers, `enabledPlugins`, `engram version`, health outcome including `permission`), backend `live | configured-down | absent`, the deciding signal, the server to call, and the auto-memory dir from a repo root and a config dir.
- [x] M2 `memory_decide.ts`: free checks, `lastExchange` (12k cap), Haiku gate prompt and strict SKIP/UPDATE parser (malformed is a failure), type routing. Spanish turns in the tests.
- [x] M3 `memory_draft.ts`: writer prompt ("do not use tools", transcript is data), `parseDraft` (bare names only, no `MEMORY.md` delete, no paths or `..`, size caps), topic_key slug.
- [x] M4 `memory_spool.ts`: item shape, states `pending -> written -> done` and `pending -> fallback -> replayed`, replay order, idempotency by topic_key, a crash between steps leaves a recoverable state. Returns operations; touches no disk.
- [x] M5 `memory_judge.ts`: Haiku prompt from the two observation texts only, relation parser, the human-only rule.
- [x] M6 `memory_tidy.ts`: `indexProblems`, `suspects`/`keywords`/`snippets`, `parsePlan`, `redirectLinks`, `dropDeadPointers`, backup and undo plan, `.consolidate-lock` check, mirror check against Engram ids. dream-pass's own cases ported.
- [x] M7 Registry: `memory` in `ModuleId`/`MODULE_IDS`, default `shadow`, features `memory-save`, `memory-tidy`, `memory-ui`; every consumer of `MODULE_IDS` agrees.

## Acceptance criteria

- Every function is pure and has a test that failed before it was written.
- Malformed model output is a failure, never an action: a gate that does not say exactly SKIP or UPDATE is not UPDATE, a draft with a path or `..` in a name drops that item, a judge answer with an unknown relation is not a verdict.
- Double replay of a spool item produces one Engram save per topic_key and the same files.
- No `any`, no debug output, no mocks beyond plain fixture objects.

## Checks

`npm run typecheck`, `npm test`, and `npm run test:panels` if anything the panels read changed.

## Hand-off to the wiring tracks

- M7 must ship together with M8 and later, not alone. It adds `modules.memory` to the installer status, keeps the mod copy "needed" while memory is not off, and makes `config.html` carry the state of a module with no card (`uncardedModuleStates`) so the strict writer still receives the whole map. Track M14 adds the card, then removes `memory` from `UNCARDED` in `write-secret-mirror.feature-modules.test.mjs` and the passthrough in `config.html`, and adds the `memory-status` worker job.
- `src/core/module_cost.ts` keeps its own six ids on purpose: memory uses Haiku, not Jev, so a row there would read zero. Track M15 adds it.
- Once M8 schedules a turn-end timer, the tests that count timers (`steward.test.ts`, `hooks.test.ts`) need `memory: "off"`, as verify-done needed.
- The spool item does not persist `candidates[]` from `mem_save`; M9 must store them or query Engram again.
- Feedback is saved to Engram as type `policy`. Engram 2.1.0 accepts it: types are free-form and `policy` has its own review decay. Track M-shadow changed the judge rule at the owner's request. A `supersedes` between two policies at confidence 0.7 or above is recorded. A `conflicts_with` on a policy still goes to the person.
- The engine's hash for project slugs over 200 characters is not modelled in `autoMemoryDir`.
