import assert from "node:assert/strict";
import test from "node:test";

import { buildOrcaReport, orcaReportExecutable, orcaReportPins } from "./orca_report.ts";

test("executable: ORCA_GAME_CLI wins, then ORCA_CLI_COMMAND, only when absolute", () => {
  assert.equal(orcaReportExecutable("/opt/orca/bin/orca", "/usr/local/bin/orca"), "/opt/orca/bin/orca");
  assert.equal(orcaReportExecutable(undefined, "/usr/local/bin/orca"), "/usr/local/bin/orca");
  assert.equal(orcaReportExecutable("  /opt/orca  ", undefined), "/opt/orca");
  assert.equal(orcaReportExecutable("C:\\Orca\\orca.exe", undefined), "C:\\Orca\\orca.exe");
});

test("executable: nothing set, empty, or not absolute is no executable, never a bare orca", () => {
  assert.equal(orcaReportExecutable(undefined, undefined), null);
  assert.equal(orcaReportExecutable("", "  "), null);
  assert.equal(orcaReportExecutable("orca", undefined), null);
  assert.equal(orcaReportExecutable("./orca", "orca-ide"), null);
});

test("executable: a relative ORCA_GAME_CLI does not fall back to ORCA_CLI_COMMAND's bare name", () => {
  assert.equal(orcaReportExecutable("orca", "orca"), null);
});

test("pins: only exactly 1 is a pin", () => {
  assert.deepEqual(orcaReportPins("1", "1"), { model: true, effort: true });
  assert.deepEqual(orcaReportPins("true", "0"), { model: false, effort: false });
  assert.deepEqual(orcaReportPins(undefined, null), { model: false, effort: false });
});

test("report: v1 keys exactly, v2 keys only when there is something to say", () => {
  const bare = buildOrcaReport({ model: null, effort: null, pins: { model: false, effort: false }, line: null, skill: null, tool: null, routedModel: null, sessionModel: null });
  assert.deepEqual(bare, { version: 1, model: null, effort: null, pinned: { model: false, effort: false } });
});

test("report: v2 extras sit beside v1 and v1 keeps its meaning", () => {
  const report = buildOrcaReport({ model: "Haiku 5.5", effort: "high", pins: { model: true, effort: false }, line: "jev · model: Haiku 5.5 · high effort", skill: "tdd", tool: "Bash", routedModel: "claude-haiku-5-5", sessionModel: "claude-opus-5-5" });
  assert.deepEqual(report, {
    version: 1,
    model: "Haiku 5.5",
    effort: "high",
    pinned: { model: true, effort: false },
    line: "jev · model: Haiku 5.5 · high effort",
    skill: "tdd",
    tool: "Bash",
    routedModel: "claude-haiku-5-5",
    sessionModel: "claude-opus-5-5",
  });
});
