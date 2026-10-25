# AGENTS.md

@/home/josh/.codex/RTK.md

## Cross-repository defaults

- Use the smallest tool and context surface that fits the task.
- Prefer symbol-aware or indexed tools before broad shell searches.
- Read targeted files and return structured summaries instead of large raw output.
- Keep changes narrowly scoped and run the smallest useful validation.

## Context protection

- Do not flood the conversation with raw logs, HTML, or large command output.
- When processing command output, use context-mode to filter, count, parse, or summarize it before returning results.
- Use `ctx_batch_execute` to gather and query related command output in one pass; provide all needed queries in that call.
- Use `ctx_search` for indexed sources and prior session context. Use `sort: "timeline"` when chronology matters.
- Use `ctx_execute` for computation over captured data and `ctx_execute_file` to analyze repository files without returning their full contents.
- Context-mode subprocesses are for analysis, not persistent file writes. Use the available file editing tool for changes.

## Tool routing

1. Use Serena or another symbol-aware repository tool when available.
2. Use indexed/search tools for repository search, filtering, and parsing.
3. Use documentation tools for framework and API questions.
4. Use shell for git operations, targeted file operations, installs, and validation.

For repository text searches, prefer `rg` and `rg --files` over recursive `grep` or `find`. Scope searches to relevant paths and globs. Use `-uuu` only when intentionally searching ignored or hidden files. Use `jq` to select fields from JSON.

Use Orca's CLI or UI when the task depends on live Orca worktree, terminal, plugin, or session state. Use normal repository tools for files and git state. Follow the active Orca CLI guide to resolve the executable; on Linux outside an Orca-managed terminal, do not assume bare `orca` is the Orca IDE CLI.

## Basic Memory

- Search Basic Memory for relevant prior decisions or status before answering questions about them.
- Record durable engineering decisions as typed decision notes when instructed; keep enforceable project rules in this file or checked-in documentation.
- `.codex/basic-memory.json` pins this repository's Basic Memory project. Do not change the user's global default project as part of repository work.

## Repository rules

- This repository is the `orca-jev-advisor` Orca plugin. Read `README.md` and `adapters/orca/README.md` before changing plugin integration, manifest, panels, or runtime behavior.
- Shared decision logic belongs in `src/core/`; keep `adapters/orca/` focused on the Orca surface and do not duplicate core behavior there.
- Preserve documented runtime and verification boundaries. Do not describe an Orca runtime behavior as verified unless it was exercised in Orca.
- Keep repository-specific policy and architecture rules here or in checked-in docs.
