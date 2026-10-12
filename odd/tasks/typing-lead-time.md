# Typing lead time (track K0)

Branch `feat/typing-lead-time`, from `main` at 665bc7f (Claude Code 2.1.296 engine types). Engine facts in `odd/research/engine-probes-2.1.296.md`, section g.

## Objective

The skill-suggestion mod scores skills at `prompt.submit`, which adds about 664 ms p50 / 870 ms p90 to each of ~1,818 prompts a week. Track K could precompute that score while the person is still typing, from `prompt.edit`. That only pays off if people really type, and pause, before they send. K0 measures it in real use first: the time from the LAST `prompt.edit` to `prompt.submit`, and how many edits each prompt had. Without this number K is not built.

## Engine facts (probe g)

- `prompt.edit` fires once per keystroke, only in the interactive composer (`origin.kind === 'composer'`), never in `-p` or SDK sessions. A paste arrives as one edit. The first edit is an empty draft. The logged `text` is the draft before the edit.
- A prompt that reaches the session without the composer has no edits. It is counted apart, as `injected`, never as "0 ms".

## Scope

In:
- A pure core module `src/core/typing_lead_time.ts`: the per-session tracker update on an edit, the summary at submit (`gapMs`, `edits`, `kind: composer | injected`), the row, the hourly file name, and the 7-day summary (p50, p90, typed count, injected count) over rows.
- Mod wiring in `adapters/claude/mod-skills/hooks/index.ts`: `prompt.edit` calls `next(e)` first and only updates an in-memory record per session id (no file I/O, no `$.state` write per keystroke); `prompt.submit` appends one row to `typing-<YYYY-MM-DDTHH>.jsonl` next to the skills module's logs. It follows the skill-selection module: Off writes nothing. Fail open.
- Board: one line on the Skills card (es and en), read through `adapters/orca/read-consumption.mjs` like the other 7-day figures; no line when there is no data.

Out: precomputing anything (track K), a version bump, CHANGELOG, README, release.

## Design decisions

- **Which prompts get a row.** The ones the skill scorer would score: non-empty and not a slash command. Those are the ones K would speed up.
- **Kind.** `composer` when the submission's origin is `composer` and the draft had at least one edit; otherwise `injected` (another origin, or a composer submission with no edit seen). An injected row has `gapMs: null`.
- **The draft belongs to the composer.** A non-composer submission (a notification, a peer, a plugin) neither reads nor clears the draft being typed; a composer submission reads it and clears it.
- **Per keystroke cost.** The hook returns `next(e)`'s result at once; the clock and session id reads run after it, in the background, and update a `Map` in memory. Out-of-order updates keep the latest edit time (`max`), so they commute. `prompt.submit` waits for the pending updates before reading the tracker.
- **Off.** The module state is read at submit (the read `prompt.submit` already does), so an Off module writes no row; the keystroke path never reads a file.
- **Subagents.** `prompt.submit` and `prompt.edit` never fire for a subagent's prompt; a subagent's own run writes no typing row.

## Checklist

Strict TDD for each: RED observed, then GREEN, then a Conventional Commit on this branch.

- [x] K0-doc This file.
- [x] K0a `src/core/typing_lead_time.ts` + `src/core/typing_lead_time.test.ts`: tracker update (count, latest time, out of order), summary at submit (composer with edits, composer with none, other origin), row shape, hourly file name and pattern, 7-day summary (window edges, p50/p90 nearest rank, injected counted apart, malformed rows skipped, null with no rows), purity (no `node:` import).
- [x] K0b Mod wiring + `adapters/claude/mod-skills/hooks.test.ts`: the real mod loads with the new import; `prompt.edit` hands back `next(e)`'s result and writes nothing; Off = 0 rows; a composer prompt = one row with gap and edits; an injected prompt = one `injected` row; a subagent's run writes no row; empty and slash prompts write no row; a failing host never affects the prompt.
- [x] K0c `read-consumption.mjs` publishes `typing` (null with no file); the Skills card shows "Typing before send (7 days): p50 X s · p90 Y s · N typed prompts · M injected" (es and en) and no line without data; `scripts/panels.spec.mjs` covers both; `skills-ready` carries the data; shots of the card at 1440 and 390, light.

## Acceptance criteria

- Off: 0 typing rows. Shadow and Active: exactly one row per scored prompt.
- `prompt.edit` does no file I/O and no `$.state` write, and always returns `next(e)`'s result.
- A prompt with no edit is never reported as a 0 ms gap.
- The board shows the line only with real rows in the last 7 days.
- `npm run typecheck` exits 0; `npm test` and `npm run test:panels` pass.

## Checks

`npm run typecheck`, `npm test`, `npm run test:panels`, two screenshots of the Skills card (1440 and 390, light), read and described.
