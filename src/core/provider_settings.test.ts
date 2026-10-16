// P4/P5 (odd/tasks/multi-provider.md): the provider settings mirror the gate
// reads, and the Cloudflare credentials it resolves the way it resolves the
// Jev key.
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DEFAULT_PROVIDER_SETTINGS, PROVIDER_SETTINGS_MIRROR_FILE, parseProviderSettings } from "./provider_settings.ts";
import { CLOUDFLARE_ACCOUNT_ID_ENV, CLOUDFLARE_API_TOKEN_ENV, parseEnvFileValue, resolveClefCredentials } from "./secrets.ts";

test("no file, bad JSON or a wrong shape is Jev only with the default Clef model", () => {
  assert.deepEqual(DEFAULT_PROVIDER_SETTINGS, { mode: "jev", clefModel: "clef" });
  assert.deepEqual(parseProviderSettings(null), DEFAULT_PROVIDER_SETTINGS);
  assert.deepEqual(parseProviderSettings("{nope"), DEFAULT_PROVIDER_SETTINGS);
  assert.deepEqual(parseProviderSettings("[]"), DEFAULT_PROVIDER_SETTINGS);
  assert.deepEqual(parseProviderSettings(JSON.stringify({ mode: "gpt", clefModel: "llama" })), DEFAULT_PROVIDER_SETTINGS);
  assert.equal(PROVIDER_SETTINGS_MIRROR_FILE, "decision-provider.json");
});

test("a valid mode and model are kept; each field falls back on its own", () => {
  assert.deepEqual(parseProviderSettings(JSON.stringify({ mode: "both", clefModel: "clef-flash" })), { mode: "both", clefModel: "clef-flash" });
  assert.deepEqual(parseProviderSettings(JSON.stringify({ mode: "clef" })), { mode: "clef", clefModel: "clef" });
  assert.deepEqual(parseProviderSettings(JSON.stringify({ clefModel: "clef-omni" })), { mode: "jev", clefModel: "clef-omni" });
});

test("env file values are read by name, quotes stripped, comments skipped", () => {
  const content = `# a comment\nTYPESAFE_API_KEY=k\n${CLOUDFLARE_ACCOUNT_ID_ENV}="acct"\n${CLOUDFLARE_API_TOKEN_ENV}= tok \n`;
  assert.equal(parseEnvFileValue(content, CLOUDFLARE_ACCOUNT_ID_ENV), "acct");
  assert.equal(parseEnvFileValue(content, CLOUDFLARE_API_TOKEN_ENV), "tok");
  assert.equal(parseEnvFileValue(content, "MISSING"), null);
  assert.equal(parseEnvFileValue(`${CLOUDFLARE_API_TOKEN_ENV}=\n`, CLOUDFLARE_API_TOKEN_ENV), null);
});

test("Cloudflare credentials come from the environment, else the mirror file; both halves or none", async () => {
  const dir = mkdtempSync(join(tmpdir(), "clef-creds-"));
  const saved = { config: process.env.ORCA_SUPERVISOR_CONFIG_DIR, account: process.env[CLOUDFLARE_ACCOUNT_ID_ENV], token: process.env[CLOUDFLARE_API_TOKEN_ENV] };
  try {
    process.env.ORCA_SUPERVISOR_CONFIG_DIR = dir;
    delete process.env[CLOUDFLARE_ACCOUNT_ID_ENV];
    delete process.env[CLOUDFLARE_API_TOKEN_ENV];
    assert.equal(await resolveClefCredentials(), null);
    writeFileSync(join(dir, "env"), `${CLOUDFLARE_ACCOUNT_ID_ENV}=acct\n`);
    assert.equal(await resolveClefCredentials(), null, "an account id without a token is no credentials");
    writeFileSync(join(dir, "env"), `${CLOUDFLARE_ACCOUNT_ID_ENV}=acct\n${CLOUDFLARE_API_TOKEN_ENV}=tok\n`);
    assert.deepEqual(await resolveClefCredentials(), { accountId: "acct", token: "tok" });
    process.env[CLOUDFLARE_ACCOUNT_ID_ENV] = "env-acct";
    process.env[CLOUDFLARE_API_TOKEN_ENV] = "env-tok";
    assert.deepEqual(await resolveClefCredentials(), { accountId: "env-acct", token: "env-tok" });
  } finally {
    for (const [name, value] of [["ORCA_SUPERVISOR_CONFIG_DIR", saved.config], [CLOUDFLARE_ACCOUNT_ID_ENV, saved.account], [CLOUDFLARE_API_TOKEN_ENV, saved.token]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
