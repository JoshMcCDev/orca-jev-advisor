// P2 (odd/tasks/multi-provider.md): the Cloudflare Clef provider. The
// responses come from src/core/fixtures/clef (real ones, account id removed).
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { buildActionGateQuestions } from "./decisions.ts";
import {
  CLEF_MAX_QUESTIONS,
  clefFailureOf,
  clefUrl,
  createClefProvider,
  neuronsFor,
  toClefQuestions,
  type ClefFailure,
} from "./clef.ts";
import type { CallJevOptions, JevFetch, JevFetchInit, Question } from "./jev.ts";

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/clef/${name}`, import.meta.url), "utf8");

/** Documented bodies (see fixtures/clef/README.txt): the 429s Cloudflare sends for the daily allowance and for capacity. */
const DAILY_429 = JSON.stringify({ result: null, success: false, errors: [{ code: 3036, message: "You have used up your daily free allocation of 10,000 neurons." }], messages: [] });
const CAPACITY_429 = JSON.stringify({ result: null, success: false, errors: [{ code: 3040, message: "Capacity temporarily exceeded, please try again." }], messages: [] });

function transport(status: number, body: string): { options: CallJevOptions; calls: Array<{ url: string; init: JevFetchInit }> } {
  const calls: Array<{ url: string; init: JevFetchInit }> = [];
  const fetchImpl: JevFetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, text: async () => body };
  };
  return { calls, options: { fetchImpl, sleepImpl: (_ms, signal) => (signal === undefined ? Promise.resolve() : new Promise<void>(() => undefined)) } };
}

async function failureOf(run: Promise<unknown>): Promise<ClefFailure> {
  try {
    await run;
  } catch (error) {
    const failure = clefFailureOf(error);
    assert.ok(failure !== null, "the error carries a Clef class");
    return failure;
  }
  throw new Error("expected the call to fail");
}

const provider = (model: "clef" | "clef-flash" | "clef-omni" = "clef") => createClefProvider({ accountId: "acct", token: "tok", model });

test("named noul criteria become one `true` criterion; other questions pass untouched", () => {
  const mapped = toClefQuestions(buildActionGateQuestions());
  assert.ok(mapped !== null);
  assert.deepEqual(mapped.reversible, {
    type: "noul",
    instructions: buildActionGateQuestions().reversible?.instructions,
    criteria: { true: "Yes when all of these hold: Reversing it takes a single known step. No work is lost that is not saved somewhere else." },
  });
  assert.deepEqual(mapped.consequence, buildActionGateQuestions().consequence);
});

test("true/false noul criteria and noul without criteria are kept as they are", () => {
  const questions: Record<string, Question> = {
    a: { type: "noul", instructions: "x", criteria: { true: "yes", false: "no" } },
    b: { type: "noul", instructions: "y" },
  };
  assert.deepEqual(toClefQuestions(questions), questions);
});

test("a question set outside Clef's limits is unsupported (null)", () => {
  const many: Record<string, Question> = {};
  for (let i = 0; i <= CLEF_MAX_QUESTIONS; i++) many[`q${i}`] = { type: "noul", instructions: "x" };
  assert.equal(toClefQuestions(many), null);
  assert.equal(toClefQuestions({ s: { type: "score", instructions: "x", criteria: ["only one"] } }), null);
  assert.equal(toClefQuestions({ s: { type: "score", instructions: "x", criteria: Array.from({ length: 11 }, (_, i) => `l${i}`) } }), null);
  assert.equal(toClefQuestions({ c: { type: "choice", instructions: "x", criteria: { a: "only" } } }), null);
});

test("the request goes to the account's Clef model with the model in the body and the token as Bearer", async () => {
  const t = transport(200, fixture("ok.json"));
  await provider("clef-flash").ask({ command: "git status" }, buildActionGateQuestions(), t.options);
  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0]?.url, "https://api.cloudflare.com/client/v4/accounts/acct/ai/run/@cf/cloudflare/clef-flash");
  assert.equal(t.calls[0]?.url, clefUrl("acct", "clef-flash"));
  assert.equal(t.calls[0]?.init.headers.Authorization, "Bearer tok");
  const body = JSON.parse(t.calls[0]?.init.body ?? "{}") as { model: string; state: unknown; questions: Record<string, { criteria?: unknown }> };
  assert.equal(body.model, "clef-flash");
  assert.deepEqual(body.state, { command: "git status" });
  assert.deepEqual(Object.keys(body.questions.reversible?.criteria as object), ["true"]);
});

test("the {result} envelope is unwrapped into the System One answer", async () => {
  const response = await provider().ask({}, buildActionGateQuestions(), transport(200, fixture("ok.json")).options);
  assert.equal(response.model, "clef");
  assert.deepEqual(response.usage, { input_tokens: 252, output_tokens: 0 });
  assert.equal(response.answers.reversible?.type, "noul");
});

test("a wrong token is an auth failure, never retried", async () => {
  const t = transport(401, fixture("auth-401.json"));
  assert.deepEqual(await failureOf(provider().ask({}, buildActionGateQuestions(), t.options)), { kind: "auth", status: 401 });
  assert.equal(t.calls.length, 1);
});

test("the daily free allocation (3036) is told apart from a rate limit (3040 or a bare 429)", async () => {
  const daily = transport(429, DAILY_429);
  assert.deepEqual(await failureOf(provider().ask({}, {}, daily.options)), { kind: "daily-allowance" });
  assert.equal(daily.calls.length, 1, "no retry: the cascade's next provider is the retry");
  assert.deepEqual(await failureOf(provider().ask({}, {}, transport(429, CAPACITY_429).options)), { kind: "rate-limit", status: 429 });
  assert.deepEqual(await failureOf(provider().ask({}, {}, transport(429, "").options)), { kind: "rate-limit", status: 429 });
});

test("a refused request, a server error, a timeout and a bad body keep their System One class", async () => {
  assert.deepEqual(await failureOf(provider().ask({}, {}, transport(422, fixture("named-criteria-422.json")).options)), { kind: "http4xx", status: 422 });
  const server = transport(503, "");
  assert.deepEqual(await failureOf(provider().ask({}, {}, server.options)), { kind: "http5xx", status: 503 });
  assert.equal(server.calls.length, 1);
  assert.deepEqual(await failureOf(provider().ask({}, {}, transport(200, "{\"result\":{}}").options)), { kind: "malformed" });
  const hang: CallJevOptions = { budgetMs: 10, fetchImpl: () => new Promise(() => undefined), sleepImpl: () => Promise.resolve() };
  assert.deepEqual(await failureOf(provider().ask({}, {}, hang)), { kind: "timeout" });
});

test("an unsupported question set fails as unsupported with no network call", async () => {
  const many: Record<string, Question> = {};
  for (let i = 0; i <= CLEF_MAX_QUESTIONS; i++) many[`q${i}`] = { type: "noul", instructions: "x" };
  const t = transport(200, fixture("ok.json"));
  assert.deepEqual(await failureOf(provider().ask({}, many, t.options)), { kind: "unsupported" });
  assert.equal(t.calls.length, 0);
});

test("neurons follow each model's input price; output is free", () => {
  assert.equal(neuronsFor("clef", { input_tokens: 1_000_000, output_tokens: 99 }), 21_818);
  assert.equal(neuronsFor("clef-omni", { input_tokens: 1_000_000, output_tokens: 0 }), 13_636);
  assert.equal(neuronsFor("clef-flash", { input_tokens: 1_000_000, output_tokens: 0 }), 3_455);
  assert.ok(Math.abs(neuronsFor("clef", { input_tokens: 480, output_tokens: 0 }) - 10.47264) < 1e-9);
});

test("the token never appears in a thrown error", async () => {
  try {
    await createClefProvider({ accountId: "acct", token: "secret-token-value", model: "clef" }).ask({}, {}, transport(401, fixture("auth-401.json")).options);
  } catch (error) {
    assert.ok(!String(error).includes("secret-token-value"));
    assert.ok(!(error instanceof Error && error.message.includes("secret-token-value")));
    return;
  }
  throw new Error("expected a failure");
});
