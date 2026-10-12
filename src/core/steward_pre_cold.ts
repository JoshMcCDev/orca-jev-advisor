// ---------------------------------------------------------------------------
// The context steward's pre-cold tier (track S, odd/tasks/steward-pre-cold.md).
//
// An idle session's prompt cache expires after its TTL; the next prompt then
// re-writes the whole context cold, at twice the input price. Shortly before
// that, while the cache is still warm (a read at 0.1x), the steward compacts a
// large idle session, so a return writes a small context instead.
//
// The engine has its own idle compaction (`compact_sleep`, at 0.9 of a 1h TTL,
// above its `minTokens`, behind a server flag). This tier only acts where the
// engine will not; the rule is written out in the task file and enforced by
// `decidePreCold`.
//
// Pure: the hooks module arms the timer, reads the usage, compacts and logs.
// Named apart from track R's `cache_warmth.ts` (the TTL reader) on purpose.
// ---------------------------------------------------------------------------

import { isRecord } from "../guards.ts";
import { SOFT_MID_TASK_FLOOR, STEWARD_COOLDOWN_TURNS } from "./context_steward.ts";
import type { StewardMode, StewardVerdict } from "./context_steward.ts";

export type StewardColdMode = "off" | "measure" | "active";
export const STEWARD_COLD_MODES: readonly StewardColdMode[] = ["off", "measure", "active"];
export const DEFAULT_STEWARD_COLD_MODE: StewardColdMode = "measure";

export function parseStewardColdMode(value: unknown): StewardColdMode {
  return typeof value === "string" && (STEWARD_COLD_MODES as readonly string[]).includes(value) ? (value as StewardColdMode) : DEFAULT_STEWARD_COLD_MODE;
}

/** The tier's own mode from the steward's and the cold switch: off when either is off, active only when both are. */
export function preColdMode(stewardMode: StewardMode, coldMode: StewardColdMode): StewardColdMode {
  if (stewardMode === "off" || coldMode === "off") return "off";
  return stewardMode === "active" && coldMode === "active" ? "active" : "measure";
}

/**
 * The cache TTL the tier assumes: 29,082 of 29,085 main responses in a week
 * wrote the 1h bucket. Track R reads it from the transcript tail
 * (`cache_warmth.ts`); once both are merged that reading can feed
 * `decidePreCold`, which already takes the TTL as an input.
 */
export const PRE_COLD_TTL_MS = 3_600_000;
/** Below the engine's zone the tier fires here (51 min of 60), leaving room for the compaction to finish warm. */
export const PRE_COLD_EARLY_SLOT = 0.85;
/** The engine's own idle compaction fires at this share of the TTL. */
export const ENGINE_IDLE_COMPACT_SLOT = 0.9;
/** In the engine's zone, with the engine never seen, the tier fires only here: after the engine's slot, never before it. */
export const PRE_COLD_AFTER_ENGINE_SLOT = 0.93;
/** A wake at or after this share of the TTL is too late: the cache may already be cold. */
export const PRE_COLD_CUTOFF = 0.97;
export const ENGINE_IDLE_COMPACT_DEFAULT_MIN_TOKENS = 200_000;
export const ENGINE_IDLE_COMPACT_FLOOR_TOKENS = 100_000;
/** The engine's zone starts at this share of its minimum: room for a token count that differs from ours near the edge. */
export const ENGINE_ZONE_SHARE = 0.9;
/** A wake that is not yet due re-arms for the rest, at most this many wakes in all. */
export const PRE_COLD_MAX_WAKES = 3;
/** "Returned": a main step of the same session within this time after the fire. */
export const PRE_COLD_RETURN_WINDOW_MS = 24 * 3_600_000;
/** An engine compaction counts as its idle one only after at least this share of the TTL idle. */
export const ENGINE_IDLE_OBSERVE_SHARE = 0.5;

/** The engine's `minTokens`: the env override `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS` when a whole number, else 200k; never under the 100k floor. */
export function engineIdleCompactMinTokens(env: string | undefined): number {
  const text = env?.trim() ?? "";
  if (!/^\d+$/.test(text)) return ENGINE_IDLE_COMPACT_DEFAULT_MIN_TOKENS;
  return Math.max(Number(text), ENGINE_IDLE_COMPACT_FLOOR_TOKENS);
}

/** The earliest the tier can fire: no wake before it needs any reading. */
export function preColdEarliestMs(ttlMs: number): number {
  return Math.round(ttlMs * PRE_COLD_EARLY_SLOT);
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

export type PreColdSkipReason = "ttl" | "below-threshold" | "expired" | "engine-compacted" | "engine-owns" | "cooldown" | "mid-task";

export interface PreColdJudgment {
  readonly verdict: StewardVerdict;
  readonly confidence: number;
}

export interface PreColdInput {
  /** The live context; null before any response reported one. */
  readonly contextTokens: number | null;
  readonly threshold: number;
  readonly ttlMs: number;
  /** Time since the last main turn ended. */
  readonly idleMs: number;
  readonly engineMinTokens: number;
  /** Whether the engine's idle compaction was ever observed in this account. */
  readonly engineSeen: boolean;
  /** Whether an auto compaction began or ended since the timer was armed. */
  readonly engineCompactedSinceIdle: boolean;
  /** Person turns since the steward's last compaction; null when none. */
  readonly turnsSinceCompaction: number | null;
  /** The turn-end steward's verdict on the last turn, or null when it gave none. */
  readonly judgment: PreColdJudgment | null;
}

export type PreColdDecision =
  | { readonly kind: "fire"; readonly slot: "early" | "after-engine"; readonly engineZone: boolean }
  | { readonly kind: "wait"; readonly ms: number }
  | { readonly kind: "skip"; readonly reason: PreColdSkipReason; readonly log: boolean };

/**
 * Fire, wait or skip, in this order: the threshold (silent), the TTL, the
 * slot (wait), too late, an engine compaction since the timer was armed, the
 * engine's zone once the engine is known, the cooldown, a confident mid-task.
 * A skip worth a row says so (`log`).
 */
export function decidePreCold(input: PreColdInput): PreColdDecision {
  if (input.contextTokens === null || input.contextTokens < input.threshold) return { kind: "skip", reason: "below-threshold", log: false };
  if (input.ttlMs !== PRE_COLD_TTL_MS) return { kind: "skip", reason: "ttl", log: true };
  const engineZone = input.contextTokens >= input.engineMinTokens * ENGINE_ZONE_SHARE;
  const slotMs = Math.round(input.ttlMs * (engineZone ? PRE_COLD_AFTER_ENGINE_SLOT : PRE_COLD_EARLY_SLOT));
  if (input.idleMs < slotMs) return { kind: "wait", ms: slotMs - input.idleMs };
  if (input.idleMs >= input.ttlMs * PRE_COLD_CUTOFF) return { kind: "skip", reason: "expired", log: true };
  if (input.engineCompactedSinceIdle) return { kind: "skip", reason: "engine-compacted", log: true };
  if (engineZone && input.engineSeen) return { kind: "skip", reason: "engine-owns", log: true };
  if (input.turnsSinceCompaction !== null && input.turnsSinceCompaction < STEWARD_COOLDOWN_TURNS) return { kind: "skip", reason: "cooldown", log: true };
  if (input.judgment !== null && input.judgment.verdict === "mid-task" && input.judgment.confidence >= SOFT_MID_TASK_FLOOR) return { kind: "skip", reason: "mid-task", log: true };
  return { kind: "fire", slot: engineZone ? "after-engine" : "early", engineZone };
}

export interface EngineCompactionInput {
  /** The classic PreCompact/PostCompact `trigger`. */
  readonly trigger: string;
  readonly turnRunning: boolean;
  /** A pre-cold call of ours is running (its classic events read `manual`, but never trust that alone). */
  readonly ownCallPending: boolean;
  /** Time since the last main turn ended; null when no turn has ended in this load. */
  readonly idleMs: number | null;
  readonly ttlMs: number;
}

/** Whether a compaction is the engine's idle one: `auto`, between turns, not ours, after at least half the TTL idle. */
export function isEngineIdleCompaction(input: EngineCompactionInput): boolean {
  if (input.trigger !== "auto" || input.turnRunning || input.ownCallPending || input.idleMs === null) return false;
  return input.idleMs >= input.ttlMs * ENGINE_IDLE_OBSERVE_SHARE;
}

// ---------------------------------------------------------------------------
// Cost and the weekly summary
// ---------------------------------------------------------------------------

/** Price weights against the input price: a cache read, a 1h cache write, an output token. */
export const CACHE_READ_WEIGHT = 0.1;
export const CACHE_WRITE_1H_WEIGHT = 2;
export const OUTPUT_WEIGHT = 5;

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** A compaction's own usage (`SessionCompacted.usage`) in input-token equivalents; null when any part is missing. */
export function preColdCompactCost(usage: unknown): number | null {
  if (!isRecord(usage)) return null;
  const input = count(usage.input_tokens);
  const output = count(usage.output_tokens);
  const read = count(usage.cache_read_input_tokens);
  const write = count(usage.cache_creation_input_tokens);
  if (input === null || output === null || read === null || write === null) return null;
  return Math.round(input + CACHE_READ_WEIGHT * read + CACHE_WRITE_1H_WEIGHT * write + OUTPUT_WEIGHT * output);
}

export interface PreColdSummary {
  /** Pre-cold compactions active mode made. */
  readonly fired: number;
  /** Ones measure mode would have made. */
  readonly wouldFire: number;
  /** Due wakes that stood down (engine, cooldown, mid-task, too late). */
  readonly skipped: number;
  /** Fired or would-fire sessions with a main step within 24 h after. */
  readonly returned: number;
  /** Ones with none, older than 24 h. */
  readonly notReturned: number;
  /** Ones younger than 24 h with no return yet. */
  readonly pending: number;
  /** Measured: the cache write of the first returning step after a would-fire, the cold rewrite active mode would have avoided; null with none. */
  readonly coldRewriteOnReturn: number | null;
  /** Input-token equivalents: 2x the write each returned applied fire avoided, less its cost; null with none of known cost. */
  readonly realizedSaving: number | null;
  /** Input-token equivalents: the cost of applied fires nobody resumed in 24 h; null with none of known cost. */
  readonly waste: number | null;
  /** Engine idle compactions observed. */
  readonly engineIdleCompactions: number;
}

interface ReturnStep {
  readonly atMs: number;
  readonly cacheWrite: number;
}

function mainStepsBySession(usageRows: readonly unknown[]): Map<string, ReturnStep[]> {
  const bySession = new Map<string, ReturnStep[]>();
  for (const row of usageRows) {
    if (!isRecord(row) || row.agent !== "main" || typeof row.at !== "string" || typeof row.sessionId !== "string") continue;
    const atMs = Date.parse(row.at);
    const cacheWrite = count(row.cacheWrite);
    if (Number.isNaN(atMs) || cacheWrite === null) continue;
    const steps = bySession.get(row.sessionId) ?? [];
    steps.push({ atMs, cacheWrite });
    bySession.set(row.sessionId, steps);
  }
  for (const steps of bySession.values()) steps.sort((a, b) => a.atMs - b.atMs);
  return bySession;
}

/**
 * What the pre-cold tier did over the `windowMs` before `nowMs`, with the
 * "returned within 24 h" accounting joined from the router's main steps
 * (`turn-usage-*.jsonl`) by session and time, as `verifyStewardSaving` does.
 * Rows are parsed tolerantly. null when the window holds no pre-cold row.
 */
export function summarizePreCold(stewardRows: readonly unknown[], usageRows: readonly unknown[], nowMs: number, windowMs: number, returnWindowMs: number = PRE_COLD_RETURN_WINDOW_MS): PreColdSummary | null {
  const steps = mainStepsBySession(usageRows);
  let rows = 0;
  let fired = 0;
  let wouldFire = 0;
  let skipped = 0;
  let returned = 0;
  let notReturned = 0;
  let pending = 0;
  let coldRewrite: number | null = null;
  let saving: number | null = null;
  let waste: number | null = null;
  let engineIdleCompactions = 0;
  for (const row of stewardRows) {
    if (!isRecord(row) || typeof row.at !== "string") continue;
    const atMs = Date.parse(row.at);
    if (Number.isNaN(atMs) || atMs > nowMs || atMs < nowMs - windowMs) continue;
    if (row.event === "engine-idle-compact") {
      engineIdleCompactions += 1;
      continue;
    }
    if (row.trigger !== "pre-cold") continue;
    rows += 1;
    if (row.decision === "pre-cold-skip") {
      skipped += 1;
      continue;
    }
    const applied = row.applied === true;
    if (!applied && row.wouldFire !== "pre-cold") continue;
    if (applied) fired += 1;
    else wouldFire += 1;
    const sessionId = typeof row.sessionId === "string" ? row.sessionId : null;
    const back = sessionId === null ? undefined : (steps.get(sessionId) ?? []).find((step) => step.atMs > atMs && step.atMs <= atMs + returnWindowMs);
    const cost = count(row.compactCost);
    if (back !== undefined) {
      returned += 1;
      if (!applied) coldRewrite = (coldRewrite ?? 0) + back.cacheWrite;
      const before = count(row.contextBefore);
      if (applied && cost !== null && before !== null) saving = (saving ?? 0) + CACHE_WRITE_1H_WEIGHT * Math.max(0, before - back.cacheWrite) - cost;
    } else if (atMs + returnWindowMs <= nowMs) {
      notReturned += 1;
      if (applied && cost !== null) waste = (waste ?? 0) + cost;
    } else {
      pending += 1;
    }
  }
  if (rows === 0 && engineIdleCompactions === 0) return null;
  return { fired, wouldFire, skipped, returned, notReturned, pending, coldRewriteOnReturn: coldRewrite, realizedSaving: saving, waste, engineIdleCompactions };
}
