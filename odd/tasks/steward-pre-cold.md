# Steward pre-cold tier (track S)

Branch `feat/steward-pre-cold`, from `main` at 665bc7f (engine types for Claude Code 2.1.296). Design: the mods review, §6 "S: steward pre-cold tier", §2.3 and §3.1 (I-4). Engine facts: `odd/research/engine-probes-2.1.296.md`, sections e and f and "Side findings".

## Objective

When a long session goes idle, its prompt cache expires after its TTL (1h on 99.99% of this owner's main responses). The next prompt then re-writes the whole context cold, at 2× the input price. Measured: 65 cold returns per week at ≥120k tokens in sessions where the mod runs (about 14.5M cache-write tokens), 169 across all sessions (71.5M); 74 sessions per week end idle at ≥120k and are never resumed.

The pre-cold tier compacts an idle, large session shortly before its cache would expire, while the cache is still warm (about 0.1× the context plus the summary output). A person who comes back then writes a small context instead of the big one cold. It must pay for itself and never compete with the engine's own idle compaction.

## Scope

In:
- A pure core module `src/core/steward_pre_cold.ts`: the switch parser, the engine's minimum, the decision (`fire | wait(ms) | skip(reason)`), the engine-observation rule, the compaction cost, and the weekly summary with the "returned within 24 h" accounting.
- The steward's record and board summary in `src/core/context_steward.ts`: pre-cold rows carry `trigger: "pre-cold"` and stay out of the turn-end numbers.
- The mod wiring in `adapters/claude/mod-skills/hooks/index.ts`: an idle timer per main `turn.complete`, cancelled by `turn.start`; `classic.PreCompact`/`classic.PostCompact` to observe the engine; `$.session.compact` in active mode, a log row in measure mode.
- The switch `stewardColdMode` (`off | measure | active`, default `measure`) from settings through the writer to the steward card in the settings panel (es and en), and its weekly numbers on the board.

Out: reading the TTL from the transcript tail (track R owns `src/core/cache_warmth.ts`; S assumes 1h, see below), a status-line piece, the live check (S4, the orchestrator's), version, CHANGELOG, README.

## Engine-coexistence rule (implemented in `decidePreCold`)

The engine has its own idle compaction (`compact_sleep`): at 0.9 of the TTL, only with a 1h TTL and a warm cache, above `minTokens` (default 200,000, floor 100,000, env `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS`), gated by the server flag `tengu_sunny_locket`. S acts only where the engine will not:

1. **Engine zone.** A context at or above 90% of the engine's minimum (read from the env override when set, clamped to the floor) is in the engine's zone. The 10% band absorbs a difference between our token count and the engine's near the boundary.
2. **Engine seen in this account → S stands down in its zone.** Once an engine idle compaction has been observed in this account (kept in the plugin's `$.store`, which is per config directory, that is per Orca account), S never fires in the engine zone. It never fires before, at or after 0.9 TTL there.
3. **Engine never seen → S fires after the engine's slot, never before it.** In the zone, S's slot is 0.93 of the TTL (55.8 min of 60), after the engine's 0.9 (54 min). If the engine is on, it has started by then: S sees its `PreCompact`/`PostCompact` (trigger `auto`, no own call pending, no turn running) and skips (`engine-compacted`), and the observation is stored, so the engine is learned instead of being pre-empted forever. Firing before 0.9 TTL in the zone would compact first and hide the engine for good.
4. **Below the zone the engine never acts**, so S fires earlier, at 0.85 of the TTL (51 min), leaving room for the compaction to finish while the cache is warm.
5. **Too late is a skip.** A timer that wakes at or after 0.97 of the TTL (a laptop that slept) skips (`expired`): compacting a cold cache costs 1×, not 0.1×.

Observation of the engine: a classic `PostCompact` with `trigger: "auto"` for the main conversation, with no turn running, no pre-cold call of ours pending, and at least half the TTL idle since the last main turn ended. A `PreCompact` or `PostCompact` with trigger `auto` since the timer was armed makes that wake skip, whatever the idle time.

## Design decisions

- **TTL assumed 1h.** 29,082 of 29,085 main responses wrote the 1h bucket. `decidePreCold` takes the TTL as an input and skips anything other than 1h (`ttl`), so track R's reader can feed it once both are merged. The mod passes the constant `PRE_COLD_TTL_MS`.
- **Idle clock.** Armed at each main `turn.complete` (any reason), from `$.clock.now()`. `turn.start` cancels the timer and moves the stamp, so a stale timer (an older stamp) does nothing. Main thread only: a subagent raises no `turn.start` and its `turn.complete` carries an `agentId`.
- **The wake is authoritative.** The timer re-reads the clock; until the slot is due it re-arms for the rest (at most three wakes) and writes nothing.
- **No Jev call when idle.** The turn-end steward already judged the last turn; its verdict and confidence are kept (`$.state` key `stewardCold`, with the person-turn index). A confident `mid-task` (≥ `SOFT_MID_TASK_FLOOR`, 0.8) for that same turn skips (`mid-task`). No verdict (cooldown, Jev failed, below threshold at turn end) is "unknown", not mid-task.
- **Cooldown honoured.** Fewer than `STEWARD_COOLDOWN_TURNS` person turns since the steward's last compaction skips (`cooldown`).
- **Effective mode.** Off when the module or `stewardMode` is off or `stewardColdMode` is off; active only when the module is active and both `stewardMode` and `stewardColdMode` are active; measure otherwise (Shadow caps it at measure).
- **Measure mode touches no steward state.** It logs `wouldFire: "pre-cold"` and does not move the turn-end cooldown, so upgrading changes nothing the existing steward does. Only an applied pre-cold compaction sets `lastCompactionTurn`.
- **Headless.** `$.session.compact` is refused in `-p`/SDK sessions: the row says `notApplied: "headless"` and the session stops arming.
- **Rows.** Only a due wake at or above the threshold writes a row, in the steward's existing hourly log, with `trigger: "pre-cold"`, `decision: "pre-cold"` (fires or would) or `"pre-cold-skip"` with `coldSkip`, and, when applied, the compaction's own `usage` reduced to `compactCost`. `summarizeStewardDecisions` leaves pre-cold rows out of the turn-end counts. `verifyStewardSaving` keeps counting an applied pre-cold compaction: it is a real compaction whose drop shows in the real usage.
- **Returned within 24 h, measured offline.** `summarizePreCold` joins the fire rows with the main steps of `turn-usage-*.jsonl` by session and time (as `verifyStewardSaving` does), so a `--resume` in a new process still counts. Returned: a main step of that session within 24 h of the fire. Not returned: none and the fire is older than 24 h. Pending: neither yet. The router writes those usage rows; with the router module Off no return can be seen.
- **Money in input-token equivalents.** A 1h cache write is 2× the input price, a cache read 0.1×, output 5×. Cost of an applied compaction = input + 0.1×cacheRead + 2×cacheWrite + 5×output of its own usage. Realized saving of an applied one that came back = 2 × (context before − the first returning step's cache write) − its cost. Waste = the cost of applied ones nobody resumed in 24 h. For a measured one, the first returning step's cache write is the cold rewrite active mode would have avoided (measured, not estimated).
- **Pays for itself.** With about 0.1× of a 120k context plus about 2k output tokens (≈22k input-equivalents) against a 2× rewrite of about 110k saved (220k), it breaks even when about 1 in 10 compacted sessions comes back; the measured rate is about 65 of 139 (47%).

## Checklist

Strict TDD for each: RED observed, then GREEN, then a Conventional Commit on this branch.

- [x] S0 This task file (`docs(plan)`).
- [ ] S1 `src/core/steward_pre_cold.ts` + test: `parseStewardColdMode`, `engineIdleCompactMinTokens`, `decidePreCold` (each skip, each slot, the wait, the engine rule both ways, the zone band, `ttl`), `isEngineIdleCompaction`, `preColdCompactCost`, `preColdInstructions`; `context_steward.ts`: pre-cold decision kinds, tier, optional record fields, the turn-end summary leaving pre-cold rows out.
- [ ] S2 Mod wiring + `steward.test.ts`: armed per main `turn.complete`, cancelled and made stale by `turn.start`, never for a subagent; not due writes nothing; measure logs `wouldFire` and touches no `steward` state; active compacts with pre-cold instructions and records `usage`; headless stops arming; engine observed in `$.store` and the engine rule applied; a confident mid-task and the cooldown skip; fails open. `summarizePreCold` with the return accounting. The real `register` loads with the new `src/core` import (`steward.test.ts`), and `mod_skills_validate.test.mjs` validates the installed copy with the real `claude`.
- [ ] S3 `stewardColdMode` through `stewardFromSettings`, `parseStewardSettingsStrict`, `planStewardWrite`, `steward-set`, the module's mode list, the steward card (es and en) and the board's weekly line; `scripts/panels.spec.mjs` covers the switch, its save and the numbers. Shots of the changed sections at 1440 and 390, light.
- [ ] S4 Live check (the orchestrator's, after release): see "Live check" below.

## Acceptance criteria

- With the defaults (`stewardMode` measure, `stewardColdMode` measure) no session is compacted by S and the turn-end steward's rows and cooldown are unchanged.
- In the engine zone with the engine seen, S never fires; with it unseen, S never fires before 0.93 TTL.
- A subagent never arms a timer; a turn that starts makes any armed timer do nothing.
- Every applied or would-fire decision is a row in the steward log; nothing below the threshold or not yet due writes one.
- The setting has UI in both languages and is saved by the real writer; the board shows fired, would fire, returned within 24 h, realized saving and waste for 7 days.
- `npm run typecheck` 0; `npm test` and `npm run test:panels` green; protected: `steward.test.ts`, `context_steward.test.ts`, `verifyStewardSaving`, the turn-running guard, `model_router_*` tests, the router's `routerSticky` reading.

## Checks

`npm run typecheck`, `npm test`, `npm run test:panels`, the screenshot script for the steward card and the board line.

## Live check (S4, not on this branch)

1. In an interactive Orca session with the cold switch on Active, a context ≥120k and below 180k (90% of 200k), idle 51 min: a `pre-cold` row with `applied: true`, `contextAfter` and `compactCost`, and a classic `PreCompact` with `trigger: "manual"`.
2. The same session resumed: the first main step's `cacheWrite` is small, and the board counts it as returned with a realized saving.
3. Above 180k: whether the engine's own idle compaction fires at 54 min (an `engine-idle-compact` row and the `$.store` key `engineIdleCompactSeenAt`), with which classic trigger. If the engine reports something other than `auto`, the observation rule needs that trigger.
4. A `-p` session: no compaction, a `headless` row at most, no error.
5. With Measure: a `wouldFire: "pre-cold"` row and the steward's `lastCompactionTurn` unchanged.

## Memory

The Engram mirror `odd/steward-pre-cold/tasks` is the orchestrator's: this writer does not touch Engram data.
