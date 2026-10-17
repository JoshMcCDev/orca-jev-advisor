// P4 (odd/tasks/multi-provider.md): Jev, Clef or both. In both mode Clef
// answers first; Jev answers on doubt, on Clef's failure, once the day's
// budget is spent, for a question set Clef cannot take, or when the caller
// says so (a command-scoped policy). One provider's answers per decision.
import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { DecisionProvider } from "./decision_provider.ts";
import { ClefError, type ClefFailure, type ClefModel, type ClefProvider } from "./clef.ts";
import { CONSEQUENCE_NOISE_MARGIN, GATE_CONSEQUENCE_CEILING } from "./decisions.ts";
import { JevTimeoutError, type Answer, type CallJevOptions, type JevResponse, type Question } from "./jev.ts";
import {
  DEFAULT_PROVIDER_MODE,
  GATE_DOUBT_BAND,
  CascadeBudgetError,
  defaultDoubt,
  gateConsequenceDoubt,
  isProviderMode,
  runCascade,
  type CascadeBudget,
  type CascadeInput,
} from "./provider_cascade.ts";

const consequence = (score: number): Record<string, Answer> => ({
  consequence: { type: "score", score, legend: {}, probabilities: {}, confidence: 0.9 },
});

const reply = (model: string, answers: Record<string, Answer>, inputTokens = 480): JevResponse => ({ model, answers, usage: { input_tokens: inputTokens, output_tokens: 0 } });

interface FakeCall {
  readonly questions: Record<string, Question>;
  readonly budgetMs: number | undefined;
}

function fakeJev(outcome: JevResponse | Error, calls: FakeCall[] = []): DecisionProvider {
  return {
    id: "jev",
    ask: async (_state, questions, options?: CallJevOptions) => {
      calls.push({ questions, budgetMs: options?.budgetMs });
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  };
}

function fakeClef(outcome: JevResponse | ClefFailure, calls: FakeCall[] = [], model: ClefModel = "clef"): ClefProvider {
  return {
    id: "clef",
    model,
    ask: async (_state, questions, options?: CallJevOptions) => {
      calls.push({ questions, budgetMs: options?.budgetMs });
      if ("kind" in outcome) throw new ClefError(`clef ${outcome.kind}`, outcome);
      return outcome;
    },
  };
}

function budget(open = true): CascadeBudget & { spent: Array<{ neurons: number; model: string }>; exhausted: boolean } {
  const state = { open, spent: [] as Array<{ neurons: number; model: string }>, exhausted: false };
  return {
    get spent() {
      return state.spent;
    },
    get exhausted() {
      return state.exhausted;
    },
    isOpen: () => state.open,
    spend: (neurons, model) => state.spent.push({ neurons, model }),
    markExhausted: () => {
      state.exhausted = true;
    },
  };
}

const QUESTIONS: Record<string, Question> = { consequence: { type: "score", instructions: "x", criteria: ["a", "b", "c", "d"] } };
const clear = consequence(0.2);
const nearLine = consequence(GATE_CONSEQUENCE_CEILING - CONSEQUENCE_NOISE_MARGIN + 0.05);

function input(overrides: Partial<CascadeInput>): CascadeInput {
  return {
    mode: "both",
    jev: null,
    clef: null,
    budget: budget(),
    state: { command: "git status" },
    questions: QUESTIONS,
    doubt: (answers) => gateConsequenceDoubt(answers),
    totalBudgetMs: 1_800,
    clefBudgetMs: 1_200,
    ...overrides,
  };
}

test("the default mode is Jev, and only the three modes are modes", () => {
  assert.equal(DEFAULT_PROVIDER_MODE, "jev");
  assert.ok(isProviderMode("jev") && isProviderMode("clef") && isProviderMode("both"));
  assert.ok(!isProviderMode("clef-only") && !isProviderMode(undefined));
});

test("gate doubt: consequence within the band of the effective line, or missing", () => {
  const line = GATE_CONSEQUENCE_CEILING - CONSEQUENCE_NOISE_MARGIN;
  assert.equal(GATE_DOUBT_BAND, 0.2);
  assert.equal(gateConsequenceDoubt(consequence(line + 0.19)), true);
  assert.equal(gateConsequenceDoubt(consequence(line - 0.19)), true);
  assert.equal(gateConsequenceDoubt(consequence(line + 0.21)), false);
  assert.equal(gateConsequenceDoubt(consequence(0.2)), false);
  assert.equal(gateConsequenceDoubt({}), true);
  // The destination's own ceiling moves the line.
  assert.equal(gateConsequenceDoubt(consequence(1.0), 1.2), true);
  assert.equal(gateConsequenceDoubt(consequence(1.0)), false);
});

test("the generic doubt: a noul near even, or a low-confidence choice or score", () => {
  assert.equal(defaultDoubt({ a: { type: "noul", noul: 0.5 } }), true);
  assert.equal(defaultDoubt({ a: { type: "noul", noul: 0.9 } }), false);
  assert.equal(defaultDoubt({ a: { type: "choice", choice: "x", probabilities: {}, confidence: 0.4 } }), true);
  assert.equal(defaultDoubt({ a: { type: "choice", choice: "x", probabilities: {}, confidence: 0.9 } }), false);
});

test("Jev mode asks Jev only, with the whole budget, and records nothing new", async () => {
  const jevCalls: FakeCall[] = [];
  const clefCalls: FakeCall[] = [];
  const result = await runCascade(input({ mode: "jev", jev: fakeJev(reply("jev-latest", clear), jevCalls), clef: fakeClef(reply("clef", clear), clefCalls) }));
  assert.equal(result.provider, "jev");
  assert.equal(result.escalation, null);
  assert.equal(clefCalls.length, 0);
  assert.equal(jevCalls[0]?.budgetMs, 1_800);
});

test("Jev mode passes Jev's own error through untouched", async () => {
  const timeout = new JevTimeoutError(1_800);
  await assert.rejects(runCascade(input({ mode: "jev", jev: fakeJev(timeout) })), (error) => error === timeout);
});

test("both mode: a confident Clef answer is used, its neurons spent, Jev never asked", async () => {
  const jevCalls: FakeCall[] = [];
  const b = budget();
  const result = await runCascade(input({ jev: fakeJev(reply("jev-latest", nearLine), jevCalls), clef: fakeClef(reply("clef", clear)), budget: b }));
  assert.equal(result.provider, "clef");
  assert.equal(result.escalation, null);
  assert.deepEqual(result.response.answers, clear);
  assert.equal(jevCalls.length, 0);
  assert.equal(b.spent.length, 1);
  assert.ok(Math.abs((b.spent[0]?.neurons ?? 0) - 10.47264) < 1e-9);
  assert.equal(result.neurons, b.spent[0]?.neurons);
});

test("both mode: doubt re-asks Jev every question and uses only Jev's answers", async () => {
  const jevCalls: FakeCall[] = [];
  const jevAnswers = consequence(0.1);
  const result = await runCascade(input({ jev: fakeJev(reply("jev-latest", jevAnswers), jevCalls), clef: fakeClef(reply("clef", nearLine)) }));
  assert.equal(result.provider, "jev");
  assert.equal(result.escalation, "doubt");
  assert.deepEqual(result.response.answers, jevAnswers);
  assert.deepEqual(jevCalls[0]?.questions, QUESTIONS);
});

test("both mode: Clef gets its sub-budget and Jev what is left, never less than the reserve", async () => {
  const clefCalls: FakeCall[] = [];
  const jevCalls: FakeCall[] = [];
  let clock = 0;
  const clef: ClefProvider = {
    id: "clef",
    model: "clef",
    ask: async (_s, questions, options) => {
      clefCalls.push({ questions, budgetMs: options?.budgetMs });
      clock += 1_200;
      throw new ClefError("timeout", { kind: "timeout" });
    },
  };
  const result = await runCascade(input({ jev: fakeJev(reply("jev-latest", clear), jevCalls), clef, nowImpl: () => clock }));
  assert.equal(clefCalls[0]?.budgetMs, 1_200);
  assert.equal(jevCalls[0]?.budgetMs, 600);
  assert.equal(result.provider, "jev");
  assert.equal(result.escalation, "failure");
});

test("both mode: each Clef failure escalates with its own reason", async () => {
  const cases: Array<[ClefFailure, string]> = [
    [{ kind: "rate-limit", status: 429 }, "rate-limit"],
    [{ kind: "auth", status: 401 }, "failure"],
    [{ kind: "http5xx", status: 503 }, "failure"],
    [{ kind: "unsupported" }, "unsupported"],
    [{ kind: "daily-allowance" }, "budget"],
  ];
  for (const [failure, escalation] of cases) {
    const b = budget();
    const result = await runCascade(input({ jev: fakeJev(reply("jev-latest", clear)), clef: fakeClef(failure), budget: b }));
    assert.equal(result.provider, "jev", failure.kind);
    assert.equal(result.escalation, escalation, failure.kind);
    assert.equal(b.exhausted, failure.kind === "daily-allowance", failure.kind);
  }
});

test("both mode: a closed budget or a caller's reason skips Clef entirely", async () => {
  const clefCalls: FakeCall[] = [];
  const spent = await runCascade(input({ jev: fakeJev(reply("jev-latest", clear)), clef: fakeClef(reply("clef", clear), clefCalls), budget: budget(false) }));
  assert.equal(spent.escalation, "budget");
  const policy = await runCascade(input({ jev: fakeJev(reply("jev-latest", clear)), clef: fakeClef(reply("clef", clear), clefCalls), skipClef: "policy" }));
  assert.equal(policy.escalation, "policy");
  assert.equal(policy.provider, "jev");
  assert.equal(clefCalls.length, 0);
});

test("both mode with no Clef credentials is Jev, marked unconfigured", async () => {
  const result = await runCascade(input({ jev: fakeJev(reply("jev-latest", clear)), clef: null }));
  assert.equal(result.provider, "jev");
  assert.equal(result.escalation, "unconfigured");
});

test("both mode with no Jev key keeps Clef's answer even in doubt, and Clef's failure is the failure", async () => {
  const doubtful = await runCascade(input({ jev: null, clef: fakeClef(reply("clef", nearLine)) }));
  assert.equal(doubtful.provider, "clef");
  assert.equal(doubtful.escalation, null);
  await assert.rejects(runCascade(input({ jev: null, clef: fakeClef({ kind: "http5xx", status: 500 }) })), ClefError);
  await assert.rejects(runCascade(input({ jev: null, clef: fakeClef(reply("clef", clear)), budget: budget(false) })), CascadeBudgetError);
});

test("Clef mode never asks Jev: doubt is kept, a failure is thrown, a spent day is a budget failure", async () => {
  const jevCalls: FakeCall[] = [];
  const jev = fakeJev(reply("jev-latest", clear), jevCalls);
  const doubtful = await runCascade(input({ mode: "clef", jev, clef: fakeClef(reply("clef", nearLine)) }));
  assert.equal(doubtful.provider, "clef");
  assert.equal(doubtful.escalation, null);
  await assert.rejects(runCascade(input({ mode: "clef", jev, clef: fakeClef({ kind: "timeout" }) })), ClefError);
  const b = budget();
  await assert.rejects(runCascade(input({ mode: "clef", jev, clef: fakeClef({ kind: "daily-allowance" }), budget: b })), ClefError);
  assert.equal(b.exhausted, true);
  await assert.rejects(runCascade(input({ mode: "clef", jev, clef: fakeClef(reply("clef", clear)), budget: budget(false) })), CascadeBudgetError);
  assert.equal(jevCalls.length, 0);
});

test("shadow: a sampled confident Clef answer is also put to Jev, and the agreement recorded", async () => {
  const jevCalls: FakeCall[] = [];
  const verdictOf = (answers: Record<string, Answer>): string => (gateConsequenceDoubt(answers) ? "near" : (answers.consequence as { score: number }).score > 1 ? "ask" : "allow");
  const agree = await runCascade(input({ jev: fakeJev(reply("jev-latest", consequence(0.3)), jevCalls), clef: fakeClef(reply("clef", clear)), shadow: { sampled: true, verdictOf } }));
  assert.equal(agree.provider, "clef");
  assert.equal(agree.shadowAgrees, true);
  const disagree = await runCascade(input({ jev: fakeJev(reply("jev-latest", consequence(2.5))), clef: fakeClef(reply("clef", clear)), shadow: { sampled: true, verdictOf } }));
  assert.equal(disagree.provider, "clef");
  assert.equal(disagree.shadowAgrees, false);
  const notSampled = await runCascade(input({ jev: fakeJev(reply("jev-latest", clear)), clef: fakeClef(reply("clef", clear)), shadow: { sampled: false, verdictOf } }));
  assert.equal(notSampled.shadowAgrees, null);
  const failed = await runCascade(input({ jev: fakeJev(new JevTimeoutError(600)), clef: fakeClef(reply("clef", clear)), shadow: { sampled: true, verdictOf } }));
  assert.equal(failed.provider, "clef");
  assert.equal(failed.shadowAgrees, null);
});

test("shadow: when the sampled call escalates, the shadow Jev answer is the one used (no second Jev call)", async () => {
  const jevCalls: FakeCall[] = [];
  const result = await runCascade(input({ jev: fakeJev(reply("jev-latest", clear), jevCalls), clef: fakeClef(reply("clef", nearLine)), shadow: { sampled: true, verdictOf: () => "x" } }));
  assert.equal(result.provider, "jev");
  assert.equal(result.escalation, "doubt");
  assert.equal(result.shadowAgrees, null);
  assert.equal(jevCalls.length, 1);
});
