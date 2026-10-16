// P3 (odd/tasks/multi-provider.md): the daily neuron budget. An append-only
// ledger per UTC day is the only stop before Cloudflare starts billing.
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  NEURON_DAILY_ALLOWANCE,
  NEURON_DAILY_STOP,
  appendNeuronLedger,
  budgetOpen,
  neuronLedgerFileName,
  parseNeuronLedger,
  readNeuronBudget,
  serializeNeuronLedgerEntry,
} from "./neuron_budget.ts";

test("the stop sits below the free allowance, with a margin", () => {
  assert.equal(NEURON_DAILY_ALLOWANCE, 10_000);
  assert.ok(NEURON_DAILY_STOP < NEURON_DAILY_ALLOWANCE);
  assert.equal(NEURON_DAILY_STOP, 9_000);
});

test("one ledger file per UTC day", () => {
  assert.equal(neuronLedgerFileName("2026-10-16T23:59:59.000Z"), "clef-neurons-2026-10-16.jsonl");
  assert.equal(neuronLedgerFileName("2026-10-17T00:00:00.000Z"), "clef-neurons-2026-10-17.jsonl");
});

test("the ledger sums neurons and remembers a reported exhaustion; bad lines are skipped", () => {
  const raw =
    serializeNeuronLedgerEntry({ type: "neurons", at: "2026-10-16T01:00:00.000Z", model: "clef", neurons: 10.5 }) +
    "not json\n" +
    serializeNeuronLedgerEntry({ type: "neurons", at: "2026-10-16T02:00:00.000Z", model: "clef-flash", neurons: 1.5 }) +
    JSON.stringify({ type: "neurons", at: "x", model: "clef", neurons: "12" }) + "\n";
  assert.deepEqual(parseNeuronLedger(raw), { spent: 12, calls: 2, exhausted: false });
  const exhausted = raw + serializeNeuronLedgerEntry({ type: "allowance-exhausted", at: "2026-10-16T03:00:00.000Z" });
  assert.equal(parseNeuronLedger(exhausted).exhausted, true);
});

test("the budget closes at the stop or on a reported exhaustion", () => {
  assert.equal(budgetOpen({ spent: 0, calls: 0, exhausted: false }), true);
  assert.equal(budgetOpen({ spent: NEURON_DAILY_STOP - 0.01, calls: 1, exhausted: false }), true);
  assert.equal(budgetOpen({ spent: NEURON_DAILY_STOP, calls: 1, exhausted: false }), false);
  assert.equal(budgetOpen({ spent: 0, calls: 0, exhausted: true }), false);
});

test("appends only add lines, and reads see the day the clock is in", () => {
  const dir = mkdtempSync(join(tmpdir(), "neuron-ledger-"));
  try {
    const day1 = new Date("2026-10-16T12:00:00.000Z");
    assert.deepEqual(readNeuronBudget(dir, day1), { spent: 0, calls: 0, exhausted: false });
    appendNeuronLedger(dir, { type: "neurons", at: day1.toISOString(), model: "clef", neurons: 8_999 });
    appendNeuronLedger(dir, { type: "neurons", at: day1.toISOString(), model: "clef", neurons: 2 });
    const lines = readFileSync(join(dir, "clef-neurons-2026-10-16.jsonl"), "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    assert.equal(budgetOpen(readNeuronBudget(dir, day1)), false);
    // 00:00 UTC opens a fresh day.
    assert.equal(budgetOpen(readNeuronBudget(dir, new Date("2026-10-17T00:00:01.000Z"))), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
