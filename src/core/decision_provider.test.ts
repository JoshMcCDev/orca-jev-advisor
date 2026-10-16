// P1 (odd/tasks/multi-provider.md): the provider interface and the Jev
// provider. The Jev provider must put on the wire exactly what callJev
// always has -- same endpoint, same headers, same body -- so Jev-only mode
// stays byte-for-byte today's behaviour.
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { createJevProvider, PROVIDER_IDS, type DecisionProvider } from "./decision_provider.ts";
import { callJev, type CallJevOptions, type JevFetch, type JevFetchInit } from "./jev.ts";

const OK_BODY = JSON.stringify({ model: "jev-latest", answers: { a: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 3, output_tokens: 1 } });

function recorder(): { options: CallJevOptions; calls: Array<{ url: string; init: JevFetchInit }> } {
  const calls: Array<{ url: string; init: JevFetchInit }> = [];
  const fetchImpl: JevFetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, text: async () => OK_BODY };
  };
  return { calls, options: { fetchImpl, sleepImpl: () => new Promise<void>(() => undefined) } };
}

test("the Jev provider sends exactly the request callJev sends", async () => {
  const viaCall = recorder();
  const viaProvider = recorder();
  const state = { command: "git status" };
  const questions = { a: { type: "noul" as const, instructions: "x", criteria: { one: "y" } } };
  const direct = await callJev("key-1", state, questions, viaCall.options);
  const provider: DecisionProvider = createJevProvider("key-1");
  const routed = await provider.ask(state, questions, viaProvider.options);
  assert.deepEqual(routed, direct);
  assert.equal(viaProvider.calls.length, 1);
  assert.equal(viaProvider.calls[0]?.url, viaCall.calls[0]?.url);
  assert.deepEqual(viaProvider.calls[0]?.init.headers, viaCall.calls[0]?.init.headers);
  assert.equal(viaProvider.calls[0]?.init.body, viaCall.calls[0]?.init.body);
});

test("the Jev provider names itself", () => {
  assert.equal(createJevProvider("k").id, "jev");
  assert.deepEqual([...PROVIDER_IDS], ["jev", "clef"]);
});
