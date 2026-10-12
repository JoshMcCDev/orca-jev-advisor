# Gate secret guard (track G)

## Objective

A secret file never reaches a remote silently. The real
`adapters/claude/gate-bash.ts` allowed, with no question at all:

- `git add -f .env`;
- `git add .env && git commit`;
- `git push origin feat/x` carrying a commit that contains `.env`.

Cause: `src/core/contained_effect.ts` treats every `git add` as own-tree work,
`commit` is own-tree work unless `--no-verify`, and `push_own_branch.ts`
allows a plain push of an own branch with no content check. A pushed key
cannot be taken back.

Ships Active (no Shadow): it is a deterministic path check.

## Scope

- In:
  - one shared "secret path" helper (`src/core/secret_paths.ts`);
  - add/commit no longer own-tree work when they stage or commit a secret path;
  - an own-branch push is no local allow when an outgoing commit touched a secret path;
  - a gate-level ask (`stopReason: "secret-publish"`) that runs before the local
    allows, the advice retry pass, the remembered authorizations and the
    verdict cache, and never writes the cache;
  - es/en ask text naming the file and why;
  - the G6 false positive (Python editing a scratchpad file read as "writing to main").
- Out:
  - version bump, CHANGELOG, README, release (the orchestrator does those);
  - a per-rule Shadow/measure switch (the owner asked for Active);
  - the discard protection's own secret list (`git_recoverability.ts`,
    `discard_loss.ts`), which protects a different harm and stays as it is.

## Checklist

- [ ] G0 End-to-end `gate-bash.test.mjs` tests pin the three shapes, plus the
  authorized-push and cache-replay precedence cases, as `ask` (RED today).
- [ ] G1 `git add -f`, or an add whose pathspec names a secret path, is not own-tree
  work and asks. Secret path defined once. `.env.example`, `.env.sample`,
  `.env.template` stay allowed.
- [ ] G2 A commit with a staged secret path (or `-a` with a modified tracked
  one, or a secret pathspec) is not own-tree work and asks. The hook reads
  the staged names.
- [ ] G3 A push asks when any outgoing commit touched a secret path
  (`git log --name-only <range>`, add-then-delete caught). A new branch with
  no upstream is read from the merge-base with origin's default branch.
- [ ] G4 Precedence: runs before the 0.6.28 remembered authorizations and the
  shape cache replay; a policy deny stays a deny; a local-rule deny stays a deny.
- [ ] G5 Visibility: es/en ask text names the file and the reason; distinct
  `stopReason` in `GateStopReason` and its guard; panel row only if the panel
  lists fixed rules.
- [ ] G6 False positive: find the gate log row, reproduce it in a test, fix it
  with a negative test if real.

## Acceptance criteria

- The three shapes ask, naming the file, end to end through the real hook.
- With `push-branch` authorized for the repository, a push carrying `.env` still asks.
- A cached policy deny and a local-rule deny stay denies.
- `git add -A && git commit` with an ignored `.env` stays allowed
  (`own_tree_effect.test.ts`), and a clean own-branch push stays a local allow.
- `.env.example`, `.env.sample`, `.env.template` never ask.

## Checks

- `npm run typecheck` exits 0.
- `npm test` passes in full.
- `npm run test:panels` passes, if the panel changed.
