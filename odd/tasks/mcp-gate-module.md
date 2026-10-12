# Gate MCP tools against the goal (M2, from jev-browser)

Branch `feat/mcp-gate-module`, from `main` at 0.8.1. Candidate M2 of `odd/tasks/feature-modules.md`; idea in `odd/backlog.md`, "Gate MCP tools, judged against the goal".

## Objective

Make the gate judge an MCP call that has an effect outside the machine (a Slack message, a Jira comment or transition, a Plane or Tambora write, an image generation or upload) before it runs, the way it already judges a Bash command. Today the gate's hooks match Bash, Agent and the edit tools only, so none of those is ever judged. Reads, and the local memory server, must never cost a Jev call.

## First check (done): what the last week of MCP calls holds

`mcp__*` tool_use blocks in the Claude Code transcripts of the last 7 days (855 files, 23,252 tool calls, 17,608 of them Bash): **1,335 MCP calls, 51 tools, 45 sessions**. Counts only, no content.

| Kind | Calls | Share | Examples |
|---|---|---|---|
| Local memory server (`engram`: save, judge, summary, update) | 865 | 65% | `mem_judge` 603, `mem_save` 238 |
| Reads, searches, local lookups | about 296 | 22% | `runway.get_task` 93, `slack_read_*` 53, `engram.mem_search` 50 |
| **Writes with an effect outside the machine** | **about 174** | **13%** | `tambora.add_test_run_results` 31, `runway.generate_image` 26, Jira comment 19 / transition 13, Plane `create_work_item` 19, uploads 36, `slack_send_message` 9 |

Consequences for the design:

- A hook on every `mcp__*` call would spawn a process (and a Jev call) for 1,335 calls to catch 174. The match has to be narrow: the write tools of the external servers, never `engram`, never a read.
- The owner's stated target is messages to other people and deletes in shared systems. The week held 9 Slack sends and no delete at all, so the first value is the send and the transition, not delete.

## To verify before building

1. Whether a settings.json `PreToolUse` matcher accepts a regex with a negative lookahead (`^mcp__(?!engram__)`), or only an alternation; this decides whether the matcher can be narrow without a list that goes stale.
2. Whether a mod `tool.call` can refuse an MCP call (the engine probes show it can answer one without `next`, a string or an array; a refusal is not shown). If it can, no new settings hook and no new process are needed.
3. What the gate's state carries today (`task context`), and whether the goal of the turn is already available to it. The backlog says this shares the `authorized` mitigator work: design the two together.

## Scope (to be fixed after the checks)

In: extend the `gate` module (decision: no new module id; an MCP call is another surface of the same gate and the Off switch must turn it off too), a pure core that classifies an MCP tool as read, local, or external write from its server and name, the question to Jev with the turn's goal, and the log row.
Out: blocking by default. The first release asks Jev and logs `would-ask` in shadow-style rows before it ever stops a call; whether it stops is decided on the rows.

## Checklist

Strict TDD for each: RED observed, then GREEN, then a Conventional Commit on this branch.

- [x] P0 First check: the week's MCP calls counted (above).
- [ ] P1 Verify the three open points above with a probe, record the answers here.
- [ ] P2 Pure core: classify an MCP tool name (read, local, external write), table-driven from the week's 51 tools plus the unknown case (unknown external server defaults to write).
- [ ] P3 The Jev question and the state it gets (tool name, server, argument keys but not values or only redacted ones, the goal), interpretation, decision.
- [ ] P4 Wiring (installer or mod, per P1), behind the `gate` switch; Off makes 0 calls and 0 rows.
- [ ] P5 `measure-module-cost` row, README and CHANGELOG, version, QA report.
- [ ] P6 PR, merge, release, catalog pin, live check from the marketplace install.

## Coordination

Four other branches are adding modules at the same time (`feat/memory-shadow`, `feat/ci-watcher`, `feat/steward-pre-cold`, `feat/typing-lead-time`) and all of them edit `src/core/feature_modules.ts`, `adapters/claude/mod-skills/hooks/index.ts` and `adapters/orca/panels/config.html`. P1 to P3 add new files only. P4 and P5 touch the shared ones and start after those branches merge, rebased on `main`.

## Acceptance criteria

- A read, a local memory call and any `engram` call make 0 Jev calls and 0 hook spawns.
- An external write makes at most 1 Jev call and is judged against the turn's goal.
- With the gate Off, an MCP call makes 0 calls and 0 rows.
- An upgrade with no module file behaves as 0.8.1.
- `npm run typecheck` 0; `npm test` and `npm run test:panels` green; tracked tree under 40 MiB.

## Memory

The Engram mirror `odd/mcp-gate-module/tasks` is pending: the Engram MCP server is not connected in this session.
