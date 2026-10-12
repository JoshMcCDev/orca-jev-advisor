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

- [x] G0 End-to-end `gate-bash.test.mjs` tests pin the three shapes, plus the
  authorized-push and cache-replay precedence cases, as `ask` (RED today).
  Proof: 5/5 RED through the paths they claim: `own-tree` (add -f, add &&
  commit), `local-allow` (push), `authorized`, `cache`. Committed as `todo`.
- [x] G1 `git add -f`, or an add whose pathspec names a secret path, is not own-tree
  work and asks. Secret path defined once. `.env.example`, `.env.sample`,
  `.env.template` stay allowed. Proof: `secret_paths.test.ts` and
  `secret_publish.test.ts` RED (module missing), own-tree add cases RED
  (`git add -f .env` was own-tree); GREEN after; both G0 add tests GREEN;
  full `npm test` 3812 pass, 0 fail, 3 todo.
- [x] G2 A commit with a staged secret path (or `-a` with a modified tracked
  one, or a secret pathspec) is not own-tree work and asks. The hook reads
  the staged names. Proof: 3 unit tests and 2 e2e tests RED (e2e: `own-tree`
  allow), GREEN after.
- [x] G3 A push asks when any outgoing commit touched a secret path
  (`git log --name-only <range>`, add-then-delete caught). A new branch with
  no upstream is read from the merge-base with origin's default branch.
  Range: `git log --name-status --no-renames <sources> --not --remotes=<remote>`
  -- commits no remote-tracking branch of that remote has. With an upstream
  that is `@{u}..`; for a new branch it starts at the merge-base with
  `origin/HEAD` (and also skips commits already on any other branch of that
  remote). Deletions publish nothing and are skipped; the commit that added
  the file is what asks. Outside a repository, or for a source that names
  nothing, the push sends nothing. Proof: 5 unit tests and 2 e2e tests RED
  (e2e: `local-allow`), GREEN after; the 3 G0 push tests GREEN; the
  no-regression e2e (secret already on origin/main, clean push stays
  `local-allow`) GREEN before and after. The 7 existing own-branch push tests
  run from a non-repository went RED on the first cut (unknown read turned
  the local allow off) and GREEN once "no repository / missing source sends
  nothing" was read as clean.
- [x] G4 Precedence: runs before the 0.6.28 remembered authorizations and the
  shape cache replay; a policy deny stays a deny; a local-rule deny stays a deny.
  The check sits after the local deny rules and the policy filtering, before
  the local allows, the retry pass, the key, the cache and Jev. With no
  `prohibits` policy left it asks at once. With one, the cache and Jev still
  judge, and only their policy deny is kept; an allow, an advice, a policy
  ask, no key or no answer become the ask. Never cached, never remembered,
  never relaxed by the retry pass. Proof: authorized push and cache replay
  (G0) GREEN since G3; cached policy deny RED (`ask`) then GREEN (`deny`);
  local-rule deny (`feat/x:main`), prohibiting policy with a cached allow or
  no key, and no-cache/no-authorization/retry-asks-again tests GREEN.
- [x] G5 Visibility: es/en ask text names the file and the reason; distinct
  `stopReason` in `GateStopReason` and its guard; panel row only if the panel
  lists fixed rules. The ask (`permissionDecisionReason`) and the person's
  line (`systemMessage`) name the file, the commit for a push, and why, in
  es and en. `secret-publish` is in `GateStopReason`, its guard and its doc.
  The panel lists only the switchable deny-tier rules (the `ownConfig` rule
  has no row either), and this rule has no switch, so no panel change and no
  screenshots. Proof: the parser test and the e2e es/en test RED (the row was
  dropped by `isGateStopReason`), GREEN after.
- [x] G6 False positive: find the gate log row, reproduce it in a test, fix it
  with a negative test if real. Row: `gate-decisions-2026-10-12T18.jsonl`,
  id `bd21309a-…`, 18:53:59Z, project `orca-jev-advisor`, family `python3`,
  source `jev`, verdict `deny`, policy `never_write_to_main`; its pending
  approval names tool use `toolu_01Nh7…`, which the transcript resolves to
  `F=<scratchpad>/mods-review.md; python3 -I - "$F" <<'EOF' … EOF` run from
  the main checkout. Real false positive: the only write is a scratchpad file
  under `$CLAUDE_CODE_TMPDIR` (`/Volumes/Data/claude-tmp`). The gate is right
  that Python is never contained and that the session's main checkout is
  where it acts; the fault was Jev's copy, where the scratchpad (another
  volume, not a system location) read as an opaque `<path-1>`. Fix: Jev's
  copy marks a temp-root path as `$TMPDIR/<path-N>`, still pseudonymised.
  Proof: `gate_scratchpad_write.test.ts` reproduces the three facts (GREEN
  before and after) and the two rendering tests went RED, then GREEN.
  Unverified: that Jev now answers "not covered" for this command; it needs a
  live Jev call, which was not made.

## Acceptance criteria

- The three shapes ask, naming the file, end to end through the real hook.
- With `push-branch` authorized for the repository, a push carrying `.env` still asks.
- A cached policy deny and a local-rule deny stay denies.
- `git add -A && git commit` with an ignored `.env` stays allowed
  (`own_tree_effect.test.ts`), and a clean own-branch push stays a local allow.
- `.env.example`, `.env.sample`, `.env.template` never ask.

## Checks

- `npm run typecheck` exits 0. Done.
- `npm test` passes in full: 3838 tests, 3838 pass, 0 fail.
- `npm run test:panels`: not run, the panel did not change.
- Pending, for the release step: a live check on the marketplace install with
  a throwaway repository (the three shapes ask; a clean push does not), and a
  live Jev call on the G6 command.
