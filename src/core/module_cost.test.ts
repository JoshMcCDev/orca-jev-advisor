// feature-modules T0: what each feature module costs today -- hook spawns,
// Jev calls and worker wakeups -- read from synthetic rows shaped like the
// real logs (gate decisions, mod measurements, router, steward, model
// reclassifications), Claude Code transcript lines and Orca's plugin audit log.

import assert from "node:assert/strict";
import test from "node:test";

import {
  auditSetsByKey,
  boardCliRefreshes,
  buildModuleCostReport,
  derivedHookSpawns,
  formatModuleCostReport,
  gateJevCalls,
  modelDecisionJevCalls,
  newTranscriptTally,
  ourHooksFromSettings,
  percentile,
  routerJevCalls,
  skillJevCalls,
  stewardJevCalls,
  tallyTranscriptLine,
  toolJevCalls,
  WORKER_TASKS,
} from "./module_cost.ts";
import { MAX_JEV_CHOICES } from "./jev.ts";

const SINCE = Date.parse("2026-10-01T00:00:00.000Z");
const UNTIL = Date.parse("2026-10-08T00:00:00.000Z");
const WINDOW = { sinceMs: SINCE, untilMs: UNTIL };
const AT = "2026-10-03T10:00:00.000Z";

test("percentile is nearest-rank and null with no sample", () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([30, 10, 20], 50), 20);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9);
});

test("gate: a jev row is one call, an unreachable row is one failed call, cache and local rules are none", () => {
  assert.deepEqual(gateJevCalls({ type: "gate-decision", at: AT, source: "jev", latencyMs: 420 }), { calls: 1, failures: 0, latencyMs: [420] });
  assert.deepEqual(gateJevCalls({ type: "gate-decision", at: AT, source: "jev", latencyMs: null }), { calls: 1, failures: 0, latencyMs: [] });
  assert.deepEqual(gateJevCalls({ type: "gate-decision", at: AT, source: "none", stopReason: "unreachable", latencyMs: null }), { calls: 1, failures: 1, latencyMs: [] });
  assert.deepEqual(gateJevCalls({ type: "gate-decision", at: AT, source: "cache", latencyMs: null }), { calls: 0, failures: 0, latencyMs: [] });
  assert.deepEqual(gateJevCalls({ type: "gate-decision", at: AT, source: "local-rule", latencyMs: null }), { calls: 0, failures: 0, latencyMs: [] });
  assert.deepEqual(gateJevCalls("not a row"), { calls: 0, failures: 0, latencyMs: [] });
});

test("skills: wide is one call, fit one more when it ran; a null result after a latency is a failure", () => {
  assert.deepEqual(skillJevCalls({ type: "decision", at: AT, wide: { gate: 0.7 }, fit: null, latencyMs: { wide: 400, fit: null } }), { calls: 1, failures: 0, latencyMs: [400] });
  assert.deepEqual(skillJevCalls({ type: "decision", at: AT, wide: { gate: 0.7 }, fit: { winner: "x" }, latencyMs: { wide: 400, fit: 250 } }), { calls: 2, failures: 0, latencyMs: [400, 250] });
  assert.deepEqual(skillJevCalls({ type: "decision", at: AT, wide: null, fit: null, latencyMs: { wide: 3000, fit: null } }), { calls: 1, failures: 1, latencyMs: [3000] });
  assert.deepEqual(skillJevCalls({ type: "decision", at: AT, wide: { gate: 0.7 }, fit: null, latencyMs: { wide: 400, fit: 3000 } }), { calls: 2, failures: 1, latencyMs: [400, 3000] });
  assert.deepEqual(skillJevCalls({ type: "observation", at: AT, skill: "x" }), { calls: 0, failures: 0, latencyMs: [] });
});

test("tools: the wide stage is one call per batch of the roster", () => {
  const twoBatches = MAX_JEV_CHOICES + 60;
  assert.deepEqual(toolJevCalls({ type: "decision", at: AT, candidateCount: twoBatches, wide: { gate: 0.3 }, fit: null, latencyMs: { wide: 395, fit: null } }), { calls: 2, failures: 0, latencyMs: [395] });
  assert.deepEqual(toolJevCalls({ type: "decision", at: AT, candidateCount: 40, wide: { gate: 0.3 }, fit: { winner: "Bash" }, latencyMs: { wide: 300, fit: 200 } }), { calls: 2, failures: 0, latencyMs: [300, 200] });
  assert.deepEqual(toolJevCalls({ type: "decision", at: AT, candidateCount: 40, wide: null, fit: null, latencyMs: { wide: 3000, fit: null } }), { calls: 1, failures: 1, latencyMs: [3000] });
  assert.deepEqual(toolJevCalls({ type: "observation", at: AT, tool: "Bash" }), { calls: 0, failures: 0, latencyMs: [] });
});

test("router: a row with a confidence or jev-failed is a call; an engine turn (no confidence) is not", () => {
  assert.deepEqual(routerJevCalls({ at: AT, point: "start", tier: "simple", confidence: 0.9, reason: "same" }), { calls: 1, failures: 0, latencyMs: [] });
  assert.deepEqual(routerJevCalls({ at: AT, point: "stage", tier: null, confidence: null, reason: "jev-failed" }), { calls: 1, failures: 1, latencyMs: [] });
  assert.deepEqual(routerJevCalls({ at: AT, point: "stage", tier: null, confidence: null, reason: "floor-restore" }), { calls: 0, failures: 0, latencyMs: [] });
});

test("model reclassification: a decision row is one call, an outcome row none", () => {
  assert.deepEqual(modelDecisionJevCalls({ type: "model-decision", at: AT, failOpen: null, latencyMs: 800 }), { calls: 1, failures: 0, latencyMs: [800] });
  assert.deepEqual(modelDecisionJevCalls({ type: "model-decision", at: AT, failOpen: "timeout", latencyMs: 6000 }), { calls: 1, failures: 1, latencyMs: [6000] });
  assert.deepEqual(modelDecisionJevCalls({ type: "model-outcome", at: AT, status: "async_launched" }), { calls: 0, failures: 0, latencyMs: [] });
});

test("steward: a row is one call; a null verdict is a failure", () => {
  assert.deepEqual(stewardJevCalls({ at: AT, verdict: "mid-task", confidence: 0.8 }), { calls: 1, failures: 0, latencyMs: [] });
  assert.deepEqual(stewardJevCalls({ at: AT, verdict: null, confidence: null }), { calls: 1, failures: 1, latencyMs: [] });
});

test("our hooks are read from settings.json by status message and script, other hooks ignored", () => {
  const settings = {
    hooks: {
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: "node", args: ["/x/adapters/claude/gate-bash.ts"], statusMessage: "orca-jev-advisor: checks" }] },
        { matcher: "Bash", hooks: [{ type: "command", command: "bash other.sh" }] },
        { matcher: "Edit|Write", hooks: [{ type: "command", command: "node", args: ["/x/adapters/claude/gate-files.mjs"], statusMessage: "orca-jev-advisor: edit" }] },
      ],
      PostToolUse: [{ matcher: "Agent", hooks: [{ type: "command", command: "node", args: ["/x/adapters/claude/agent-model.ts"], statusMessage: "orca-jev-advisor: model" }] }],
    },
  };
  assert.deepEqual(ourHooksFromSettings(settings), [
    { event: "PreToolUse", matcher: "Bash", script: "gate-bash", module: "gate" },
    { event: "PreToolUse", matcher: "Edit|Write", script: "gate-files", module: "gate" },
    { event: "PostToolUse", matcher: "Agent", script: "agent-model", module: "model-router" },
  ]);
  assert.deepEqual(ourHooksFromSettings(null), []);
});

function line(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

test("transcript tally dedupes tool calls, prompts and turns, and times our Bash hook", () => {
  const tally = newTranscriptTally();
  const ts = "2026-10-03T10:00:00.000Z";
  const toolUse = line({ type: "assistant", uuid: "a1", timestamp: ts, message: { content: [{ type: "tool_use", id: "t1", name: "Bash" }, { type: "tool_use", id: "t2", name: "Edit" }] } });
  for (const text of [
    line({ type: "user", uuid: "p1", timestamp: ts, message: { content: "please do it" } }),
    line({ type: "user", uuid: "p1", timestamp: ts, message: { content: "please do it" } }),
    line({ type: "user", uuid: "m1", timestamp: ts, isMeta: true, message: { content: "meta" } }),
    line({ type: "user", uuid: "c1", timestamp: ts, message: { content: "<command-name>/x</command-name>" } }),
    line({ type: "user", uuid: "s1", timestamp: ts, isSidechain: true, message: { content: "subagent task" } }),
    toolUse,
    toolUse,
    line({ type: "user", uuid: "r1", timestamp: ts, message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true }] } }),
    line({ type: "attachment", uuid: "h1", timestamp: ts, attachment: { type: "hook_success", hookEvent: "PreToolUse", hookName: "PreToolUse:Bash", command: "orca-jev-advisor: checks", durationMs: 120, toolUseID: "t1" } }),
    line({ type: "attachment", uuid: "h1b", timestamp: ts, attachment: { type: "hook_success", hookEvent: "PreToolUse", hookName: "PreToolUse:Bash", command: "orca-jev-advisor: checks", durationMs: 120, toolUseID: "t1" } }),
    line({ type: "attachment", uuid: "h2", timestamp: ts, attachment: { type: "hook_success", hookEvent: "PreToolUse", hookName: "PreToolUse:Bash", command: "other-guard.py", durationMs: 9, toolUseID: "t1" } }),
    line({ type: "attachment", uuid: "h3", timestamp: ts, attachment: { type: "hook_cancelled", hookEvent: "PreToolUse", hookName: "PreToolUse:Bash", command: "orca-jev-advisor: checks", durationMs: 6000, toolUseID: "t9" } }),
    line({ type: "system", subtype: "turn_duration", uuid: "d1", timestamp: ts }),
    line({ type: "system", subtype: "turn_duration", uuid: "d1", timestamp: ts }),
    line({ type: "system", subtype: "turn_duration", uuid: "d0", timestamp: "2026-09-01T00:00:00.000Z" }),
    "not json",
  ]) {
    tallyTranscriptLine(tally, text, WINDOW);
  }
  assert.deepEqual(Object.fromEntries(tally.toolCalls), { Bash: 1, Edit: 1 });
  assert.deepEqual(Object.fromEntries(tally.toolErrors), { Bash: 1 });
  assert.equal(tally.prompts, 1);
  assert.equal(tally.turns, 1);
  assert.deepEqual(tally.gateBashHookMs, [120]);
  assert.equal(tally.gateHookCancelled, 1);
});

test("derived hook spawns: Pre per call, Post per success, PostFailure per error, PermissionDenied not observable", () => {
  const hooks = [
    { event: "PreToolUse", matcher: "Bash", script: "gate-bash", module: "gate" as const },
    { event: "PostToolUse", matcher: "Bash", script: "gate-outcome", module: "gate" as const },
    { event: "PostToolUseFailure", matcher: "Bash", script: "gate-outcome", module: "gate" as const },
    { event: "PermissionDenied", matcher: "Bash", script: "gate-outcome", module: "gate" as const },
    { event: "PreToolUse", matcher: "Edit|Write|MultiEdit|NotebookEdit", script: "gate-files", module: "gate" as const },
    { event: "PreToolUse", matcher: "Agent", script: "agent-model", module: "model-router" as const },
    { event: "PreToolUse", matcher: "Agent", script: "agent-model", module: "model-router" as const },
  ];
  const spawns = derivedHookSpawns(hooks, new Map([["Bash", 10], ["Edit", 3], ["Write", 1], ["Read", 50], ["Agent", 2]]), new Map([["Bash", 4]]));
  assert.deepEqual(spawns, { gate: 24, "model-router": 2, steward: 0, "skill-selection": 0, board: 0 });
});

test("audit sets count ok outcomes of our plugin only, in the window", () => {
  const rows = [
    line({ ts: Date.parse(AT), actor: "plugin:ab2web.orca-jev-advisor", method: "storage.set", summary: "key=board", outcome: "attempt" }),
    line({ ts: Date.parse(AT), actor: "plugin:ab2web.orca-jev-advisor", method: "storage.set", summary: "key=board", outcome: "ok" }),
    line({ ts: Date.parse(AT) + 1000, actor: "plugin:ab2web.orca-jev-advisor", method: "storage.set", summary: "key=board extra", outcome: "ok" }),
    line({ ts: Date.parse(AT), actor: "plugin:someone.else", method: "storage.set", summary: "key=board", outcome: "ok" }),
    line({ ts: SINCE - 1, actor: "plugin:ab2web.orca-jev-advisor", method: "storage.set", summary: "key=board", outcome: "ok" }),
  ];
  const audit = auditSetsByKey(rows, "plugin:ab2web.orca-jev-advisor", WINDOW);
  assert.deepEqual(audit.times.get("board"), [Date.parse(AT), Date.parse(AT) + 1000]);
  assert.equal(audit.firstMs, Date.parse(AT));
  assert.equal(audit.lastMs, Date.parse(AT) + 1000);
});

test("board CLI refreshes: one per event that arrives after the 30 s cache expired", () => {
  assert.equal(boardCliRefreshes([], 30_000), 0);
  assert.equal(boardCliRefreshes([0, 10_000, 29_999, 30_000, 31_000, 100_000], 30_000), 3);
});

test("worker tasks: every timer names its cadence and the modules it serves", () => {
  const measurements = WORKER_TASKS.filter((task) => task.intervalMs === 15_000 && task.sidecarsPerRun === 1);
  assert.equal(measurements.length, 3);
  assert.ok(WORKER_TASKS.some((task) => task.owner === "board" && task.trigger.startsWith("event")));
  assert.ok(WORKER_TASKS.some((task) => task.owner === "base"));
});

test("report: per module totals, per prompt and per turn ratios, and a markdown table", () => {
  const tally = newTranscriptTally();
  tally.toolCalls.set("Bash", 100);
  tally.toolCalls.set("Agent", 2);
  tally.prompts = 10;
  tally.turns = 20;
  tally.gateBashHookMs.push(100, 200, 300);
  const report = buildModuleCostReport({
    window: WINDOW,
    tally,
    hooks: [
      { event: "PreToolUse", matcher: "Bash", script: "gate-bash", module: "gate" },
      { event: "PreToolUse", matcher: "Agent", script: "agent-model", module: "model-router" },
    ],
    rows: {
      gate: [{ at: AT, source: "jev", latencyMs: 500 }, { at: AT, source: "cache", latencyMs: null }, { at: "2026-09-01T00:00:00.000Z", source: "jev", latencyMs: 9 }],
      skills: [{ type: "decision", at: AT, mode: "active", wide: {}, fit: null, latencyMs: { wide: 400, fit: null } }],
      tools: [{ type: "decision", at: AT, mode: "active", candidateCount: 10, wide: {}, fit: {}, latencyMs: { wide: 300, fit: 100 } }],
      router: [{ at: AT, point: "start", confidence: 0.9, reason: "same" }],
      models: [{ type: "model-decision", at: AT, failOpen: null, latencyMs: 700 }],
      steward: [{ at: AT, verdict: "mid-task" }],
    },
    audit: { times: new Map([["board", [Date.parse(AT), Date.parse(AT) + 3_600_000]], ["measurementsSummary", [Date.parse(AT)]]]), firstMs: Date.parse(AT), lastMs: Date.parse(AT) + 3_600_000 },
  });
  const gate = report.modules.find((row) => row.module === "gate");
  assert.ok(gate);
  assert.equal(gate.hookSpawns, 100);
  assert.equal(gate.hookMsP50, 200);
  assert.equal(gate.jevCalls, 1);
  assert.equal(gate.jevPerPrompt, 0.1);
  assert.equal(gate.jevPerTurn, 0.05);
  assert.equal(gate.jevMsP50, 500);
  const skills = report.modules.find((row) => row.module === "skill-selection");
  assert.ok(skills);
  assert.equal(skills.jevCalls, 3);
  assert.equal(skills.hookSpawns, 0);
  const router = report.modules.find((row) => row.module === "model-router");
  assert.ok(router);
  assert.equal(router.jevCalls, 2);
  assert.equal(router.hookSpawns, 2);
  assert.deepEqual(report.modes.skills, { active: 1 });
  assert.equal(report.audit.spanHours, 1);
  const board = report.worker.find((row) => row.auditKey === "board");
  assert.ok(board);
  assert.equal(board.observedPerHour, 2);
  const text = formatModuleCostReport(report).join("\n");
  assert.match(text, /\| gate \|/);
  assert.match(text, /\| skill-selection \|/);
});
