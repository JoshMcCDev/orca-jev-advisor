# Report Jev's state to Orca from member panes (JEVADV-106)

## Objective
In an Orca Agent Teams project only the lead pane loads orca-game, so the lead's
Panel never sees what a member's Jev decided. Orca already accepts a report from
any pane: `game state --json` with env `ORCA_GAME_ADVISOR=<json>` (contract v1:
`{version:1, model, effort, pinned:{model,effort}}`, JSON `null` = Jev stopped).
Jev reports there from a pane that is not a game pane. Request from orca-oss.

## Scope
- Only when `ORCA_TERMINAL_HANDLE` is set and the pane is not in game mode
  (`parseOrcaGameMode` is null). A game pane keeps publishing `advisor` as today.
- Executable: an absolute path from `ORCA_GAME_CLI`, else an absolute
  `ORCA_CLI_COMMAND`; neither set, or not absolute: do nothing. Never a bare `orca`.
- Run `<exe> game state --json` with env `ORCA_GAME_ADVISOR=<json>`, short
  timeout, fire-and-forget (`void`), never awaited by a turn.
- Report whenever the drawn state changes (status line and router choice), at
  session start, and `null` at session end. An unchanged value is not sent (same
  last-value dedupe `publishAdvisor` uses); a failed run is retried on the next change.
- v1 keys keep their meaning; v2 keys are extra: `line`, `skill`, `tool`,
  `routedModel`, `sessionModel`.

## Tasks
- [ ] R1 pure `src/core/orca_report.ts`: `orcaReportExecutable`, `orcaReportPins`, `buildOrcaReport`. RED first.
- [ ] R2 hooks: report from non-game panes, null at session end, guarded no-op. RED first.
- [ ] R3 CHANGELOG, version, preflight, live check, QA doc.

## Not done (said plainly)
- `hold` (the "se mantiene" text) and `confidence`: the router computes them
  deep inside the step and only hands the status line up; plumbing them is a
  separate change. Orca accepts v2 keys additively, so they can follow.

## Acceptance criteria
- Not in Orca (no `ORCA_TERMINAL_HANDLE`), in a game pane, or with no absolute
  CLI path: no process is run.
- Report carries v1 exactly plus the v2 extras; pins read `ORCA_AGENT_*_PINNED === "1"`.
- A change runs the CLI once with the env; an unchanged state does not; session end sends `null`.
- A hung or failing CLI never delays a turn and never throws.

## Checks
`npm run preflight`; live check with a hand-set `ORCA_GAME_CLI` in this pane.

## Out of scope
Release, marketplace catalog (owner's OK), Orca's own export of `ORCA_GAME_CLI` (ORCA-657).
