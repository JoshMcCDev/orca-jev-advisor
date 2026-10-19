# QA JEVADV-106: Jev reports to Orca from member panes (unreleased)

Date: 2026-10-19. Branch `feat/jevadv-106-orca-report`.

## Scenarios

| # | Scenario | Level | Result |
|---|----------|-------|--------|
| 1 | Member pane (`ORCA_TERMINAL_HANDLE` + absolute `ORCA_GAME_CLI`): CLI run with `game state --json`, v1 report plus `line`/`sessionModel`, timeout <= 3 s | unit (hooks.test.ts) | pass |
| 2 | Unchanged state, a start that changes nothing: nothing sent | unit | pass |
| 3 | Pins ride in `pinned` only when exactly `1` | unit | pass |
| 4 | `ORCA_CLI_COMMAND` fallback | unit | pass |
| 5 | No handle, no executable, bare `orca`, game pane: no process run | unit | pass |
| 6 | Session end sends JSON `null` once | unit | pass |
| 7 | CLI that cannot start never fails a hook | unit | pass |
| 8 | Real shell in an Orca pane (this worker): neither `ORCA_GAME_CLI` nor `ORCA_CLI_COMMAND` exported, so `orcaReportExecutable` is `null` and the hook would do nothing | live | observed: guarded no-op |
| 9 | Real Orca CLI (`/Applications/Orca.app/.../bin/orca game state --json`) with `ORCA_GAME_ADVISOR` set to the report `buildOrcaReport` builds, then `null`, for this worker's own terminal only | live (CLI call path) | both calls answered `ok: true` |
| 10 | v2 extras: `confidence` is the router decision's confidence (0 is still sent); `hold` is the reason code when the model is kept and absent when it changed; both come from `routerSticky` | unit (orca_report.test.ts, hooks.test.ts) | pass |

## Not verified
- The hooks module was not run inside a real Claude session with `ORCA_GAME_CLI` exported: Orca does not export it to member panes yet (ORCA-657). Scenario 9 drives the real CLI with the real report builder by hand, not through the hook.
- That Orca stored the report and the lead's Panel shows it was not read back or looked at.
- `hold` is the router's reason code, not the translated "se mantiene" text.
- No UI changed; `npm run shots` (4 panel screenshots, no overflow) only confirms the config panels are untouched.
