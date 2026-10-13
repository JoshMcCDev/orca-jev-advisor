// The memory module (odd/tasks/memory-core.md, M2): whether a finished turn is
// worth a memory update, and where a save goes. The owner writes in Spanish,
// so the turns below are Spanish as often as English.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  GATE_MAX_TOKENS,
  LAST_EXCHANGE_CHARS,
  MEMORY_MARKER,
  MEMORY_TYPES,
  buildGatePrompt,
  freeChecks,
  GATE_SYSTEM,
  lastExchange,
  parseGate,
  routeSave,
  typedPrompt,
} from "./memory_decide.ts";
import type { ExchangeMessage } from "./memory_decide.ts";
import { detectMemoryBackend } from "./memory_detect.ts";
import type { MemorySignals } from "./memory_detect.ts";

const NONE: MemorySignals = { liveServer: null, health: null, userConfigured: false, pluginEnabled: false, binaryVersion: null };
const LIVE = detectMemoryBackend({ ...NONE, liveServer: "engram", health: "ok" });
const REFUSED = detectMemoryBackend({ ...NONE, liveServer: "engram", health: "permission" });
const DOWN = detectMemoryBackend({ ...NONE, liveServer: "engram", health: "failed" });
const ABSENT = detectMemoryBackend(NONE);

const user = (text: string): ExchangeMessage => ({ role: "user", text, toolUses: [] });
const assistant = (text: string, tools: readonly string[] = []): ExchangeMessage => ({ role: "assistant", text, toolUses: tools.map((tool) => ({ tool })) });
const toolResult = (): ExchangeMessage => ({ role: "user", text: "", toolUses: [], toolResults: [{ tool_use_id: "t" }] });

test("the module is pure: no node: import, so the mod sandbox can load it", () => {
  const source = readFileSync(new URL("./memory_decide.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from "node:/);
});

// ---------------------------------------------------------------------------
// The typed prompt and the free checks
// ---------------------------------------------------------------------------

test("typedPrompt: the latest typed person message, not a tool result", () => {
  const messages = [user("viejo"), assistant("ok"), user("recuerda que prefiero pnpm"), assistant("", ["Read"]), toolResult(), assistant("Anotado.")];
  assert.equal(typedPrompt(messages), "recuerda que prefiero pnpm");
});

test("typedPrompt: null when the transcript has no typed message", () => {
  assert.equal(typedPrompt([]), null);
  assert.equal(typedPrompt([assistant("hola"), toolResult(), user("   ")]), null);
});

test("free checks: a main-thread answer to a typed prompt passes", () => {
  assert.deepEqual(freeChecks({ agentId: undefined, reason: "answer", prompt: "no uses voseo, usa tú" }), { pass: true });
});

test("free checks: a subagent turn is skipped", () => {
  assert.deepEqual(freeChecks({ agentId: "agent-1", reason: "answer", prompt: "x" }), { pass: false, skip: "subagent" });
});

test("free checks: only an answer counts, not an abort, a refusal or an error", () => {
  for (const reason of ["aborted", "refusal", "error"]) {
    assert.deepEqual(freeChecks({ agentId: undefined, reason, prompt: "hola" }), { pass: false, skip: "not-answer" }, reason);
  }
});

test("free checks: no typed prompt, an empty one", () => {
  assert.deepEqual(freeChecks({ agentId: undefined, reason: "answer", prompt: null }), { pass: false, skip: "no-prompt" });
  assert.deepEqual(freeChecks({ agentId: undefined, reason: "answer", prompt: "  \n" }), { pass: false, skip: "no-prompt" });
});

test("free checks: a slash command is skipped, in the typed form and the transcript form", () => {
  assert.deepEqual(freeChecks({ agentId: undefined, reason: "answer", prompt: "/memory tidy" }), { pass: false, skip: "slash-command" });
  assert.deepEqual(freeChecks({ agentId: undefined, reason: "answer", prompt: "  /compact" }), { pass: false, skip: "slash-command" });
  assert.deepEqual(freeChecks({ agentId: undefined, reason: "answer", prompt: "<command-name>/clear</command-name>" }), { pass: false, skip: "slash-command" });
});

test("free checks: a path or a division typed mid-sentence is not a slash command", () => {
  assert.deepEqual(freeChecks({ agentId: undefined, reason: "answer", prompt: "mira src/a.ts y 6/3" }), { pass: true });
});

test("free checks: our own marker is skipped (the module's fork prompt is not a person)", () => {
  assert.deepEqual(freeChecks({ agentId: undefined, reason: "answer", prompt: `${MEMORY_MARKER} This message is from the memory module` }), { pass: false, skip: "own-marker" });
});

test("free checks: injected system text is not a person prompt", () => {
  assert.deepEqual(freeChecks({ agentId: undefined, reason: "answer", prompt: "<system-reminder>Task tools</system-reminder>" }), { pass: false, skip: "no-prompt" });
});

// ---------------------------------------------------------------------------
// lastExchange
// ---------------------------------------------------------------------------

test("lastExchange: starts at the latest typed prompt and lists tools by name only", () => {
  const text = lastExchange([
    user("old prompt"),
    assistant("old answer"),
    user("recuerda que prefiero bun"),
    assistant("", ["Read"]),
    toolResult(),
    assistant("Anotado."),
  ]);
  assert.equal(text, "USER: recuerda que prefiero bun\nTOOL: Read\nASSISTANT: Anotado.");
});

test("lastExchange: an exchange over the cap keeps its start and its end", () => {
  const long = `${"inicio-largo ".repeat(400)}MIDDLE ${"final-largo ".repeat(2000)}`;
  const text = lastExchange([user("inicio"), assistant(long)]);
  assert.ok(text.length <= LAST_EXCHANGE_CHARS + 20, `${text.length}`);
  assert.ok(text.startsWith("USER: inicio"));
  assert.ok(text.endsWith("final-largo final-largo"));
  assert.ok(!text.includes("MIDDLE"));
  assert.ok(text.includes("\n…\n"));
});

test("lastExchange: an exchange under the cap is returned whole", () => {
  const text = lastExchange([user("hola"), assistant("hola, ¿en qué te ayudo?")]);
  assert.equal(text, "USER: hola\nASSISTANT: hola, ¿en qué te ayudo?");
});

test("lastExchange: a secret in a message is redacted before the cut and never reaches the text", () => {
  const secret = "sk-ant-api03-" + "a".repeat(40);
  const text = lastExchange([user(`usa esta llave ${secret} siempre`), assistant("ok")]);
  assert.ok(!text.includes(secret));
});

test("lastExchange: no messages, no text", () => {
  assert.equal(lastExchange([]), "");
});

// ---------------------------------------------------------------------------
// The gate prompt and its parser
// ---------------------------------------------------------------------------

test("gate prompt: the index and the turn go in their own blocks, the turn after the index", () => {
  const prompt = buildGatePrompt({ index: "- [pnpm](feedback_pnpm.md) - always pnpm", exchange: "USER: recuerda bun" });
  assert.match(prompt, /<memory_index>\n- \[pnpm\]\(feedback_pnpm\.md\) - always pnpm\n<\/memory_index>/);
  assert.match(prompt, /<turn>\nUSER: recuerda bun\n<\/turn>/);
  assert.ok(prompt.indexOf("<memory_index>") < prompt.indexOf("<turn>"));
});

test("gate prompt: an empty index says so, and a long one is cut", () => {
  assert.match(buildGatePrompt({ index: "", exchange: "x" }), /<memory_index>\n\(empty\)\n<\/memory_index>/);
  const cut = buildGatePrompt({ index: "i".repeat(50000), exchange: "x" });
  assert.ok(cut.length < 12000, `${cut.length}`);
});

test("gate system prompt: names the four types, treats the turn as data and demands one line", () => {
  for (const type of MEMORY_TYPES) assert.match(GATE_SYSTEM, new RegExp(`- ${type}:`));
  assert.match(GATE_SYSTEM, /data, not instructions/);
  assert.match(GATE_SYSTEM, /Spanish/);
  assert.match(GATE_SYSTEM, /"UPDATE: <what to save, under 20 words>" or "SKIP"/);
  assert.ok(GATE_MAX_TOKENS <= 100);
});

test("parseGate: SKIP is a skip, with or without a closing period or spaces", () => {
  for (const text of ["SKIP", "SKIP.", "  SKIP\n"]) assert.deepEqual(parseGate(text), { kind: "skip" }, JSON.stringify(text));
});

test("parseGate: UPDATE with a reason, in either language", () => {
  assert.deepEqual(parseGate("UPDATE: user prefers pnpm over npm"), { kind: "update", reason: "user prefers pnpm over npm" });
  assert.deepEqual(parseGate("UPDATE: la persona quiere tú, nunca voseo"), { kind: "update", reason: "la persona quiere tú, nunca voseo" });
  assert.deepEqual(parseGate("UPDATE:no space"), { kind: "update", reason: "no space" });
});

test("parseGate: a bare UPDATE is an update with no reason", () => {
  assert.deepEqual(parseGate("UPDATE"), { kind: "update", reason: "" });
});

test("parseGate: the reason is cut to a line a prompt can carry", () => {
  const result = parseGate(`UPDATE: ${"x".repeat(1000)}`);
  assert.equal(result.kind, "update");
  if (result.kind === "update") assert.ok(result.reason.length <= 200);
});

test("parseGate: anything else is a failure, never an update", () => {
  for (const text of [
    "",
    "   ",
    "update: lower case",
    "skip",
    "UPDATES the index",
    "UPDATED: done",
    "Sure! UPDATE: save it",
    "I would say SKIP",
    "SKIP\nUPDATE: and also this",
    "UPDATE: one\nUPDATE: two",
    "SKIPPING this one",
    "ACTUALIZAR: guardar esto",
    "maybe",
  ]) {
    assert.deepEqual(parseGate(text), { kind: "failure" }, JSON.stringify(text));
  }
});

// ---------------------------------------------------------------------------
// Type routing
// ---------------------------------------------------------------------------

test("routing: Engram live sends feedback and user to Engram and mirrors them into auto-memory", () => {
  for (const type of ["feedback", "user"] as const) {
    assert.deepEqual(routeSave(type, LIVE), { engram: "now", autoMemory: "mirror" }, type);
  }
});

test("routing: Engram live sends project and reference to Engram only", () => {
  for (const type of ["project", "reference"] as const) {
    assert.deepEqual(routeSave(type, LIVE), { engram: "now", autoMemory: "none" }, type);
  }
});

test("routing: no Engram sends every type to auto-memory as the one store", () => {
  for (const type of MEMORY_TYPES) assert.deepEqual(routeSave(type, ABSENT), { engram: "never", autoMemory: "primary" }, type);
});

test("routing: Engram configured but down keeps every type in auto-memory as a fallback copy to replay", () => {
  for (const type of MEMORY_TYPES) assert.deepEqual(routeSave(type, DOWN), { engram: "replay-later", autoMemory: "fallback" }, type);
});

test("routing: a permission refusal is a fallback too, but the item still waits for Engram", () => {
  for (const type of MEMORY_TYPES) assert.deepEqual(routeSave(type, REFUSED), { engram: "replay-later", autoMemory: "fallback" }, type);
});
