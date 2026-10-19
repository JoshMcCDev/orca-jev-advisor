# QA 0.13.8: the gate stops paying for answers it never reads

Live check on the owner's machine on 2026-10-19, after the update through
Settings → Plugins (Refresh, then Check for update). Release commit `d7563e0`
(PR #89, squash-merged), tag `v0.13.8`, catalog pin `v0.13.8`.

## Install

| # | Check | Expected | Observed | Verdict |
|---|-------|----------|----------|---------|
| I1 | `plugins.lock.json` entry `ab2web.orca-jev-advisor` | version 0.13.8 | `0.13.8`, resolvedCommit `6da4c922f7`, contentHash `9bcaa39e347a…` | PASS |
| I2 | Catalog pin in `ab2webco/orcalab-plugins` `orca-marketplace.json` | `ref: v0.13.8` | `ref: v0.13.8` after "Follow releases" run 39189250387 | PASS |
| I3 | Hook entries in `~/.claude/settings.json` and the four managed accounts | every entry under the `9bcaa39e347a` root | 40 entries, all `9bcaa39e347a` | PASS |

## Scenarios

The installed hook (`adapters/claude/gate-bash.ts` under the `9bcaa39e347a`
root) was run with PreToolUse payloads. Commands were judged, never run.

| # | Command | Expected | Observed | Verdict |
|---|---------|----------|----------|---------|
| S1 | `pgrep -fl node` | silent allow (tier 1a, read-only process listing) | silent allow | PASS |
| S2 | `ps aux \| grep orca` | silent allow (tier 1a, read-only process listing) | silent allow | PASS |
| S3 | `git grep -n advice -- src` | silent allow (tier 1a, read-only git subcommand) | silent allow | PASS |
| S4 | `git diff --output=/tmp/qa-0138-x.diff` | not approved by tier 1a (`--output` writes a file); decided by Jev | `allow` from Jev, not tier 1a. `isSafeSegment` returns `false` for this form on main (verified in `src/core/gate_safe_command.ts`) | PASS (for the tier-1a hole); see Findings |
| S5 | `gh release create v9.9.9-qa --notes x` | advice (publish) with the trimmed model text | deny (advice). Model text: header, `Why: Jev's risk score ... right at its limit`, retry clause. Person line names the segment and "publica fuera de tu máquina" | PASS |

S1–S3 are the cut 2 forms (`pgrep`, `ps`, `git grep`). S4 checks that the git
`--output` hole stays closed. S5 is the publish advice, now at the trimmed size.

## Findings

1. **S4 is allowed by Jev, not blocked.** Writing a diff to `/tmp` is not
   harmful, so this result is acceptable. The check that matters is a write
   into the repository, for example `git diff --output=src/x.diff`. It is not
   tier-1a safe, so it is judged, but this QA did not run that form. Add it
   to the next QA pass.
2. **Screenshots: not taken.** 0.13.8 changes wording in the configuration
   panel (`~180` became `~245` calls). The worker was told to skip Playwright,
   so that panel has no visual check. CLAUDE.md rule 7 requires one. Run
   `npm run shots` and read the images before the next release.
3. **Clef share unchanged.** Clef still escalates about 77% of policy calls,
   mostly `never_write_to_main` from the orca-oss main checkout. This is the
   next lever and is not shipped (see PR #89 body and
   `odd/tasks/gate-model-spend.md`).

## Verdict

PASS for install, catalog pin, and the five live scenarios. Open: finding 2
(visual check) and the write-into-repository `--output` form (finding 1).
