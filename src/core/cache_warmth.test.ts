import assert from "node:assert/strict";
import test from "node:test";

import { CACHE_TTL_1H_MS, CACHE_TTL_5M_MS, cacheWarm, cacheWarmth, parseCacheClock, readCacheTail } from "./cache_warmth.ts";

const AT = "2026-10-12T10:00:00.000Z";
const AT_MS = Date.parse(AT);

function assistantRow(fields: { timestamp?: string; isSidechain?: boolean; usage?: unknown }): string {
  return JSON.stringify({ type: "assistant", timestamp: fields.timestamp ?? AT, isSidechain: fields.isSidechain ?? false, message: { role: "assistant", ...(fields.usage === undefined ? {} : { usage: fields.usage }) } });
}

function usage(oneHour: number, fiveMinutes: number): unknown {
  return { input_tokens: 3, cache_read_input_tokens: 1000, cache_creation_input_tokens: oneHour + fiveMinutes, cache_creation: { ephemeral_1h_input_tokens: oneHour, ephemeral_5m_input_tokens: fiveMinutes }, output_tokens: 10 };
}

test("a main row that wrote the 1h bucket reads a 1h TTL and its own time", () => {
  const tail = [JSON.stringify({ type: "user", timestamp: AT }), assistantRow({ usage: usage(500, 0) })].join("\n");
  assert.deepEqual(readCacheTail(tail), { ttlMs: CACHE_TTL_1H_MS, lastMainAt: AT_MS });
});

test("a main row that wrote the 5m bucket reads a 5m TTL", () => {
  assert.deepEqual(readCacheTail(assistantRow({ usage: usage(0, 500) })), { ttlMs: CACHE_TTL_5M_MS, lastMainAt: AT_MS });
});

test("the newest main row decides; a pure cache read looks further back for the bucket", () => {
  const later = "2026-10-12T10:05:00.000Z";
  const tail = [assistantRow({ usage: usage(0, 500) }), assistantRow({ timestamp: later, usage: usage(0, 0) })].join("\n");
  assert.deepEqual(readCacheTail(tail), { ttlMs: CACHE_TTL_5M_MS, lastMainAt: Date.parse(later) });
});

test("a subagent (sidechain) row is never the main thread's", () => {
  const later = "2026-10-12T10:05:00.000Z";
  const tail = [assistantRow({ usage: usage(500, 0) }), assistantRow({ timestamp: later, isSidechain: true, usage: usage(0, 500) })].join("\n");
  assert.deepEqual(readCacheTail(tail), { ttlMs: CACHE_TTL_1H_MS, lastMainAt: AT_MS });
});

test("missing usage is unknown, never a guessed TTL", () => {
  assert.deepEqual(readCacheTail(assistantRow({})), { ttlMs: null, lastMainAt: AT_MS });
  assert.deepEqual(readCacheTail(""), { ttlMs: null, lastMainAt: null });
});

test("a malformed row is skipped, and the rows around it still read", () => {
  const tail = [assistantRow({ usage: usage(500, 0) }), '{"type":"assistant","message":{"usage":{"cache_creation"', "not json at all"].join("\n");
  assert.deepEqual(readCacheTail(tail), { ttlMs: CACHE_TTL_1H_MS, lastMainAt: AT_MS });
});

test("a row with an unreadable timestamp gives no time, but its bucket still counts", () => {
  assert.deepEqual(readCacheTail(assistantRow({ timestamp: "yesterday", usage: usage(500, 0) })), { ttlMs: CACHE_TTL_1H_MS, lastMainAt: null });
});

test("cacheWarm: warm while now - last < ttl, cold from the TTL on", () => {
  const clock = { ttlMs: CACHE_TTL_5M_MS, lastMainAt: AT_MS };
  assert.equal(cacheWarm(clock, AT_MS + CACHE_TTL_5M_MS - 1), true);
  assert.equal(cacheWarm(clock, AT_MS + CACHE_TTL_5M_MS), false);
  assert.equal(cacheWarmth(clock, AT_MS + CACHE_TTL_5M_MS), false);
  assert.equal(cacheWarm({ ttlMs: CACHE_TTL_1H_MS, lastMainAt: AT_MS }, AT_MS + CACHE_TTL_5M_MS), true);
});

test("unknown is warm: no TTL or no last request keeps today's behaviour", () => {
  const late = AT_MS + 10 * CACHE_TTL_1H_MS;
  assert.equal(cacheWarmth({ ttlMs: null, lastMainAt: AT_MS }, late), null);
  assert.equal(cacheWarmth({ ttlMs: CACHE_TTL_1H_MS, lastMainAt: null }, late), null);
  assert.equal(cacheWarm({ ttlMs: null, lastMainAt: AT_MS }, late), true);
  assert.equal(cacheWarm({ ttlMs: CACHE_TTL_1H_MS, lastMainAt: null }, late), true);
});

test("parseCacheClock keeps only finite numbers, else unknown", () => {
  assert.deepEqual(parseCacheClock({ ttlMs: CACHE_TTL_1H_MS, lastMainAt: AT_MS }), { ttlMs: CACHE_TTL_1H_MS, lastMainAt: AT_MS });
  assert.deepEqual(parseCacheClock({ ttlMs: "1h", lastMainAt: Number.NaN }), { ttlMs: null, lastMainAt: null });
  assert.deepEqual(parseCacheClock(undefined), { ttlMs: null, lastMainAt: null });
});
