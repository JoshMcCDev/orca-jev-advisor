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
- [ ] G1 pure module `src/core/advisor_state.ts`: `parseOrcaGameMode`, `buildAdvisorState`, notices list. RED first.
- [ ] G2 hooks: game mode silences the line and the band and publishes `advisor`; off writes nothing. RED first.
- [ ] G3 contract type, CHANGELOG and version 0.12.0.
- [ ] G4 checks: `npm run preflight`, `npm run shots:band` (non-game band unchanged), contract sent to orca-oss-d9.

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
