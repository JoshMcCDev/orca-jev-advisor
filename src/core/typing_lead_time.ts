// Typing lead time (odd/tasks/typing-lead-time.md, track K0): how long a
// person pauses between the last keystroke of a prompt and sending it, and how
// many edits the prompt had. It decides whether the skill score could be
// worked out while the person types (track K) instead of at `prompt.submit`.
//
// Engine facts (odd/research/engine-probes-2.1.296.md, g): `prompt.edit` fires
// once per keystroke, only in the interactive composer; a paste is one edit.
// A prompt that reaches the session without the composer has no edits, so it
// is counted apart as `injected`, never as a 0 ms gap.
//
// Pure: no I/O and no `node:` import, so the mod sandbox can load it.

import { isRecord } from "../guards.ts";
import { percentile } from "./module_cost.ts";

/** One session's draft so far: how many edits, and when the latest one was made (epoch ms). */
export interface TypingDraft {
  readonly edits: number;
  readonly lastEditAt: number | null;
}

export const EMPTY_TYPING_DRAFT: TypingDraft = { edits: 0, lastEditAt: null };

/** The draft after one more edit at `atMs`. Updates may land out of order, so the latest time wins. */
export function noteTypingEdit(draft: TypingDraft | undefined, atMs: number): TypingDraft {
  const before = draft ?? EMPTY_TYPING_DRAFT;
  return { edits: before.edits + 1, lastEditAt: before.lastEditAt === null ? atMs : Math.max(before.lastEditAt, atMs) };
}

export type TypingKind = "composer" | "injected";

/** What a submission says about typing: `gapMs` is null exactly when `kind` is `injected`. */
export interface TypingAtSubmit {
  readonly kind: TypingKind;
  readonly gapMs: number | null;
  readonly edits: number;
}

const INJECTED: TypingAtSubmit = { kind: "injected", gapMs: null, edits: 0 };

/**
 * The measure for one submission. Only the person's own Enter at the composer
 * reads the draft; any other origin (a notification, a peer, a plugin) is
 * injected and leaves the draft alone. A composer submission with no edit seen
 * is injected too: there was no typing to measure.
 */
export function typingAtSubmit(originKind: string, draft: TypingDraft | undefined, submittedAtMs: number): TypingAtSubmit {
  if (originKind !== "composer" || draft === undefined || draft.edits === 0 || draft.lastEditAt === null) return INJECTED;
  return { kind: "composer", gapMs: Math.max(0, submittedAtMs - draft.lastEditAt), edits: draft.edits };
}

/** One row of `typing-<hour>.jsonl`. Never the prompt's text. */
export interface TypingRecord {
  readonly type: "typing";
  readonly at: string;
  readonly sessionId: string | null;
  readonly origin: string;
  readonly kind: TypingKind;
  readonly gapMs: number | null;
  readonly edits: number;
}

export function typingRecord(input: { readonly at: string; readonly sessionId: string | null; readonly origin: string; readonly typing: TypingAtSubmit }): TypingRecord {
  return { type: "typing", at: input.at, sessionId: input.sessionId, origin: input.origin, kind: input.typing.kind, gapMs: input.typing.gapMs, edits: input.typing.edits };
}

/** The hourly typing logs, the hour captured: listed, read and pruned like the other hourly logs. */
export const TYPING_FILE_PATTERN = /^typing-(\d{4}-\d{2}-\d{2}T\d{2})\.jsonl$/;

/** `typing-YYYY-MM-DDTHH.jsonl` for the UTC hour `atIso` falls in. */
export function typingFileName(atIso: string): string {
  return `typing-${atIso.slice(0, 13)}.jsonl`;
}

export const TYPING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** The board's line: typed prompts with their gap percentiles, and injected prompts counted apart. */
export interface TypingLeadTimeSummary {
  readonly typed: number;
  readonly injected: number;
  readonly p50Ms: number | null;
  readonly p90Ms: number | null;
}

/** Rows within `windowMs` before `nowMs`; null when there is none, so "no data" never reads as zero. Malformed rows are skipped. */
export function summarizeTypingLeadTime(rows: readonly unknown[], nowMs: number, windowMs: number): TypingLeadTimeSummary | null {
  const gaps: number[] = [];
  let injected = 0;
  for (const row of rows) {
    if (!isRecord(row) || row.type !== "typing" || typeof row.at !== "string") continue;
    const atMs = Date.parse(row.at);
    if (Number.isNaN(atMs) || atMs > nowMs || atMs < nowMs - windowMs) continue;
    if (row.kind === "injected") injected += 1;
    else if (row.kind === "composer" && typeof row.gapMs === "number" && Number.isFinite(row.gapMs) && row.gapMs >= 0) gaps.push(row.gapMs);
  }
  if (gaps.length === 0 && injected === 0) return null;
  return { typed: gaps.length, injected, p50Ms: percentile(gaps, 50), p90Ms: percentile(gaps, 90) };
}
