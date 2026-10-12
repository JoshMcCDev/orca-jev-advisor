// ---------------------------------------------------------------------------
// Memory module in Shadow (odd/tasks/memory-shadow.md, M8).
//
// In Shadow the module decides, drafts on a sample and builds the judge, and
// writes nothing. This file holds what it measures:
//   - the row it logs per decision (`memory-decisions-<hour>.jsonl`), which
//     carries counts, types, outcomes and token usage, never memory content;
//   - the fork sample, a fixed 1 in 5 (a constant, never a setting);
//   - what the main thread itself saved in the same turn (Engram's mem_save
//     and mem_judge, a Write or Edit into the auto-memory folder), seen by
//     the `tool.call` hook after `next`, for agreement against the gate;
//   - the dry judge: prompts built, nothing asked;
//   - the weekly summary the Modules card shows.
//
// Pure: no I/O and no node: import, so the mod sandbox can load it too.
// ---------------------------------------------------------------------------

import { isRecord } from "../guards.ts";
import { MEMORY_TYPES, routeSave } from "./memory_decide.ts";
import type { MemoryType } from "./memory_decide.ts";
import type { MemoryBackendDecision } from "./memory_detect.ts";
import type { DraftSave, MemoryDraft } from "./memory_draft.ts";
import { buildJudgePrompt } from "./memory_judge.ts";
import { engramTypeOf } from "./memory_spool.ts";
import { parseFrontmatter } from "./memory_tidy.ts";

// ---------------------------------------------------------------------------
// The log file
// ---------------------------------------------------------------------------

export const MEMORY_DECISIONS_FILE_PATTERN = /^memory-decisions-(\d{4}-\d{2}-\d{2}T\d{2})\.jsonl$/;

/** `memory-decisions-YYYY-MM-DDTHH.jsonl` for the hour `atIso` falls in. */
export function memoryDecisionFileName(atIso: string): string {
  return `memory-decisions-${atIso.slice(0, 13)}.jsonl`;
}

// ---------------------------------------------------------------------------
// The fork sample
// ---------------------------------------------------------------------------

/**
 * In Shadow one UPDATE turn in this many is drafted. A fork re-reads the
 * whole session (a median 187k context, mods review 5.7), so the sample keeps
 * that quota cost bounded while still measuring what a draft holds. Fixed in
 * code and stated on the card; not a setting.
 */
export const FORK_SAMPLE_EVERY = 5;

/** FNV-1a, 32 bits: a stable spread of a short key. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** Whether this turn is in the fork sample: deterministic per session and turn, about one in FORK_SAMPLE_EVERY. */
export function isForkSampled(sessionId: string | null, turnId: string): boolean {
  return fnv1a(`${sessionId ?? ""}:${turnId}`) % FORK_SAMPLE_EVERY === 0;
}

// ---------------------------------------------------------------------------
// What the main thread saved
// ---------------------------------------------------------------------------

export type MainMemoryCall = "engram-save" | "engram-judge" | "auto-memory-write";

const ENGRAM_TOOL = /^mcp__(?:engram|plugin_engram_engram)__(mem_save|mem_judge)$/;
const FILE_WRITE_TOOLS: ReadonlySet<string> = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** Which memory call a main-thread tool call is, or null. A Write or Edit counts only for a `.md` directly in the memory dir. */
export function classifyMainCall(tool: string, args: Readonly<Record<string, unknown>>, autoMemoryDir: string | null): MainMemoryCall | null {
  const engram = ENGRAM_TOOL.exec(tool);
  if (engram !== null) return engram[1] === "mem_save" ? "engram-save" : "engram-judge";
  if (!FILE_WRITE_TOOLS.has(tool) || autoMemoryDir === null) return null;
  const path = args.file_path;
  if (typeof path !== "string") return null;
  const dir = `${autoMemoryDir.replace(/\/+$/, "")}/`;
  if (!path.startsWith(dir)) return null;
  const name = path.slice(dir.length);
  return !name.includes("/") && name.endsWith(".md") ? "auto-memory-write" : null;
}

/** A candidate of a `judgment_required` answer: its title and type, kept in memory for the dry judge and never logged. */
export interface SeenCandidate {
  readonly title: string;
  readonly type: string;
}

export interface MainMemorySeen {
  readonly engramSaves: number;
  /** Saves by the Engram type the main thread gave (`manual` when it gave none, as Engram does). */
  readonly engramSaveTypes: Readonly<Record<string, number>>;
  readonly judges: number;
  readonly autoMemoryWrites: number;
  readonly candidates: readonly SeenCandidate[];
}

export const EMPTY_SEEN: MainMemorySeen = { engramSaves: 0, engramSaveTypes: {}, judges: 0, autoMemoryWrites: 0, candidates: [] };

export interface MainCallDetail {
  /** mem_save's `type` argument. */
  readonly type?: unknown;
  readonly candidates?: readonly SeenCandidate[];
}

/** The seen counts with one more call. Returns a new value. */
export function noteMainCall(seen: MainMemorySeen, call: MainMemoryCall, detail: MainCallDetail): MainMemorySeen {
  if (call === "engram-judge") return { ...seen, judges: seen.judges + 1 };
  if (call === "auto-memory-write") return { ...seen, autoMemoryWrites: seen.autoMemoryWrites + 1 };
  const type = typeof detail.type === "string" && detail.type.trim() !== "" ? detail.type.trim() : "manual";
  return {
    ...seen,
    engramSaves: seen.engramSaves + 1,
    engramSaveTypes: { ...seen.engramSaveTypes, [type]: (seen.engramSaveTypes[type] ?? 0) + 1 },
    candidates: [...seen.candidates, ...(detail.candidates ?? [])],
  };
}

function envelopeText(result: unknown): string | null {
  if (typeof result === "string") return result;
  const blocks = Array.isArray(result) ? result : isRecord(result) && result.isError !== true && Array.isArray(result.content) ? result.content : [];
  for (const block of blocks) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") return block.text;
  }
  return null;
}

/**
 * The candidates of a main-thread `mem_save` answer (`judgment_required`), as
 * the tool result reaches `tool.call` after `next`: a string, the content
 * blocks, or the MCP `{ content, isError }`. Anything else is none.
 */
export function readMemSaveCandidates(result: unknown): readonly SeenCandidate[] {
  const text = envelopeText(result);
  if (text === null) return [];
  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch {
    return [];
  }
  if (!isRecord(envelope) || envelope.judgment_required !== true || !Array.isArray(envelope.candidates)) return [];
  return envelope.candidates.flatMap((entry) => (isRecord(entry) && typeof entry.title === "string" && typeof entry.type === "string" ? [{ title: entry.title, type: entry.type }] : []));
}

// ---------------------------------------------------------------------------
// Agreement, the draft and the dry judge
// ---------------------------------------------------------------------------

/** The gate's outcome: its two verdicts, an answer that is neither (malformed), or no answer at all. */
export type GateOutcome = "skip" | "update" | "malformed" | "no-answer";

export type Agreement = "both" | "module-only" | "main-only" | "neither" | "unknown";

/** The gate's verdict against whether the main thread saved anything (Engram or auto-memory) in the same turn. */
export function agreementOf(gate: GateOutcome, mainSaved: boolean): Agreement {
  if (gate === "update") return mainSaved ? "both" : "module-only";
  if (gate === "skip") return mainSaved ? "main-only" : "neither";
  return "unknown";
}

export interface DraftCounts {
  readonly wouldSave: Readonly<Record<MemoryType, number>>;
  readonly wouldUpdate: number;
  readonly wouldDelete: number;
  /** Saves that would go to Engram, now or on replay. */
  readonly toEngram: number;
  /** Saves that would also, or only, be an auto-memory file. */
  readonly toAutoMemory: number;
}

function zeroTypes(): Record<MemoryType, number> {
  return { user: 0, feedback: 0, project: 0, reference: 0 };
}

/** What a draft would have done on this backend, as counts. */
export function draftCounts(draft: MemoryDraft, backend: MemoryBackendDecision): DraftCounts {
  const wouldSave = zeroTypes();
  let toEngram = 0;
  let toAutoMemory = 0;
  for (const save of draft.saves) {
    wouldSave[save.type] += 1;
    const route = routeSave(save.type, backend);
    if (route.engram !== "never") toEngram += 1;
    if (route.autoMemory !== "none") toAutoMemory += 1;
  }
  return { wouldSave, wouldUpdate: draft.updates.length, wouldDelete: draft.deletes.length, toEngram, toAutoMemory };
}

/**
 * The dry judge: the judge prompt built for each drafted save against each
 * candidate the main thread's own mem_save surfaced this turn. In Shadow the
 * candidate's text cannot be fetched (only `mem_current_project` is called),
 * so its title stands for it. Nothing is asked: the count is what Active
 * would have sent to Haiku.
 */
export function dryJudgeBuilds(saves: readonly DraftSave[], candidates: readonly SeenCandidate[]): number {
  let builds = 0;
  for (const save of saves) {
    for (const candidate of candidates) {
      const prompt = buildJudgePrompt({ saved: { title: save.title, type: engramTypeOf(save.type), content: save.content }, candidate: { title: candidate.title, type: candidate.type, content: candidate.title } });
      if (prompt.length > 0) builds += 1;
    }
  }
  return builds;
}

/** The topic keys of the auto-memory files, sorted: what the fork reuses when Engram is the store. */
export function memoryTopics(files: Readonly<Record<string, string>>): string[] {
  const keys = new Set<string>();
  for (const text of Object.values(files)) {
    const key = parseFrontmatter(text).topicKey;
    if (key !== null) keys.add(key);
  }
  return [...keys].sort();
}

/** The memory files the fork reads, in name order: whole files only, at most `maxFiles` and `maxChars` in all; MEMORY.md is the index, not a memory. */
export function withinBudget(files: Readonly<Record<string, string>>, maxFiles: number, maxChars: number): Record<string, string> {
  const kept: Record<string, string> = {};
  let count = 0;
  let chars = 0;
  for (const name of Object.keys(files).sort()) {
    const text = files[name];
    if (text === undefined || name.toLowerCase() === "memory.md") continue;
    if (count >= maxFiles) break;
    if (chars + text.length > maxChars) continue;
    kept[name] = text;
    count += 1;
    chars += text.length;
  }
  return kept;
}

// ---------------------------------------------------------------------------
// The row
// ---------------------------------------------------------------------------

/** `$.model.complete`/`fork` usage, in the API's spelling. */
export interface ModelTokens {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_input_tokens: number;
  readonly cache_creation_input_tokens: number;
}

export interface RowTokens {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

/** The fork's outcome on an UPDATE turn: not in the sample, sampled but a new turn had started, a parsed draft, an answer that is not one, or no answer. */
export type ForkOutcome = "not-sampled" | "turn-moved-on" | "drafted" | "unparsable" | "no-answer";

export interface MemoryShadowRecordInput {
  readonly at: string;
  readonly account: string;
  readonly project: string;
  readonly sessionId: string | null;
  readonly backend: MemoryBackendDecision;
  /** Where the backend was decided: at session start, or re-detected at this turn. */
  readonly detectedAt: "start" | "turn";
  readonly gate: GateOutcome;
  readonly gateMs: number | null;
  readonly gateUsage: ModelTokens | null;
  /** Null when the gate did not say UPDATE. */
  readonly fork: ForkOutcome | null;
  readonly forkMs: number | null;
  readonly forkUsage: ModelTokens | null;
  readonly draft: DraftCounts | null;
  readonly judgeBuilds: number;
  readonly seen: MainMemorySeen;
}

export interface MemoryShadowRecord {
  readonly at: string;
  readonly account: string;
  readonly project: string;
  readonly mode: "shadow";
  readonly sessionId: string | null;
  readonly backend: MemoryBackendDecision["backend"];
  readonly decidedBy: MemoryBackendDecision["decidedBy"];
  readonly permission: MemoryBackendDecision["permission"];
  readonly detectedAt: "start" | "turn";
  readonly gate: GateOutcome;
  readonly gateMs: number | null;
  readonly gateTokens: RowTokens | null;
  readonly forkSampled: boolean;
  readonly fork: ForkOutcome | null;
  readonly forkMs: number | null;
  readonly forkTokens: RowTokens | null;
  readonly wouldSave: Readonly<Record<MemoryType, number>>;
  readonly wouldUpdate: number;
  readonly wouldDelete: number;
  readonly toEngram: number;
  readonly toAutoMemory: number;
  readonly judgeBuilds: number;
  readonly mainEngramSaves: number;
  readonly mainEngramSaveTypes: Readonly<Record<string, number>>;
  readonly mainJudges: number;
  readonly mainCandidates: number;
  readonly mainAutoMemoryWrites: number;
  readonly agreement: Agreement;
}

function rowTokens(usage: ModelTokens | null): RowTokens | null {
  if (usage === null) return null;
  return { input: usage.input_tokens, output: usage.output_tokens, cacheRead: usage.cache_read_input_tokens, cacheWrite: usage.cache_creation_input_tokens };
}

/** One log line: counts, types, outcomes and usage. No memory text, title or gate reason ever reaches it. */
export function memoryShadowRecord(input: MemoryShadowRecordInput): MemoryShadowRecord {
  const draft = input.draft;
  const seen = input.seen;
  return {
    at: input.at,
    account: input.account,
    project: input.project,
    mode: "shadow",
    sessionId: input.sessionId,
    backend: input.backend.backend,
    decidedBy: input.backend.decidedBy,
    permission: input.backend.permission,
    detectedAt: input.detectedAt,
    gate: input.gate,
    gateMs: input.gateMs,
    gateTokens: rowTokens(input.gateUsage),
    forkSampled: input.fork !== null && input.fork !== "not-sampled",
    fork: input.fork,
    forkMs: input.forkMs,
    forkTokens: rowTokens(input.forkUsage),
    wouldSave: draft === null ? zeroTypes() : { ...draft.wouldSave },
    wouldUpdate: draft === null ? 0 : draft.wouldUpdate,
    wouldDelete: draft === null ? 0 : draft.wouldDelete,
    toEngram: draft === null ? 0 : draft.toEngram,
    toAutoMemory: draft === null ? 0 : draft.toAutoMemory,
    judgeBuilds: input.judgeBuilds,
    mainEngramSaves: seen.engramSaves,
    mainEngramSaveTypes: { ...seen.engramSaveTypes },
    mainJudges: seen.judges,
    mainCandidates: seen.candidates.length,
    mainAutoMemoryWrites: seen.autoMemoryWrites,
    agreement: agreementOf(input.gate, seen.engramSaves > 0 || seen.autoMemoryWrites > 0),
  };
}

// ---------------------------------------------------------------------------
// The summary the card shows
// ---------------------------------------------------------------------------

export interface MemoryShadowSummary {
  readonly decisions: number;
  /** Haiku gate calls: every row asked once. */
  readonly gates: number;
  readonly updates: number;
  readonly skips: number;
  readonly gateFailures: number;
  /** UPDATE over the gates that gave a verdict; null with none. */
  readonly updateRate: number | null;
  /** Forks that ran (drafted, unparsable or no answer). */
  readonly forks: number;
  readonly drafts: number;
  readonly wouldSave: Readonly<Record<MemoryType, number>>;
  readonly judgeBuilds: number;
  readonly mainEngramSaves: number;
  readonly mainJudges: number;
  readonly mainAutoMemoryWrites: number;
  readonly agreement: { readonly both: number; readonly moduleOnly: number; readonly mainOnly: number; readonly neither: number; readonly unknown: number };
  /** Turns where the gate and the main thread agreed, over the turns with a verdict; null with none. */
  readonly agreementRate: number | null;
  readonly haikuTokens: { readonly input: number; readonly output: number };
  readonly forkTokens: { readonly input: number; readonly output: number; readonly cacheRead: number };
  /** The newest row's backend: what the module last detected. */
  readonly latest: { readonly at: string; readonly backend: string; readonly decidedBy: string; readonly permission: string } | null;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function tokensOf(value: unknown): { input: number; output: number; cacheRead: number } {
  if (!isRecord(value)) return { input: 0, output: 0, cacheRead: 0 };
  return { input: count(value.input), output: count(value.output), cacheRead: count(value.cacheRead) };
}

const RAN_FORKS: readonly unknown[] = ["drafted", "unparsable", "no-answer"];

/** What the module measured over the `windowMs` before `nowMs`. Rows are read tolerantly: anything malformed is skipped. */
export function summarizeMemoryDecisions(rows: readonly unknown[], nowMs: number, windowMs: number): MemoryShadowSummary {
  let decisions = 0;
  let updates = 0;
  let skips = 0;
  let forks = 0;
  let drafts = 0;
  let judgeBuilds = 0;
  let mainEngramSaves = 0;
  let mainJudges = 0;
  let mainAutoMemoryWrites = 0;
  const wouldSave = zeroTypes();
  const agreement = { both: 0, moduleOnly: 0, mainOnly: 0, neither: 0, unknown: 0 };
  const haikuTokens = { input: 0, output: 0 };
  const forkTokens = { input: 0, output: 0, cacheRead: 0 };
  let latest: MemoryShadowSummary["latest"] = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    if (!isRecord(row) || typeof row.at !== "string") continue;
    const atMs = Date.parse(row.at);
    if (Number.isNaN(atMs) || atMs > nowMs || atMs < nowMs - windowMs) continue;
    decisions += 1;
    if (row.gate === "update") updates += 1;
    if (row.gate === "skip") skips += 1;
    if (RAN_FORKS.includes(row.fork)) forks += 1;
    if (row.fork === "drafted") drafts += 1;
    if (isRecord(row.wouldSave)) for (const type of MEMORY_TYPES) wouldSave[type] += count(row.wouldSave[type]);
    judgeBuilds += count(row.judgeBuilds);
    mainEngramSaves += count(row.mainEngramSaves);
    mainJudges += count(row.mainJudges);
    mainAutoMemoryWrites += count(row.mainAutoMemoryWrites);
    if (row.agreement === "both") agreement.both += 1;
    else if (row.agreement === "module-only") agreement.moduleOnly += 1;
    else if (row.agreement === "main-only") agreement.mainOnly += 1;
    else if (row.agreement === "neither") agreement.neither += 1;
    else agreement.unknown += 1;
    const gate = tokensOf(row.gateTokens);
    haikuTokens.input += gate.input;
    haikuTokens.output += gate.output;
    const fork = tokensOf(row.forkTokens);
    forkTokens.input += fork.input;
    forkTokens.output += fork.output;
    forkTokens.cacheRead += fork.cacheRead;
    if (atMs > latestMs && typeof row.backend === "string") {
      latestMs = atMs;
      latest = { at: row.at, backend: row.backend, decidedBy: typeof row.decidedBy === "string" ? row.decidedBy : "none", permission: typeof row.permission === "string" ? row.permission : "unknown" };
    }
  }
  const verdicts = updates + skips;
  const judged = agreement.both + agreement.moduleOnly + agreement.mainOnly + agreement.neither;
  return {
    decisions,
    gates: decisions,
    updates,
    skips,
    gateFailures: decisions - verdicts,
    updateRate: verdicts > 0 ? updates / verdicts : null,
    forks,
    drafts,
    wouldSave,
    judgeBuilds,
    mainEngramSaves,
    mainJudges,
    mainAutoMemoryWrites,
    agreement,
    agreementRate: judged > 0 ? (agreement.both + agreement.neither) / judged : null,
    haikuTokens,
    forkTokens,
    latest,
  };
}
