# QA 0.13.9: Jev reports its state to Orca from member panes

Live check on the owner's machine on 2026-10-19, after the update through
Settings → Plugins. Release commit `27ff62c` (PR #93, squash-merged), feature
PR #92, tag `v0.13.9`, catalog pin `v0.13.9` (JEVADV-106).

## Install

| # | Check | Expected | Observed | Verdict |
|---|-------|----------|----------|---------|
| I1 | Catalog pin in `ab2webco/orcalab-plugins` `orca-marketplace.json` | `ref: v0.13.9` | `ref: v0.13.9` after "Follow releases" run 39297875682 (commit `chore(catalog): follow releases (… v0.13.8 -> v0.13.9)`) | PASS |
| I2 | Installed copy under `orca/plugins/ab2web.orca-jev-advisor` | `current` points at a 0.13.9 root | `current` → `72d1b201aae2…`, `orca-plugin.json` version `0.13.9`, provenance `marketplace` `orcalab-plugins@main` `4f7d9fa` | PASS |

## Scenario

A member was launched from this project's lead with
`game launch JEVADV-41 --prompt "…"` (a no-op prompt: no edits, no PR) and asked to
print `ORCA_GAME_CLI` and `ORCA_TERMINAL_HANDLE`. The member ran the new plugin copy.

| # | Check | Expected | Observed | Verdict |
|---|-------|----------|----------|---------|
| S1 | `ORCA_TERMINAL_HANDLE` in the member pane | set | `term_cf0d6acf-3509-47ca-b302-dd146d052345` | PASS |
| S2 | `ORCA_GAME_CLI` in the member pane | absolute path of the Orca CLI | empty (`ORCA_GAME_CLI=[]`) | FAIL (Orca side) |
| S3 | Jev reports its state to Orca from the member pane | a report is sent | not sent: with no absolute CLI path the reporter runs nothing, by design | NOT EXERCISED |
| S4 | The member's own band still shows Jev | line with tool, model and effort | `jev · herramienta: Bash (aplicada) · modelo: Haiku 5.5 · esfuerzo alto` | PASS |

## Findings

1. **The report cannot reach Orca yet.** Orca does not export `ORCA_GAME_CLI` to
   member panes, so the 0.13.9 reporter correctly does nothing (the empty-path
   case in the task's acceptance criteria). This is the known gap tracked in
   orca-oss as ORCA-657 ("member panes lack `ORCA_GAME_CLI`"), which ORCA-660's
   report also names. Nothing in the plugin is wrong; the feature switches on when
   Orca exports the variable.
2. **Not verified:** that Orca shows the report on the member's card. That needs
   a member pane with `ORCA_GAME_CLI` set. Re-run S2 and S3 once ORCA-657 ships.
3. **No regression seen:** the member ran with the 0.13.9 hooks, its band drew
   normally and the turn was not delayed.
