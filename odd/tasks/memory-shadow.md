# Memory module in Shadow (track M-shadow: M8, M14, M15)

Branch `feat/memory-shadow`, from `feat/memory-core` rebased on `main` (665bc7f). Design: sections 5.1 to 5.8 of the mods review; engine facts: `odd/research/engine-probes-2.1.296.md` (a to d); pure logic: `odd/tasks/memory-core.md`.

## Objective

Ship the memory module in **Shadow**: in a real session it detects the backend, decides at turn end with Haiku, drafts on a sample of UPDATE turns, builds the judge dry, observes what the main thread really saved, and logs one row per decision. It **writes nothing**: no `mem_save`, no `mem_judge`, no file in the auto-memory folder, no spool. The card in Modules shows what it measured. Active (M9 to M13) is a later track.

## Scope

In:
- M8 mod wiring in `adapters/claude/mod-skills/hooks/index.ts`, with the pure parts (row, sampling, observation, agreement, summary) in `src/core/memory_shadow.ts`.
- The judge rule the owner asked for: feedback that supersedes feedback with confidence at or above 0.7 is recorded, not sent to the person.
- The registry offers `off` and `shadow` only, until Active is wired.
- M14 card (es/en) in Modules, fed by the existing `measurementsSummary` (read-measurements.mjs), which memory now co-owns.
- M15 memory section of `measure-module-cost`.

Out: any write (Engram or files), the `tool.call` intercept, the prompt section, tidy, band and pane, README, CHANGELOG, version, package-lock.json, push and PR.

## Fixed facts the code relies on

- **Fork sampling: 1 in 5** (`FORK_SAMPLE_EVERY = 5`). A turn is in the sample when an FNV-1a hash of `<sessionId>:<turnId>` is divisible by 5. A constant in code, stated on the card as a fact, never a setting.
- **Engram type mapping**, checked in Engram 2.1.0's own source (`~/.claude/plugins/marketplaces/engram`, read only):
  - `mem_save` stores `type` as given; no allowlist (`internal/mcp/mcp.go` handleSave, `internal/store/store.go` AddObservation). The cloud sync only requires it non-empty (`cloudserver.go:912`).
  - `policy` is a first-class type: it has its own review decay (`store.go:375`, 12 months) and is in the judge's protected set (`mcp.go:383`).
  - So feedback stays `policy`, user `learning`, project and reference `discovery`.
- **The judge rule.** Engram's rule leaves `supersedes` on a `policy` to the person. The owner wants fewer questions, so a `supersedes` between two `policy` observations with confidence at or above 0.7 is recorded. `conflicts_with` on a policy, and anything on architecture or decision, still goes to the person.
- **The one Engram call in Shadow** is `mem_current_project`, read only, as the health check. It is raced against a 3 s clock. A refusal is `permission`, never down.
- **Detection timing.** The probes read `$.tool.list()` at turn end, not at session start, and MCP servers can connect late. So `session.start` detects, and the first gated turn re-detects once when start saw no Engram tools. Each row says which point decided (`start` or `turn`).
- **Dry judge.** In Shadow the module has no Engram candidates of its own. The only real ones are in the main thread's own `mem_save` answer, seen after `next` in `tool.call`. A judge build pairs each drafted save with each candidate seen in the same turn. It builds the prompt and asks nothing: no Haiku call, no `mem_judge`. With no candidate seen, there are 0 builds.
- **What Haiku and the fork see.**
  - Haiku sees `MEMORY.md` (at most 8,000 characters) and the last exchange: typed prompt to the end, at most 12,000 characters, secrets redacted, tool names only.
  - The fork is the session's own transcript plus the writer prompt. It also sees the auto-memory topic keys when Engram is live, or the memory files when it is not (at most 40 files and 40,000 characters).
  - Both count against the Max plan quota.
- **The row** (`memory-decisions-<hour>.jsonl` in the cache dir) holds no memory content: no titles, no gate reason, no draft text. It holds:
  - counts, types, the backend and its signal, the outcome of each step;
  - latencies and token usage;
  - what the main thread saved, by Engram type.

## Checklist

Strict TDD: a test written and observed failing, then green, then refactor and one Conventional Commit. A box is ticked only with observed proof.

- [x] T0 Task file (this file).
- [x] T1 Judge: `policy` superseding `policy` at 0.7 or above is recorded (`memory_judge.ts`).
- [x] T2 Registry: memory offers `off` and `shadow`; `active` returns with M9.
- [x] M8a `src/core/memory_shadow.ts`:
  - the row and its file name;
  - fork sampling;
  - classifying a main-thread call (`mem_save`, `mem_judge`, a Write or Edit into the memory dir);
  - agreement;
  - the weekly summary.
- [x] M8b Mod wiring:
  - `session.start` detect;
  - turn-end timer: free checks, Haiku gate, sampled fork, dry judge, one row;
  - `tool.call` observe after `next`;
  - `$.state` key declared.

  Tests in `hooks.test.ts`:
  - Off: 0 Haiku calls and 0 rows.
  - Shadow:
    - rows are written;
    - no `mem_save`, no `mem_judge`, no write into the memory or spool dirs;
    - the only MCP call is `mem_current_project`.
  - A subagent turn, a non-answer turn, a slash command or our own marker does nothing.
  - `next(e)` comes back unchanged.
- [x] M14 Card:
  - offers Off and Shadow;
  - shows the backend and its signal, the sampling fact, what Haiku and the fork see, the quota note and the weekly counts;
  - is fed by read-measurements.mjs, with memory co-owning `measurements-summary`;
  - `memory` leaves `UNCARDED`, and the `uncardedModuleStates` passthrough goes;
  - `panels.spec.mjs` covers the card;
  - screenshots taken.
- [x] M15 `measure-module-cost` memory section. From the transcripts:
  - main-thread Engram calls, by tool;
  - Engram-only responses, grouped by `message.id`.

  From the log:
  - Haiku gates and forks;
  - judge builds;
  - tokens, per prompt.

## Acceptance criteria

- In Shadow, a whole turn makes at most:
  - one `$.mcp.call`, to `mem_current_project`, once per session;
  - one Haiku call;
  - one fork, on a sampled UPDATE.
- In Shadow, a whole turn writes:
  - only rows into `memory-decisions-*.jsonl`;
  - only the `memory` `$.state` key.
- Off makes no call and no row, and schedules nothing.
- Every hook returns `next(e)`'s result unchanged; any failure is swallowed.
- Every control on the card goes through the real `feature-modules-save` writer.

## Checks

`npm run typecheck`, `npm test`, `npm run test:panels`, and screenshots of the Memory card:
- 1440 light;
- 390 light;
- 390 dark, only if colours are added.

## Live check (later, on the marketplace install)

- Whether `$.tool.list()` at `session.start` already lists Engram, read from the rows' `detectedAt`.
- Whether `mem_current_project` prompts the person in an interactive session.
- Rows appear and the memory dir gets zero writes.
- The fork's `cache_read` is high, so the fork reuses the warm cache.
- The card's counts match the log.

## Outcome

- The Memory card was photographed with the ready fixture:
  - English at 1440 and 390, light;
  - Spanish at 390, light.

  No colour was added, so there is no dark shot. The images are kept out of the repository.
- The memory dir and the spool get no writes in any Shadow test. `mem_current_project` is the only MCP call.
- `measure-module-cost` on the owner's logs, 2026-10-05 to 2026-10-12, `~/.claude/projects` only:
  - 866 main-thread Engram calls: `mem_judge` 543, `mem_save` 211.
  - 495 responses held an Engram call, and 412 held only Engram calls:
    - 182 with a save;
    - 178 with judges and no save.
  - 0 module rows yet.

## Hand-off to Active (M9 to M13)

- Put `active` back in the registry and on the card (`feature_modules.ts`, `config.html` MODULE_ROWS), with the panels.spec cases. Write the hidden-state test the other way round.
- Shadow never calls Engram beyond `mem_current_project`. When Engram is live, the gate's index and the draft's topics come from `MEMORY.md` and the auto-memory frontmatter. Active can read the Engram topic list instead.
- The dry judge pairs a draft with the main thread's own `mem_save` candidates, title only. Active judges real candidates:
  - from its own `mem_save`;
  - with `mem_get_observation` for the text;
  - Haiku per candidate (memory_judge.ts);
  - `decideVerdict`, including the owner's supersedes rule.

  The spool still does not persist `candidates[]` (memory-core hand-off).
- The fork is sampled 1 in 5 in Shadow only. Active drafts every UPDATE, and the card's cost line must change with it.
- `observeMemoryCall` already classifies the main thread's `mem_save`, `mem_judge` and memory-dir writes. M11's intercept is the same match, answered with a string instead of `next`.
- The backend state (`$.state` `memory`) carries the health outcome, so a re-check does not repeat the call. M9 re-detects after a failed write.
- `engram version` is never run, so `binary` never decides in the mod. Add it only if a person with only the binary needs telling apart.
