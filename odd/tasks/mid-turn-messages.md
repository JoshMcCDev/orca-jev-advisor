# Messages written mid-turn (M5, from Jev_steer_or_queue)

Candidate M5 of `odd/tasks/feature-modules.md`; idea in `odd/backlog.md`, "Messages written mid-turn".

## First check (done)

1. **The mod can see them.** `claude-code.d.ts`: `prompt.submit` "Typed while a turn ran, it fires at Enter, with that turn's id." So a mid-turn message is observable before the turn ends. The mod cannot change how Claude Code queues it, only rewrite or drop it.
2. **How often.** Last 7 days of transcripts: 5,025 human prompts in 760 sessions; **280 arrived mid-turn (5.6 %) in 39 sessions**, about 40 a day.

## Open question (blocks the build)

The module would classify each mid-turn message as steer now, queue, or interrupt. There is no ground truth for that choice: nothing in the transcripts records whether the owner wanted the message to steer or to queue. Without a label, a shadow log cannot say whether Jev was right, so the week of data would only show volume, which is already known.

## Decision

Parked, not built. The volume is real, but the value needs a case where a mid-turn message went wrong (steered when it should have queued, or the reverse). Same bar as M2. Revisit if the owner reports one, or if a labelled set of mid-turn messages is collected first.

## Checklist

- [x] P0 Verify the mod sees mid-turn messages (`prompt.submit`).
- [x] P1 Count them in a week of transcripts (280 of 5,025).
- [ ] P2 Collect labels: for each mid-turn message, what the owner wanted. Needs the owner.
- [ ] P3 Only if P2 shows a real misroute: pure classifier, shadow module, measure.
