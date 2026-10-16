// Game mode (odd/tasks/game-mode-advisor-state.md, G1): what Jev publishes
// under its `advisor` state key when Orca's game draws the pane, in place of
// its status line and band. Pure: the hooks module reads the inputs.

import assert from "node:assert/strict";
import test from "node:test";

import { ADVISOR_NOTICES_MAX, buildAdvisorState, parseOrcaGameMode, withNotice } from "./advisor_state.ts";
import type { AdvisorNotice } from "./advisor_state.ts";
import type { CiBandRow } from "./ci_watch.ts";
import type { RunningSubagent } from "./subagent_status.ts";

const NOW = Date.parse("2026-10-16T12:00:00Z");

function ciRow(overrides: Partial<CiBandRow>): CiBandRow {
  return { id: "w-1", sha7: "abcdef0", branch: "feat/x", status: "watching", startedAtMs: NOW - 60_000, done: 0, total: 2, failed: [], running: ["build"], typicalWorkflow: null, typicalSeconds: null, durationMs: null, finishedAtMs: null, ...overrides };
}

const AGENT: RunningSubagent = { id: "a-1", type: "general-purpose", description: "Reading the spec", label: "Opus 5.5", effort: "high", effortSource: "jev", why: "kept-unsure", wouldUse: null, place: { worktree: "wt-1", branch: "feat/spec", apart: true } };

test("parseOrcaGameMode: on and zen are the game, in any case and with spaces", () => {
  assert.equal(parseOrcaGameMode("on"), "on");
  assert.equal(parseOrcaGameMode(" ZEN "), "zen");
});

test("parseOrcaGameMode: absent, off, empty or anything else is no game", () => {
  for (const raw of [undefined, null, "", "off", "OFF", "1", "true", "game"]) assert.equal(parseOrcaGameMode(raw), null, String(raw));
});

test("buildAdvisorState: nothing known yet is an empty, versioned value", () => {
  assert.deepEqual(buildAdvisorState({ locale: "en", line: null, main: null, agents: [], ciRows: [], nowMs: NOW, notices: [] }), {
    version: 1,
    locale: "en",
    line: null,
    model: null,
    modelId: null,
    effort: null,
    subagents: [],
    ci: [],
    notices: [],
  });
});

test("buildAdvisorState: the line, the main model and each running agent as the band shows it", () => {
  const state = buildAdvisorState({ locale: "es", line: "jev · agentes: 1", main: { modelId: "claude-haiku-5-5", label: "Haiku 5.5", effort: "medium" }, agents: [AGENT], ciRows: [], nowMs: NOW, notices: [] });
  assert.equal(state.line, "jev · agentes: 1");
  assert.equal(state.model, "Haiku 5.5");
  assert.equal(state.modelId, "claude-haiku-5-5");
  assert.equal(state.effort, "medium");
  assert.deepEqual(state.subagents, [{ id: "a-1", type: "general-purpose", title: "Reading the spec", branch: "feat/spec", worktree: "wt-1", model: "Opus 5.5", effort: "high", status: "running", why: "kept-unsure", verdict: "Jev duda" }]);
});

test("buildAdvisorState: an agent with no place and no model says null, never undefined", () => {
  const bare: RunningSubagent = { id: "a-2", type: "Explore", description: "Searching", label: null, effort: null, why: "unseen", wouldUse: null };
  const [row] = buildAdvisorState({ locale: "en", line: null, main: null, agents: [bare], ciRows: [], nowMs: NOW, notices: [] }).subagents;
  assert.ok(row);
  assert.equal(row.branch, null);
  assert.equal(row.worktree, null);
  assert.equal(row.model, null);
  assert.equal(row.effort, null);
  // JSON round trip keeps every field: no undefined anywhere.
  assert.deepEqual(JSON.parse(JSON.stringify(row)), row);
});

test("buildAdvisorState: CI rows as the band shows them, an expired one left out", () => {
  const running = ciRow({});
  const failed = ciRow({ id: "w-2", status: "failure", failed: ["lint"], running: [], done: 2, finishedAtMs: NOW - 10_000, durationMs: 50_000 });
  const expired = ciRow({ id: "w-3", status: "success", running: [], done: 2, finishedAtMs: NOW - 10 * 60_000 });
  const { ci } = buildAdvisorState({ locale: "en", line: null, main: null, agents: [], ciRows: [running, failed, expired], nowMs: NOW, notices: [] });
  assert.deepEqual(ci.map((row) => [row.id, row.status, row.done, row.total, row.failed]), [["w-1", "watching", 0, 2, []], ["w-2", "failure", 2, 2, ["lint"]]]);
  assert.ok(ci.every((row) => row.text.length > 0));
  assert.equal(ci[0]?.branch, "feat/x");
});

test("withNotice: newest last, at most ADVISOR_NOTICES_MAX kept", () => {
  let list: readonly AdvisorNotice[] = [];
  for (let i = 0; i < ADVISOR_NOTICES_MAX + 2; i += 1) list = withNotice(list, { id: `n-${i}`, level: "info", text: `notice ${i}`, at: NOW + i });
  assert.equal(list.length, ADVISOR_NOTICES_MAX);
  assert.equal(list.at(-1)?.id, `n-${ADVISOR_NOTICES_MAX + 1}`);
  assert.equal(list[0]?.id, "n-2");
});

test("withNotice: the same id replaces its older copy", () => {
  const list = withNotice(withNotice([], { id: "ci:w-1", level: "info", text: "a", at: 1 }), { id: "ci:w-1", level: "warn", text: "b", at: 2 });
  assert.deepEqual(list, [{ id: "ci:w-1", level: "warn", text: "b", at: 2 }]);
});
