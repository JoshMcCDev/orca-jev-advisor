# Advice text says only what the model does not already know (0.13.7)

## Objective

The model-facing advice (`permissionDecisionReason`) repeats what the coding
model already knows: the command it just wrote, the effect that command
obviously has ("triggers a deployment workflow on GitHub Actions", "it cannot
be undone and its effect leaves this machine"), and an internal config note
("this directory doesn't match any catalog destination..."). The owner flagged
it on 2026-10-18 as wasted tokens on every advice.

## Measured (gate-decisions 2026-10-18, 3,264 decisions)

- 296 advices; 253 of them were retried unchanged (`advice-retry`, 85%).
  Every advice is one extra coding-model turn, and its text is read each time.
- Clef: 328 calls, 9,020 neurons by 13:10Z (about 28 neurons a call); Jev
  answered the other 1,917 commands of the day alone (`budget`).
- On 0.13.6, 91 Clef answers escalated to Jev as `policy` against 54 that Clef
  decided: about 63% of Clef calls paid twice.

## Scope

- `src/core/gate_advice_text.ts`: drop reasons that restate an obvious effect
  or internal config; name the affected segments only when the command has
  more than one segment; shorter header. Recoverability sentences, the
  retry clause and the judge name stay.
- The person-facing `systemMessage` does not change.
- Golden Jev-only outputs in `adapters/claude/gate-providers.test.mjs` are
  updated on purpose.

## Checklist

- [x] T1 RED: tests for the trimmed text. Proof: four "0.13.7:" tests in
  `src/core/gate_advice_text.test.ts` failed against the old composer.
- [x] T2 GREEN: implement; update goldens and gate-bash wording tests. Proof:
  `gate_advice_text.test.ts` 22/22; the two `GOLDEN_JEV_*` goldens in
  `adapters/claude/gate-providers.test.mjs` recaptured from the new output
  (systemMessage identical); the three deploy/risk-stage tests in
  `adapters/claude/gate-bash.test.mjs` assert the description is not in the
  model text and the systemMessage still names the segment.
- [x] T3 typecheck, full suite, CHANGELOG, version 0.13.7. Proof:
  `npm run typecheck` exit 0; `npm test` 9168 pass, 0 fail; CHANGELOG and
  README 0.13.7 entries; `package.json` and `orca-plugin.json` at 0.13.7.
  No UI changed, so no screenshots.
- [x] T4 PR, merge, release, catalog pin, live check in odd/qa/qa-0.13.7.md. Proof: PR #87 merged as 8df3632, tag and release v0.13.7, catalog pinned, live scenarios S1-S2 PASS.

## Acceptance

- A single-segment `gh workflow run x.yml` advice has no "It would run" line
  and no "Why:" line; it still has the header and the retry clause.
- A multi-segment command still names its affected segments.
- A specific reason (risk at its limit, breaks something important) is kept.
- The person-facing line is byte for byte as before.

## Next (measured, not in this release)

1. Policy escalation: 63% of Clef calls escalate to Jev. Replay the log to
   find which policy questions trip the 0.2 floor and trim them per command.
2. Read-only families (cat, grep, ls, sed, echo, printf: about 400 model
   calls a day) still reach a model; find why tier 1a misses them.
