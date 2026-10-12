// Track S (odd/tasks/steward-pre-cold.md): the pure rules of the steward's
// pre-cold tier. The mod wiring is covered in
// adapters/claude/mod-skills/steward.test.ts.

import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_STEWARD_COLD_MODE,
  ENGINE_IDLE_COMPACT_DEFAULT_MIN_TOKENS,
  ENGINE_IDLE_COMPACT_FLOOR_TOKENS,
  PRE_COLD_RETURN_WINDOW_MS,
  PRE_COLD_TTL_MS,
  decidePreCold,
  engineIdleCompactMinTokens,
  isEngineIdleCompaction,
  parseStewardColdMode,
  preColdCompactCost,
  preColdEarliestMs,
  preColdMode,
  summarizePreCold,
} from "./steward_pre_cold.ts";
import type { PreColdInput } from "./steward_pre_cold.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;

/** A 150k session idle 52 minutes, below the engine's zone (180k), nothing against it. */
const DUE: PreColdInput = {
  contextTokens: 150_000,
  threshold: 120_000,
  ttlMs: PRE_COLD_TTL_MS,
  idleMs: 52 * MIN,
  engineMinTokens: 200_000,
  engineSeen: false,
  engineCompactedSinceIdle: false,
  turnsSinceCompaction: null,
  judgment: null,
};

// ---------------------------------------------------------------------------
// The switch and the engine's minimum
// ---------------------------------------------------------------------------

test("parseStewardColdMode: off, measure and active; anything else is the default, measure", () => {
  assert.equal(DEFAULT_STEWARD_COLD_MODE, "measure");
  assert.equal(parseStewardColdMode("off"), "off");
  assert.equal(parseStewardColdMode("measure"), "measure");
  assert.equal(parseStewardColdMode("active"), "active");
  for (const value of ["loud", "", null, undefined, 1, true, {}]) assert.equal(parseStewardColdMode(value), "measure", String(value));
});

test("preColdMode: off when the steward or its cold switch is off; active only when both are active", () => {
  assert.equal(preColdMode("off", "active"), "off");
  assert.equal(preColdMode("active", "off"), "off");
  assert.equal(preColdMode("measure", "active"), "measure");
  assert.equal(preColdMode("active", "measure"), "measure");
  assert.equal(preColdMode("measure", "measure"), "measure");
  assert.equal(preColdMode("active", "active"), "active");
});

test("engineIdleCompactMinTokens: 200k by default, the env override when it is a whole number, never under the 100k floor", () => {
  assert.equal(ENGINE_IDLE_COMPACT_DEFAULT_MIN_TOKENS, 200_000);
  assert.equal(ENGINE_IDLE_COMPACT_FLOOR_TOKENS, 100_000);
  assert.equal(engineIdleCompactMinTokens(undefined), 200_000);
  assert.equal(engineIdleCompactMinTokens(""), 200_000);
  assert.equal(engineIdleCompactMinTokens("abc"), 200_000);
  assert.equal(engineIdleCompactMinTokens("150000"), 150_000);
  assert.equal(engineIdleCompactMinTokens(" 300000 "), 300_000);
  assert.equal(engineIdleCompactMinTokens("50000"), 100_000);
  assert.equal(engineIdleCompactMinTokens("1.5e5"), 200_000);
});

test("preColdEarliestMs: the earliest slot is 0.85 of the TTL (51 minutes of an hour)", () => {
  assert.equal(PRE_COLD_TTL_MS, HOUR);
  assert.equal(preColdEarliestMs(HOUR), 51 * MIN);
});

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

test("decidePreCold: below the engine's zone it fires at 0.85 of the TTL", () => {
  assert.deepEqual(decidePreCold(DUE), { kind: "fire", slot: "early", engineZone: false });
  assert.deepEqual(decidePreCold({ ...DUE, idleMs: 51 * MIN }), { kind: "fire", slot: "early", engineZone: false });
});

test("decidePreCold: before its slot it waits for the rest, and a wait writes nothing", () => {
  assert.deepEqual(decidePreCold({ ...DUE, idleMs: 40 * MIN }), { kind: "wait", ms: 11 * MIN });
  assert.deepEqual(decidePreCold({ ...DUE, idleMs: 0 }), { kind: "wait", ms: 51 * MIN });
});

test("decidePreCold: below the threshold or with no usage it skips without a row", () => {
  assert.deepEqual(decidePreCold({ ...DUE, contextTokens: 119_999 }), { kind: "skip", reason: "below-threshold", log: false });
  assert.deepEqual(decidePreCold({ ...DUE, contextTokens: null }), { kind: "skip", reason: "below-threshold", log: false });
  // Not due yet and below the threshold: still nothing, never a wait.
  assert.deepEqual(decidePreCold({ ...DUE, contextTokens: 50_000, idleMs: 0 }), { kind: "skip", reason: "below-threshold", log: false });
});

test("decidePreCold: a TTL other than 1h skips (the engine and the 0.1x read only hold for the 1h cache)", () => {
  assert.deepEqual(decidePreCold({ ...DUE, ttlMs: 5 * MIN, idleMs: 4.5 * MIN }), { kind: "skip", reason: "ttl", log: true });
});

test("decidePreCold: a wake at or after 0.97 of the TTL is too late: the cache may be cold, so it skips", () => {
  assert.deepEqual(decidePreCold({ ...DUE, idleMs: 58.2 * MIN }), { kind: "skip", reason: "expired", log: true });
  assert.deepEqual(decidePreCold({ ...DUE, idleMs: 3 * HOUR }), { kind: "skip", reason: "expired", log: true });
  assert.equal(decidePreCold({ ...DUE, idleMs: 58 * MIN }).kind, "fire");
});

test("decidePreCold engine rule: in the zone with the engine seen in this account, it never fires", () => {
  const zone = { ...DUE, contextTokens: 190_000, engineSeen: true };
  assert.deepEqual(decidePreCold({ ...zone, idleMs: 56 * MIN }), { kind: "skip", reason: "engine-owns", log: true });
  // Not before the engine's slot either: it waits to its own slot and then stands down.
  assert.deepEqual(decidePreCold({ ...zone, idleMs: 52 * MIN }), { kind: "wait", ms: 55.8 * MIN - 52 * MIN });
  assert.deepEqual(decidePreCold({ ...zone, contextTokens: 400_000, idleMs: 57 * MIN }), { kind: "skip", reason: "engine-owns", log: true });
});

test("decidePreCold engine rule: in the zone with the engine never seen, it fires only after the engine's 0.9 slot (0.93)", () => {
  const zone = { ...DUE, contextTokens: 190_000 };
  assert.deepEqual(decidePreCold({ ...zone, idleMs: 52 * MIN }), { kind: "wait", ms: 55.8 * MIN - 52 * MIN });
  assert.equal(decidePreCold({ ...zone, idleMs: 54 * MIN }).kind, "wait", "never at the engine's own 0.9");
  assert.deepEqual(decidePreCold({ ...zone, idleMs: 55.8 * MIN }), { kind: "fire", slot: "after-engine", engineZone: true });
});

test("decidePreCold engine rule: the zone starts at 90% of the engine's minimum, the env override included", () => {
  assert.equal(decidePreCold({ ...DUE, contextTokens: 179_999 }).kind, "fire");
  assert.equal(decidePreCold({ ...DUE, contextTokens: 180_000 }).kind, "wait");
  const lowered = { ...DUE, engineMinTokens: 100_000, contextTokens: 125_000 };
  assert.deepEqual(decidePreCold({ ...lowered, engineSeen: true, idleMs: 56 * MIN }), { kind: "skip", reason: "engine-owns", log: true });
});

test("decidePreCold engine rule: an engine compaction seen since the timer was armed skips that wake, in or out of the zone", () => {
  assert.deepEqual(decidePreCold({ ...DUE, engineCompactedSinceIdle: true }), { kind: "skip", reason: "engine-compacted", log: true });
  assert.deepEqual(decidePreCold({ ...DUE, contextTokens: 190_000, idleMs: 56 * MIN, engineCompactedSinceIdle: true }), { kind: "skip", reason: "engine-compacted", log: true });
});

test("decidePreCold: the steward's cooldown and a confident mid-task for the last turn skip it", () => {
  assert.deepEqual(decidePreCold({ ...DUE, turnsSinceCompaction: 2 }), { kind: "skip", reason: "cooldown", log: true });
  assert.equal(decidePreCold({ ...DUE, turnsSinceCompaction: 3 }).kind, "fire");
  assert.deepEqual(decidePreCold({ ...DUE, judgment: { verdict: "mid-task", confidence: 0.8 } }), { kind: "skip", reason: "mid-task", log: true });
  assert.equal(decidePreCold({ ...DUE, judgment: { verdict: "mid-task", confidence: 0.79 } }).kind, "fire", "an unsure mid-task does not hold it");
  assert.equal(decidePreCold({ ...DUE, judgment: { verdict: "boundary", confidence: 0.95 } }).kind, "fire");
});

// ---------------------------------------------------------------------------
// Observing the engine, and the cost of a compaction
// ---------------------------------------------------------------------------

test("isEngineIdleCompaction: an auto compaction while idle for half the TTL, no turn running and no call of ours pending", () => {
  const idle = { trigger: "auto", turnRunning: false, ownCallPending: false, idleMs: 54 * MIN, ttlMs: HOUR };
  assert.equal(isEngineIdleCompaction(idle), true);
  assert.equal(isEngineIdleCompaction({ ...idle, idleMs: 30 * MIN }), true);
  assert.equal(isEngineIdleCompaction({ ...idle, trigger: "manual" }), false, "our own call reads manual");
  assert.equal(isEngineIdleCompaction({ ...idle, turnRunning: true }), false, "the engine's threshold compaction runs inside a turn");
  assert.equal(isEngineIdleCompaction({ ...idle, ownCallPending: true }), false);
  assert.equal(isEngineIdleCompaction({ ...idle, idleMs: 29 * MIN }), false);
  assert.equal(isEngineIdleCompaction({ ...idle, idleMs: null }), false, "never armed: not known idle");
});

test("preColdCompactCost: the compaction's own usage in input-token equivalents (read 0.1x, 1h write 2x, output 5x)", () => {
  // The probe's run: 7,972 input, 1,688 output, 31,945 read, 3 written.
  assert.equal(preColdCompactCost({ input_tokens: 7972, output_tokens: 1688, cache_read_input_tokens: 31945, cache_creation_input_tokens: 3 }), Math.round(7972 + 3194.5 + 6 + 8440));
  assert.equal(preColdCompactCost(undefined), null);
  assert.equal(preColdCompactCost({ input_tokens: 1 }), null);
  assert.equal(preColdCompactCost({ input_tokens: -1, output_tokens: 1, cache_read_input_tokens: 1, cache_creation_input_tokens: 1 }), null);
});

// ---------------------------------------------------------------------------
// The weekly summary, with "returned within 24 h"
// ---------------------------------------------------------------------------

const NOW = Date.parse("2026-10-12T12:00:00.000Z");
const WEEK = 7 * 24 * HOUR;
const iso = (ms: number): string => new Date(ms).toISOString();

function fireRow(atMs: number, sessionId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { at: iso(atMs), trigger: "pre-cold", decision: "pre-cold", compact: true, applied: false, mode: "measure", wouldFire: "pre-cold", contextBefore: 150_000, sessionId, ...extra };
}

function step(atMs: number, sessionId: string, cacheWrite: number): Record<string, unknown> {
  return { at: iso(atMs), agent: "main", sessionId, input: 10, cacheRead: 0, cacheWrite };
}

test("summarizePreCold: null when the window holds no pre-cold row", () => {
  assert.equal(summarizePreCold([], [], NOW, WEEK), null);
  assert.equal(summarizePreCold([{ at: iso(NOW - HOUR), decision: "boundary", compact: true, applied: true }], [], NOW, WEEK), null);
});

test("summarizePreCold: measured fires, returned within 24 h from the session's next main step, and the cold rewrite they would have avoided", () => {
  assert.equal(PRE_COLD_RETURN_WINDOW_MS, 24 * HOUR);
  const rows = [
    fireRow(NOW - 50 * HOUR, "s-back"),
    fireRow(NOW - 40 * HOUR, "s-gone"),
    fireRow(NOW - 2 * HOUR, "s-pending"),
    fireRow(NOW - 30 * HOUR, "s-late"),
    { at: iso(NOW - 3 * HOUR), trigger: "pre-cold", decision: "pre-cold-skip", compact: false, applied: false, mode: "measure", coldSkip: "engine-owns", sessionId: "s-x" },
    { at: iso(NOW - 3 * HOUR), event: "engine-idle-compact", sessionId: "s-y" },
    fireRow(NOW - 9 * 24 * HOUR, "s-old"),
  ];
  const usage = [
    step(NOW - 51 * HOUR, "s-back", 500),
    step(NOW - 45 * HOUR, "s-back", 140_000),
    step(NOW - 44 * HOUR, "s-back", 2_000),
    step(NOW - 30 * HOUR + 25 * HOUR, "s-late", 150_000),
    step(NOW - 41 * HOUR, "s-gone", 1_000),
  ];
  const summary = summarizePreCold(rows, usage, NOW, WEEK);
  assert.deepEqual(summary, {
    fired: 0,
    wouldFire: 4,
    skipped: 1,
    returned: 1,
    notReturned: 2,
    pending: 1,
    coldRewriteOnReturn: 140_000,
    realizedSaving: null,
    waste: null,
    engineIdleCompactions: 1,
  });
});

test("summarizePreCold: an applied fire that came back saves 2x the write it avoided less its cost; one nobody resumed is waste", () => {
  const rows = [
    fireRow(NOW - 50 * HOUR, "s-back", { applied: true, mode: "active", wouldFire: null, contextBefore: 150_000, compactCost: 20_000 }),
    fireRow(NOW - 40 * HOUR, "s-gone", { applied: true, mode: "active", wouldFire: null, contextBefore: 160_000, compactCost: 22_000 }),
    fireRow(NOW - 30 * HOUR, "s-unknown", { applied: true, mode: "active", wouldFire: null, contextBefore: 160_000, compactCost: null }),
    // Not applied (headless): neither fired nor would fire.
    fireRow(NOW - 20 * HOUR, "s-headless", { applied: false, mode: "active", wouldFire: null, notApplied: "headless" }),
  ];
  const usage = [step(NOW - 45 * HOUR, "s-back", 10_000)];
  const summary = summarizePreCold(rows, usage, NOW, WEEK);
  assert.ok(summary);
  assert.equal(summary.fired, 3);
  assert.equal(summary.wouldFire, 0);
  assert.equal(summary.returned, 1);
  assert.equal(summary.notReturned, 2);
  assert.equal(summary.realizedSaving, 2 * (150_000 - 10_000) - 20_000);
  assert.equal(summary.waste, 22_000, "a fire whose cost is unknown adds nothing");
  assert.equal(summary.coldRewriteOnReturn, null);
});

test("summarizePreCold: malformed rows are skipped, never thrown on", () => {
  const rows: unknown[] = [null, 3, "x", { at: "not a date", trigger: "pre-cold", decision: "pre-cold", compact: true }, fireRow(NOW - HOUR, "s-1")];
  const summary = summarizePreCold(rows, [null, { at: 5 }, { agent: "main" }], NOW, WEEK);
  assert.equal(summary?.wouldFire, 1);
  assert.equal(summary?.pending, 1);
});
