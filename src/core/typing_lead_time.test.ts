// Typing lead time (odd/tasks/typing-lead-time.md, K0a): the pure rules behind
// the measure of how long a person pauses between their last keystroke and
// sending a prompt. The hook wiring is covered in
// adapters/claude/mod-skills/hooks.test.ts.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  EMPTY_TYPING_DRAFT,
  TYPING_FILE_PATTERN,
  TYPING_WINDOW_MS,
  noteTypingEdit,
  summarizeTypingLeadTime,
  typingAtSubmit,
  typingFileName,
  typingRecord,
} from "./typing_lead_time.ts";

const NOW = Date.parse("2026-10-12T12:00:00.000Z");

test("the module is pure: no node: import, so the mod sandbox can load it", () => {
  const source = readFileSync(new URL("./typing_lead_time.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from "node:/);
});

// ---------------------------------------------------------------------------
// The tracker: one record per session's draft
// ---------------------------------------------------------------------------

test("tracker: an empty draft has no edit and no time", () => {
  assert.deepEqual(EMPTY_TYPING_DRAFT, { edits: 0, lastEditAt: null });
});

test("tracker: each edit counts once and keeps its time", () => {
  const one = noteTypingEdit(undefined, 1000);
  assert.deepEqual(one, { edits: 1, lastEditAt: 1000 });
  const two = noteTypingEdit(one, 1200);
  assert.deepEqual(two, { edits: 2, lastEditAt: 1200 });
});

test("tracker: an update that lands out of order keeps the latest edit time", () => {
  const late = noteTypingEdit(noteTypingEdit(undefined, 1500), 1200);
  assert.deepEqual(late, { edits: 2, lastEditAt: 1500 });
});

// ---------------------------------------------------------------------------
// At submit: the gap, the edits and the kind
// ---------------------------------------------------------------------------

test("submit: a composer prompt with edits is typed, with the gap since the last edit", () => {
  const draft = noteTypingEdit(noteTypingEdit(undefined, 1000), 1400);
  assert.deepEqual(typingAtSubmit("composer", draft, 2150), { kind: "composer", gapMs: 750, edits: 2 });
});

test("submit: a clock that went backwards reads as no gap, never a negative one", () => {
  const draft = noteTypingEdit(undefined, 3000);
  assert.deepEqual(typingAtSubmit("composer", draft, 2000), { kind: "composer", gapMs: 0, edits: 1 });
});

test("submit: a composer prompt with no edit seen is injected, never a 0 ms gap", () => {
  assert.deepEqual(typingAtSubmit("composer", undefined, 2000), { kind: "injected", gapMs: null, edits: 0 });
  assert.deepEqual(typingAtSubmit("composer", EMPTY_TYPING_DRAFT, 2000), { kind: "injected", gapMs: null, edits: 0 });
});

test("submit: any other origin is injected, and the draft being typed is not read", () => {
  const draft = noteTypingEdit(undefined, 1000);
  for (const origin of ["task-notification", "peer", "plugin", "sdk", "unclassified"]) {
    assert.deepEqual(typingAtSubmit(origin, draft, 2000), { kind: "injected", gapMs: null, edits: 0 }, origin);
  }
});

// ---------------------------------------------------------------------------
// The row and its file
// ---------------------------------------------------------------------------

test("row: carries when, which session, the origin and the measure, never the prompt", () => {
  const record = typingRecord({ at: "2026-10-12T11:59:00.000Z", sessionId: "s-1", origin: "composer", typing: { kind: "composer", gapMs: 750, edits: 2 } });
  assert.deepEqual(record, { type: "typing", at: "2026-10-12T11:59:00.000Z", sessionId: "s-1", origin: "composer", kind: "composer", gapMs: 750, edits: 2 });
});

test("file: one file per UTC hour, and the pattern captures that hour", () => {
  assert.equal(typingFileName("2026-10-12T11:59:00.000Z"), "typing-2026-10-12T11.jsonl");
  assert.equal(TYPING_FILE_PATTERN.exec("typing-2026-10-12T11.jsonl")?.[1], "2026-10-12T11");
  assert.equal(TYPING_FILE_PATTERN.test("typing-2026-10-12.jsonl"), false);
  assert.equal(TYPING_FILE_PATTERN.test("mod-skills-measurements-2026-10-12T11.jsonl"), false);
});

// ---------------------------------------------------------------------------
// The 7-day summary the board reads
// ---------------------------------------------------------------------------

function row(minutesAgo: number, kind: "composer" | "injected", gapMs: number | null, edits = kind === "composer" ? 12 : 0): Record<string, unknown> {
  return { type: "typing", at: new Date(NOW - minutesAgo * 60_000).toISOString(), sessionId: "s", origin: kind === "composer" ? "composer" : "plugin", kind, gapMs, edits };
}

test("summary: the window is 7 days", () => {
  assert.equal(TYPING_WINDOW_MS, 7 * 24 * 60 * 60 * 1000);
});

test("summary: no row in the window is no summary, never zeros", () => {
  assert.equal(summarizeTypingLeadTime([], NOW, TYPING_WINDOW_MS), null);
  assert.equal(summarizeTypingLeadTime([row(8 * 24 * 60, "composer", 500)], NOW, TYPING_WINDOW_MS), null);
});

test("summary: p50 and p90 by nearest rank over typed prompts; injected ones are counted apart", () => {
  const rows = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000].map((gap, i) => row(i + 1, "composer", gap));
  rows.push(row(3, "injected", null), row(4, "injected", null));
  assert.deepEqual(summarizeTypingLeadTime(rows, NOW, TYPING_WINDOW_MS), { typed: 10, injected: 2, p50Ms: 500, p90Ms: 900 });
});

test("summary: only injected rows give counts and no percentile", () => {
  assert.deepEqual(summarizeTypingLeadTime([row(1, "injected", null)], NOW, TYPING_WINDOW_MS), { typed: 0, injected: 1, p50Ms: null, p90Ms: null });
});

test("summary: rows outside the window, in the future, or malformed are skipped", () => {
  const rows: unknown[] = [
    row(1, "composer", 400),
    row(7 * 24 * 60 + 1, "composer", 99_000),
    row(-5, "composer", 99_000),
    { type: "typing", at: "not a date", kind: "composer", gapMs: 1, edits: 1 },
    { type: "typing", at: new Date(NOW).toISOString(), kind: "composer", gapMs: -3, edits: 1 },
    { type: "typing", at: new Date(NOW).toISOString(), kind: "composer", gapMs: "5", edits: 1 },
    { type: "typing", at: new Date(NOW).toISOString(), kind: "other", gapMs: null, edits: 0 },
    { type: "decision", at: new Date(NOW).toISOString(), kind: "composer", gapMs: 5, edits: 1 },
    "a string",
    null,
  ];
  assert.deepEqual(summarizeTypingLeadTime(rows, NOW, TYPING_WINDOW_MS), { typed: 1, injected: 0, p50Ms: 400, p90Ms: 400 });
});
