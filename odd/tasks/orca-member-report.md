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
  `routedModel`, `sessionModel`, `confidence`, `hold`.

## Tasks
- [x] R1 pure `src/core/orca_report.ts`: `orcaReportExecutable`, `orcaReportPins`, `buildOrcaReport`. RED first.
- [x] R2 hooks: report from non-game panes, null at session end, guarded no-op. RED first.
- [x] R3 CHANGELOG (Unreleased, no version bump: release needs the owner), preflight, live check, QA doc.

## Not done (said plainly)
- The account is not reported, on the lead's decision: Orca already knows each
  member's account from its launch pin, so the report would duplicate identity.
- Confidence and hold are in: the router keeps them in `routerSticky` on each
  decision (`confidence`, and `hold` = the reason when the model stayed).

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

## Release note draft

Not in CHANGELOG.md yet: `scripts/release-docs.test.mjs` requires the newest CHANGELOG entry to be the package version, so the entry is written at release time. Draft:

- **A member pane tells Orca what Jev decided** (JEVADV-106, odd/tasks/orca-member-report.md, `src/core/orca_report.ts`, `adapters/claude/mod-skills/hooks/index.ts`).
  - **What changed.** In a pane Orca runs (`ORCA_TERMINAL_HANDLE` set) that its game does not draw, Jev runs the Orca CLI's `game state --json` with `ORCA_GAME_ADVISOR=<report>` whenever what it draws changes, at session start, and with `null` at session end. The lead's Agent Teams Panel can then show a member's Jev.
  - **Report.** Contract v1 (`version`, `model`, `effort`, `pinned`) as Orca reads it today, plus extra keys that never change a v1 key: `line`, `skill`, `tool`, `routedModel`, `sessionModel`, `confidence`, `hold`. `pinned` reads `ORCA_AGENT_MODEL_PINNED` / `ORCA_AGENT_EFFORT_PINNED` equal to `1`.
  - **Guarded.** The executable is only an absolute path from `ORCA_GAME_CLI`, else `ORCA_CLI_COMMAND`; with neither, or a bare name, nothing runs (a bare `orca` is the GNOME screen reader on Linux). A game pane keeps publishing `advisor` and never reports. Fire-and-forget with a 2 s bound; a value equal to the last one sent is not sent again, and a failed run is retried on the next change.
  - **Not yet.** Orca does not export `ORCA_GAME_CLI` to member panes (companion ORCA-657), so until it does this is a no-op there. The `hold` text is the router's reason code (`same`, `held-by-guard`, ...), not the translated "se mantiene" line.
