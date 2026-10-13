# QA 0.8.2: memory and CI watcher in Shadow, steward pre-cold, typing lead time, broad-add secret check

Run on 2026-10-12 against `release/0.8.2`, from `main` at 9ad5282 (0.8.1 and its live QA). Plans: `odd/tasks/memory-core.md`, `odd/tasks/memory-shadow.md`, `odd/tasks/ci-watcher.md`, `odd/tasks/steward-pre-cold.md`, `odd/tasks/typing-lead-time.md`, `odd/tasks/gate-secret-guard.md` (G7).

## Summary

| Check | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm test` | 4246/4246 |
| `npm run test:panels` | 239/239 |
| Shots: Modules section with the CI watcher and Memory cards, 1440 and 390, light | 2, read (scenario 9) |
| Live marketplace install | Pending |

Each track was built test-first in its own worktree; the RED and GREEN of every task are in its task file. The tracks were then cherry-picked onto this branch commit by commit and the full suite re-run after each integration (K0 + S + G7: 3950/3950; + C: 4031/4031 and 235/235 panels; + memory: the totals above).

## Scenarios

| # | Scenario | Command or evidence | Expected | Observed | Result |
|---|---|---|---|---|---|
| 1 | Memory core: detection, gate, draft, spool, judge, tidy | `src/core/memory_*.test.ts` (memory-core M1–M6) | Each rule as specified; malformed answers are failures; no path escapes; double replay writes once | RED: each module missing; GREEN 31, 29, 27, 33, 19, 36 | PASS |
| 2 | Memory registry: Off and Shadow only, default Shadow | `feature_modules.test.ts` (cf49276) | A stored `active` reads as Shadow | RED 1; GREEN | PASS |
| 3 | Memory in the mod: Off makes no Haiku call and writes no row; Shadow writes rows and nothing else | `hooks.test.ts` M8 tests (74e3893) | 0 `mem_save`, 0 `mem_judge`, 0 memory-file writes in Shadow; subagent and non-answer turns do nothing; `next(e)` unchanged | RED 11 (the 2 Off tests passed trivially); GREEN 188/188 | PASS |
| 4 | A confident feedback supersede is recorded, not sent to the person | `memory_judge.test.ts` (77304de) | ≥0.7 recorded; feedback conflicts and decision/architecture still pending | RED 1; GREEN 20/20 | PASS |
| 5 | CI watcher: parse, trigger, poll, count, notify | `ci_watch.test.ts`, `hooks.test.ts` C2–C5 | One watch per repo and sha, at most 45 `gh` calls; Shadow sends nothing; Active one note when idle, no Jev call | RED per task (C1 module missing; C2 3; C3 11; C4 2; C5 5); GREEN | PASS |
| 6 | The CI note is not a scored prompt (C with K0) | `hooks.test.ts` "C5 ci-watch with K0b" | No typing row for the plugin's own note | RED without the fix; GREEN | PASS |
| 7 | Steward pre-cold: never races the engine; TTL from the router | `steward_pre_cold.test.ts`, `steward.test.ts` | Engine zone rules; skip at 0.97 TTL, cooldown, mid-task, headless, non-1h TTL; slot at 0.85 of the TTL read by the router | RED per task; the TTL test RED (armed at 51 min with a 5 min TTL), GREEN after 03b9a4b; steward 45/45 | PASS |
| 8 | Typing lead time | `typing_lead_time.test.ts`, `hooks.test.ts` K0b, `read-consumption.test.mjs`, `panels.spec.mjs` | Off 0 rows; composer prompt one row with gap and edits; injected counted apart; no line without data | RED per task; GREEN | PASS |
| 9 | Modules section shots | `scripts/screenshot-panels.mjs --scenario ready`, 1440 and 390 light | Eight cards, CI watcher Off/Shadow/Active, Memory Off/Shadow, no overflow | Read both: eight cards in order; CI watcher Shadow pressed with its 45-call ceiling and week line; Memory Shadow pressed, "Active … is not offered yet", the quota line, what Haiku and the fork see, the backend line; at 390 stacked with nothing cut off. The week figures are fixture values | PASS |
| 10 | G7: a broad add that would stage a secret asks | `secret_publish.test.ts`, `gate-bash.test.mjs` G7 | `-A`, `--all`, `.`, a folder, `-u` ask with a secret; a gitignored `.env` or templates only stay allowed | RED 4 unit and 2 e2e; GREEN 16/16 and 23/23 | PASS |
| 11 | One version everywhere | `scripts/release-docs.test.mjs` | 0.8.2 in package.json, orca-plugin.json, CHANGELOG, README | 2/2 | PASS |
| 12 | Live: marketplace install at 0.8.2 | lock, `current`, hooks | Same 0.8.2 root everywhere | Pending the release | PENDING |
| 13 | Live: `git add -A && git commit` with an untracked `.env` asks | the installed gate, throwaway repo | ask, `secret-publish` | Pending on 12 | PENDING |
| 14 | Live: memory rows in Shadow, zero writes | `memory-decisions-*.jsonl`, the memory folder, Engram untouched | Rows with backend `live`; no file written | Pending on 12 | PENDING |
| 15 | Live: CI watcher in Shadow after a real push | `ci-watch-decisions-*.jsonl`, band row | One watch row with polls and sleeps counted | Pending on 12 | PENDING |
| 16 | Live: typing rows from the composer | `typing-*.jsonl` | Rows with `gapMs` and `edits` | Pending on 12 | PENDING |
| 17 | Live: steward pre-cold in Measure | `context-steward-decisions-*.jsonl` | A `wouldFire` row after about 51 minutes idle on a large session | Pending on 12; needs an idle session | PENDING |
