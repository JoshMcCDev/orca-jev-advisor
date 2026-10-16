# Game mode: publish Jev's line and band as state instead of drawing them

## Objective
In a Claude Agent Teams pane that Orca launched with its `orca-game` mod
active, Jev keeps doing all its work but stops drawing its own status line and
AbovePrompt band. It publishes the same data under its PluginState contract so
the game draws it inside its scene. Request from orca-oss (ORCA-586 T5).

## Scope
- Detect the game: `ORCA_GAME_MODE` is `on` or `zen` (trimmed, any case).
  Absent, `off` or anything else means no game. Read once per load.
- Game active: no `$.ui.status` call, and the AbovePrompt hook returns
  `next(e)` untouched before reading any state. Toasts, routing, advice,
  prompts between turns, the steward, the CI watcher and memory keep running.
- Game active: write `{ plugin: 'orca-jev-mod-skills', key: 'advisor' }`
  wherever the line or the band would have redrawn: the six status-line
  sites, every `runningSubagents` write and every `ciWatches` write. Writes
  are serialized, and a value equal to the last one written is not written
  again.
- `advisor` is declared in `types/index.d.ts` (`AdvisorState`).
- Game off or absent: nothing changes, and `advisor` is never written.

## Final shape (`AdvisorState`, version 1)
`version`, `locale`, `line`, `model`, `modelId`, `effort`, `subagents[]`,
`ci[]`, `notices[]`. `notices` carries the two toasts the mod raises (the
steward's /clear hint and a finished CI run); the toasts still show.

## Tasks
- [x] G1 pure module `src/core/advisor_state.ts`: `parseOrcaGameMode`, `buildAdvisorState`, notices list. RED first.
- [x] G2 hooks: game mode silences the line and the band and publishes `advisor`; off writes nothing. RED first.
- [x] G3 contract type, CHANGELOG and version 0.12.0.
- [ ] G4 checks: `npm run preflight`, `npm run shots:band` (non-game band unchanged) done; contract NOT delivered to orca-oss-d9 (not reachable on 2026-10-16), written to the brief's scratchpad as `jev-game-contract.md` instead.

## Evidence
- `npm run preflight`: 4374 tests pass, typecheck clean; the real `claude plugin validate` passes and lists `orca-jev-mod-skills.advisor`.
- `npm run shots:band`: 16 shots (es/en, 40/80/120/200, light/dark); es-120-dark and en-40-light read, the non-game band is unchanged.
- The game scene itself is in orca-oss and was not photographed here.

## Acceptance criteria
- With `ORCA_GAME_MODE=on` or `zen`, no `ui.status` call across submit, spawn,
  step, session start and turn complete; the band returns what is beneath it.
- `advisor.line` equals the status line a non-game run shows for the same events.
- `advisor.subagents` lists the agents the band would show, with model, effort,
  branch and the short reason.
- With the game off or absent, the existing suite passes unchanged and no
  `advisor` value is written.

## Checks
- `npm run typecheck`, `npm test`, `npm run shots:band`.
- Visual: the game scene lives in orca-oss; this repo cannot photograph it.
  The non-game band is photographed to show it is unchanged.

## Out of scope
- Merge, release and the marketplace catalog: the brief needs the owner's OK.
- The game's own drawing (orca-oss).
