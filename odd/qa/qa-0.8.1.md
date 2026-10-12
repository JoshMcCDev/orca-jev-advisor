# QA 0.8.1: the gate's secret guard and the router's cold switch

Run on 2026-10-12 against `release/0.8.1`, from `main` at 665bc7f (0.8.0 plus the 2.1.296 engine types, #53). Plans: `odd/tasks/gate-secret-guard.md` (track G) and `odd/tasks/router-cold-switch.md` (track R). The live items of 0.8.0 (14 to 18 of `qa-0.8.0.md`) are run on this install too.

## Why

- **G.** Until 0.8.1, `git add -f .env`, `git add .env && git commit` and a push of a commit carrying `.env` ran with no question: the own-tree layer of 0.6.28 counted them as local work. A secret that reaches a remote cannot be taken back.
- **R.** A model or effort switch rewrites the prompt cache, so break-even held 40 switches a week. After an idle gap longer than the cache's TTL the cache is cold anyway and the rewrite costs nothing extra.

## Summary

| Check | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm test` | 3868/3868 |
| `npm run test:panels` | 223/223 |
| Shots of the router card, 1440 and 390, light | 2, read (scenario 12) |
| Live marketplace install | Pending |

## Scenarios

| # | Scenario | Command or evidence | Expected | Observed | Result |
|---|---|---|---|---|---|
| 1 | The three secret shapes are pinned end to end | `gate-bash.test.mjs` G0 tests (c24ef62) | Each asks | RED: `git add -f .env` and `git add .env && git commit` were `own-tree`, the push `local-allow`, an authorized `push-branch` `authorized`, a stored allow `cache`; committed as `todo`, GREEN from G1 to G4 | PASS |
| 2 | Secret paths | `src/core/secret_paths.test.ts` (G1, b66413b) | `.env`, `.env.*`, keys, `credentials*.json`, `.netrc`, `.git-credentials` are secrets; `.npmrc`/`.pypirc` only with a literal credential; `.env.example`, `.sample`, `.template` and `*.pub` are not | RED: module missing; GREEN | PASS |
| 3 | `git add` of a secret asks | G1 (b66413b) | `add -f` or a secret pathspec is not own-tree | RED: `own-tree`; GREEN: ask | PASS |
| 4 | A commit with a staged secret asks | G2 (5d62102) | Staged names read; `-a` with a modified tracked secret and pathspecs covered | RED 3 unit, 2 e2e (`own-tree`); GREEN | PASS |
| 5 | A push carrying a secret asks | G3 (43a65e7) | Outgoing range from `--not --remotes=<remote>`; a new branch starts at what the remote has; a file added then deleted in the range is caught | RED 5 unit, 2 e2e (`local-allow`); GREEN. 7 existing own-branch push tests from a non-repo folder broke on the first attempt and pass now (no repo, or an unknown origin, sends nothing) | PASS |
| 6 | Protected: `git add -A && git commit` with no secret | `own_tree_effect.test.ts`, `push_own_branch.test.ts` | Still allowed | GREEN | PASS |
| 7 | Precedence | G4 (dae5fe7) | Before remembered authorizations, cache and Jev; never cached or remembered; only a policy `prohibits` or a local deny outranks it | RED: a cached policy deny came out `ask`; GREEN `deny` | PASS |
| 8 | A switched-off local rule cannot be bypassed by a retry | 0783874 | Asks both times | RED: advice, then allow on retry; GREEN | PASS |
| 9 | The decision log keeps the new rows | fa1ef56 | `secret-publish` in `GateStopReason` and its reader | RED: rows dropped; GREEN | PASS |
| 10 | A large push | 5b5afd7 | git lists only candidate names | RED: the first push of a 13,000-file tree passed without asking; GREEN | PASS |
| 11 | G6: a scratchpad path is shown to Jev as temporary | `src/core/gate_scratchpad_write.test.ts` (2d669a6) | The row `bd21309a` (18:53:59Z, `python3`, deny `never_write_to_main`) reproduced; the path reaches Jev as `$TMPDIR/<path-N>` | GREEN. Not verified: that a real Jev call now answers "does not apply" | PASS (unit) |
| 12 | Router: cache warmth from the transcript tail | `src/core/cache_warmth.test.ts` (R0, 28da13c) | 1h/5m bucket and time from the newest main-thread row; subagent rows skipped; unknown is warm | RED: module missing; GREEN 10/10 | PASS |
| 13 | Router: a cold cache makes the switch free | `model_router_stage.test.ts`, `model_router_decide.test.ts` (R1, 678933b) | Break-even cost 0 when cold, unchanged when warm or unknown | RED 5; GREEN 134/134 | PASS |
| 14 | Router: wiring, measure and active | `hooks.test.ts` (R2, 89a23cb) | `classic.Stop` reads the tail only while the router is on and never fails the Stop; main steps stamp the clock, subagents do not; `wouldApplyCold` / `appliedCold` | RED 6; GREEN; the module-load test fires `classic.Stop` on the real mod | PASS |
| 15 | Router card line | `read-consumption.test.mjs`, `panels.spec.mjs` (R3, 25fcf75) | "Switches after a cold cache: N (7 days)" es/en; no line without the count | RED 4 unit and 1 panel; GREEN. Shots `router-card-cold-switches-1440.png` and `-390.png` read: the line sits between "Applied 5 · not applied 4" and the saving line, no overlap or overflow at 390 ("Deep reasoning" was already cut at 390 before) | PASS |
| 16 | One version everywhere | `scripts/release-docs.test.mjs` | package.json, orca-plugin.json, CHANGELOG and README at 0.8.1 | 2/2 after the bump (no RED run observed for this release; the guard has its own RED in 0.8.0) | PASS |
| 17 | Live: marketplace install at 0.8.1 | `plugins.lock.json`, `current`, hooks, mod markers | Everything names the same 0.8.1 root | Pending the release | PENDING |
| 18 | Live: `git add -f .env` asks, naming the file | the installed gate on a throwaway repo | ask, `secret-publish` row | Pending on 17 | PENDING |
| 19 | Live: commit and push of a secret ask; `.env.example` and a clean `add -A && commit` do not | the installed gate, throwaway repo with a local bare remote (no network) | ask, ask, allow, allow | Pending on 17 | PENDING |
| 20 | Live: the router reads the cache clock | a main turn ends; `routerCache` in the mod state or a stage row with `cacheWarm` | `ttlMs` 1h, `cacheWarm` true or false | Pending on 17 | PENDING |
| 21 | Live: 0.8.0 items 14 to 18 | `qa-0.8.0.md` | Verify done card in Shadow; a candidate turn writes one row; a verified turn none; Off none | Pending on 17 | PENDING |

## Not covered

- Publishing paths other than `git push`, such as `gh repo create --source=. --push`.
- If git fails or times out, the secret check steps aside and the normal gate path decides; without an API key that path allows.
- The steward or verify-done fork that runs after a turn can also refresh the main cache; the router ignores it and may read a warm cache as cold. Those forks run within seconds of the turn ending.
