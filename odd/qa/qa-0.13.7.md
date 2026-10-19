# QA 0.13.7: the advice says only what the model does not know

Live check on the owner's machine on 2026-10-19, after the update through
Settings → Plugins (Refresh, then Check for update).

## Install

| # | Check | Expected | Observed | Verdict |
|---|-------|----------|----------|---------|
| I1 | `plugins.lock.json` entry `ab2web.orca-jev-advisor` | version 0.13.7, commit 8df3632 | `0.13.7`, `resolvedCommit` 8df3632cc2f5…, `contentHash` f4bd7d30069d… | PASS |
| I2 | Catalog pin in `ab2webco/orcalab-plugins` `orca-marketplace.json` | `ref: v0.13.7` | `ref: v0.13.7` after "Follow releases" run 39182879486 | PASS |
| I3 | Hook entries in `~/.claude/settings.json` and each of the four managed accounts | 8 entries each, all under the f4bd7d30069d root | 8 entries each, all f4bd7d30069d | PASS |

## Scenarios

The installed hook was run directly with a PreToolUse payload (`session_id`
`qa-0137-live`, `cwd` the orca-oss checkout). The command is only judged,
never run. Jev answered live.

| # | Command | Expected | Observed | Verdict |
|---|---------|----------|----------|---------|
| S1 | `gh workflow run lab-release.yml -R ab2webco/orca-oss --ref main` | deny (advice). No "It would run" line, no deploy description, no "leaves this machine". The person line is unchanged. | Model text: header, `Why: if it is wrong, it breaks something that matters to someone.`, retry clause; 252 chars. Person: `jev · avisó al modelo antes de \`gh workflow run lab-release.yml -R ab2webco/orca-oss --ref …\`: publica fuera de tu máquina` | PASS |
| S2 | `npm test && gh release create v9.9.9-qa --notes x` | deny (advice). The compound command names only the segment that concerns; obvious reasons dropped | Model text: header, `It would run: \`gh release create v9.9.9-qa --notes x\`.`, `Why: if it is wrong, it needs cleanup afterwards.`, retry clause; 291 chars. Person line names the segment | PASS |

The same S1 advice in 0.13.6 (seen in this session before the update) had the
long header, an "It would run" line repeating the whole command, and two
reasons: about 440 chars. 0.13.7 sends about 43% less on that advice.

## Findings

None.
