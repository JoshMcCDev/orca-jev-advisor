// Multi-provider decisions (odd/tasks/multi-provider.md, P3): the daily
// neuron budget for Cloudflare's Clef.
//
// Workers AI gives 10,000 free neurons a day, reset at 00:00 UTC. On Workers
// Paid, going past that bills the account instead of failing, so this
// budget is the only stop: it closes at NEURON_DAILY_STOP, a margin below
// the allowance, or as soon as Cloudflare reports the allowance spent
// (HTTP 429, code 3036), and Clef is then skipped until the next UTC day.
//
// The ledger is append-only, one file per UTC day in the cache dir: every
// writer only appends one short line (`appendFileSync`, O_APPEND), so two
// gate hooks writing at once never lose each other's rows -- unlike a
// read-then-rewrite, which does.

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../guards.ts";
import { assertSafeWriteTarget } from "./write_guard.ts";

export const NEURON_DAILY_ALLOWANCE = 10_000;
/** Where Clef stops for the day: 10% under the allowance, so concurrent calls and rounding never cross into billing. */
export const NEURON_DAILY_STOP = 9_000;

export type NeuronLedgerEntry =
  | { readonly type: "neurons"; readonly at: string; readonly model: string; readonly neurons: number }
  | { readonly type: "allowance-exhausted"; readonly at: string };

export interface NeuronBudgetDay {
  readonly spent: number;
  readonly calls: number;
  readonly exhausted: boolean;
}

/** `clef-neurons-YYYY-MM-DD.jsonl` for the UTC day `at` falls in. */
export function neuronLedgerFileName(at: string | Date): string {
  const iso = typeof at === "string" ? at : at.toISOString();
  return `clef-neurons-${iso.slice(0, 10)}.jsonl`;
}

export function serializeNeuronLedgerEntry(entry: NeuronLedgerEntry): string {
  return `${JSON.stringify(entry)}\n`;
}

/** Sums one day's ledger; a malformed line is skipped, never thrown on. */
export function parseNeuronLedger(raw: string): NeuronBudgetDay {
  let spent = 0;
  let calls = 0;
  let exhausted = false;
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    if (parsed.type === "neurons" && typeof parsed.neurons === "number" && Number.isFinite(parsed.neurons) && parsed.neurons >= 0) {
      spent += parsed.neurons;
      calls += 1;
    } else if (parsed.type === "allowance-exhausted") {
      exhausted = true;
    }
  }
  return { spent, calls, exhausted };
}

/** Whether Clef may still be called today. */
export function budgetOpen(day: NeuronBudgetDay, stop: number = NEURON_DAILY_STOP): boolean {
  return !day.exhausted && day.spent < stop;
}

/** Today's (UTC) ledger in `cacheDir`; an absent or unreadable file is an untouched day. */
export function readNeuronBudget(cacheDir: string, now: Date = new Date()): NeuronBudgetDay {
  try {
    return parseNeuronLedger(readFileSync(join(cacheDir, neuronLedgerFileName(now)), "utf8"));
  } catch {
    return { spent: 0, calls: 0, exhausted: false };
  }
}

/** Appends one entry to the ledger of the day the entry's `at` falls in. Throws on a failed write; callers decide whether that matters. */
export function appendNeuronLedger(cacheDir: string, entry: NeuronLedgerEntry): void {
  const path = join(cacheDir, neuronLedgerFileName(entry.at));
  assertSafeWriteTarget(path);
  mkdirSync(cacheDir, { recursive: true });
  appendFileSync(path, serializeNeuronLedgerEntry(entry), "utf8");
}
