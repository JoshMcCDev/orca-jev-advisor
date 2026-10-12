# CI watcher (track C, improvement I-6)

Branch `feat/ci-watcher`, from `main` at 665bc7f (engine types for Claude Code 2.1.296). Candidate I-6 of the mods review.

## Objective

Over 7 days of the owner's sessions the main thread spent about 580 tool calls polling CI (`gh run list|view|watch`, `gh pr checks`) and about 800 `sleep` calls waiting for it. Each is a step that re-reads a large cached context. After a push the mod watches the run for the agent and tells the person, and in Active tells the agent once, so that the agent does not have to poll.

## Where it lives

A new module `ci-watch` (off | shadow | active, default shadow), not a feature of an existing module. Reasons:

- The existing mod features each have their own hooks (`router-*` on turn.step/agent.spawn, `steward` and `verify-done` on turn.complete). The CI watcher needs `tool.call`, `turn.start`/`turn.complete` (idle check), `ui.render` (band row) and `prompt.submit` (note recognition). Folding it into `model-router` would make the router switch also decide whether `gh` runs on the person's machine, and an owner who wants the router off but CI watching on (or the reverse) could not say so.
- It is the only module whose cost is `gh` calls rather than Jev calls; the card has to say that in its own words.
- Like verify-done it has no earlier behaviour to keep, so it defaults to `shadow`.

State meanings (the registry's header says shadow is "the existing modes capped at measure"; this module has no existing mode, so its own state is the switch):

- off: nothing runs. No call counting, no `gh` process, no band row, no log row.
- shadow: the watch runs and the person sees the band row and the toast when the run ends. Nothing is ever submitted to the agent. The agent's own CI polls and long sleeps during the watch are counted (what a notice would have replaced).
- active: shadow plus one short `$.prompt.submit` note, once the run has ended and the session is idle.

## Design decisions

- Pure rules in `src/core/ci_watch.ts`: `gh run list --json` parser, trigger detection from a Bash `tool.call` (command and result), the agent's own poll and sleep calls, the poll schedule and the watch step (wait / done / stop), note and band text, the decision record and its weekly summary. No I/O, no `node:` import, so the mod sandbox can load it. Every function that receives `$` is a top-level function in `hooks/index.ts` (JEVADV-43), and no `$` is captured in a closure declared inside `register`.
- A trigger is a successful main-thread `git push`, `gh pr create` or `gh pr merge`. `git push --dry-run`, a delete push, a push that reports "Everything up-to-date" and a failed call (`isError`) are not triggers. A subagent's call (`e.agentId` set) never starts a watch.
- A watch is keyed by repo directory and head sha: one watch each. The sha comes from `git rev-parse` of the pushed branch (HEAD when none is named); for `gh pr merge` from `gh pr view --json mergeCommit`, and a merge with no merge commit yet (auto-merge queued) starts nothing.
- The tool.call hook awaits `next` first and returns its result untouched. The watch starts on a `$.clock.after` timer, so the result is never held, and a failure anywhere is swallowed.
- Poll schedule: 10 s, 15 s, 20 s, 30 s, 45 s, 60 s, then 90 s. A run that has not appeared after 4 minutes ends the watch quietly (no CI configured, or a branch it does not run on). The cap is 60 minutes. Fail open: `gh` missing (the spawn rejects) stops at once, quietly; three failed polls in a row (not signed in, offline) stop quietly.
- The run set for a sha is every run whose `headSha` is that sha. The watch is done when all of them are `completed`. Success is every conclusion in success/skipped/neutral; anything else (failure, timed_out, cancelled, action_required, startup_failure, an unknown value) is failure, never a guess towards success.
- Counting what Active would replace: from the push result until the watch ends, the main thread's own calls that are a CI poll (`gh run list|view|watch`, `gh pr checks`) or a sleep of 10 seconds or more are counted against the newest running watch. A shorter sleep is not waiting for CI, so shadow undercounts rather than overcounts. A command that both sleeps and polls counts once, as a poll.
- Rows are numbers and names only: `ci-watch-decisions-<YYYY-MM-DDTHH>.jsonl` in the cache directory, one row per watch when it ends (outcome, seconds watched, `gh` calls made, the agent's polls and sleeps during it, whether a note was injected). Never a command, a path, a log or a URL.
- The band row is drawn from `$.state` (key `ciWatches`, plain data) so a write redraws it. The existing `ui.render AbovePrompt` handler keeps its pass-through: it returns whatever sits beneath unless that is the engine's own band, and a survey still wins. The subagent band and the CI rows are stacked in one Box when both exist.
- Active injection: the note is `CI for <sha7> on <branch>: success|failure, <url>` (failure adds the failed workflow names). It waits for the main turn to finish (`turn.start` sets and `turn.complete` clears the running turn id), re-checking every 5 s for up to 10 minutes; it is submitted at most once per watch, never for a subagent, and never when the module has gone off or back to shadow in the meantime. The `prompt.submit` hook recognises its own note and skips skill and tool selection for it, so the note costs no Jev call.
- Gate rules for `gh` do not change. The watcher's own `gh` calls run through `$.process.run`, not the Bash tool, so the gate never sees them.
- The weekly figures on the card come from the log through the existing `read-measurements.mjs` summary (already refreshed while a panel is open), not from a new worker job.

## Scope

In: the pure core, the registry entry, the mod wiring, the log and its summary, the `measure-module-cost` row, the panel card (es and en) wired through the real `feature-modules-save` writer, and the weekly figures on the card from the log.

Out: the live check (C7), the release (version, CHANGELOG, README), pushing, any change to the gate.

## Checklist

Strict TDD for each task: RED observed, then GREEN, then a Conventional Commit on this branch.

- [ ] C0 This task file.
- [ ] C1 `src/core/ci_watch.ts` + test: the `gh run list` parser, trigger detection (push, pr create, pr merge; each non-trigger), the agent's poll and sleep calls, the schedule and the watch step, the texts, the record and its summary.
- [ ] C2 Registry and the post-push wake: `ci-watch` in the registry and every consumer of `MODULE_IDS`; the `tool.call` hook starts a watch after `next`, result unchanged.
- [ ] C3 Adaptive poll on `$.clock.after` with `$.process.run(['gh','run','list',...])`, back-off, cap, one watch per repo and sha, fail open; band row and toast when the run ends.
- [ ] C4 Shadow accounting: the agent's polls and sleeps during a watch, and one row per watch; no prompt injected.
- [ ] C5 Active: one `$.prompt.submit` note once idle.
- [ ] C6 Panel card (es/en) in Modules, weekly figures, `scripts/panels.spec.mjs`, `measure-module-cost` row.
- [ ] C7 Live check on the marketplace install: not part of this branch; the list is in the hand-off report.

## Acceptance criteria

- Off: no `gh` process, no row, no state write, no timer; the Bash call's result is the one `next` gave.
- Shadow: a successful push starts one watch; a second push of the same sha starts none; a subagent's push starts none; the run ending gives one toast, one band row change and one log row; `$.prompt.submit` is never called.
- Active: the same, plus exactly one note per watch, never while a turn runs, never for a subagent.
- No `gh`, no auth, or three failed polls: the watch ends without a toast or a note.
- `npm run typecheck` exits 0; `npm test` and `npm run test:panels` pass. The card is photographed at 1440 and 390, light.

## Checks

`npm run typecheck`, `npm test`, `npm run test:panels`, the card screenshots.

## Memory

The Engram mirror `odd/ci-watcher/tasks` is not written by this delegate (no Engram access by instruction).
