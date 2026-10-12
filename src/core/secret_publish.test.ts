// Unit tests for the gate's secret publish guard -- pure: the repository is
// a fake reader. Run with:
//   node --test --experimental-strip-types src/core/secret_publish.test.ts

import assert from "node:assert/strict";
import test from "node:test";

import { findSecretPublish } from "./secret_publish.ts";
import type { SecretPublishReader } from "./secret_publish.ts";

const HOME = "/home/someone";
const REPO = `${HOME}/project`;

interface FakeRepo {
  readonly forcedAdd?: Readonly<Record<string, readonly string[] | null>>;
  readonly working?: Readonly<Record<string, string>>;
}

/** A reader over fixed answers; `calls` records which reads ran. */
function reader(repo: FakeRepo = {}, calls: string[] = []): SecretPublishReader {
  return {
    forcedAddPaths: (dir, args) => {
      calls.push(`forcedAdd ${dir} ${args.join(" ")}`);
      const answer = repo.forcedAdd?.[args.join(" ")];
      return answer === undefined ? [] : answer;
    },
    workingContent: (dir, path) => {
      calls.push(`working ${dir} ${path}`);
      return repo.working?.[path] ?? null;
    },
  };
}

function find(command: string, repo: FakeRepo = {}, cwd = REPO) {
  return findSecretPublish(command, cwd, HOME, reader(repo));
}

test("secret publish G1: an add naming a secret path is found, by name", () => {
  for (const [command, path] of [
    ["git add .env", ".env"],
    ["git add .env && git commit -qm x", ".env"],
    ["git add src/a.ts config/.env.production", "config/.env.production"],
    ["git add -- ./certs/server.pem", "./certs/server.pem"],
    [`cd ${REPO} && git add id_rsa`, "id_rsa"],
    [`git -C ${REPO} add .env.local 2>&1`, ".env.local"],
  ] as const) {
    assert.deepEqual(find(command), { kind: "found", finding: { kind: "add", path } }, command);
  }
});

test("secret publish G1: a forced add is found from what git would stage", () => {
  const repo: FakeRepo = { forcedAdd: { "-- .": ["src/a.ts", ".env"], "-A": ["config/.env"], "-- dist": ["dist/app.js"] } };
  assert.deepEqual(find("git add -f .", repo), { kind: "found", finding: { kind: "add", path: ".env" } });
  assert.deepEqual(find("git add -Af", repo), { kind: "found", finding: { kind: "add", path: "config/.env" } });
  assert.deepEqual(find("git add --force dist", repo), { kind: "clean" });
  assert.deepEqual(find("git add -f missing", { forcedAdd: { "-- missing": null } }), { kind: "unknown" }, "git could not say what it would stage");
});

test("secret publish G1: a .npmrc is found only when it holds a credential", () => {
  assert.deepEqual(find("git add .npmrc", { working: { ".npmrc": "//registry.npmjs.org/:_authToken=npm_abc123\n" } }), { kind: "found", finding: { kind: "add", path: ".npmrc" } });
  assert.deepEqual(find("git add .npmrc", { working: { ".npmrc": "registry=https://registry.npmjs.org/\n" } }), { kind: "clean" });
});

test("secret publish G1: ordinary adds, templates and a dry run are clean, and read nothing", () => {
  const calls: string[] = [];
  for (const command of [
    "git add -A && git commit -qm wip",
    "git add . && git commit -qm wip",
    "git add -u",
    "git add .env.example .env.sample .env.template",
    "git add id_rsa.pub",
    "git add -n .env",
    "git add --dry-run -f .",
    "echo git add .env",
    "grep -r 'git add .env' docs",
    "ls -la",
  ]) {
    assert.deepEqual(findSecretPublish(command, REPO, HOME, reader({}, calls)), { kind: "clean" }, command);
  }
  assert.deepEqual(calls, [], "no git and no file read for a command that cannot stage a secret");
});
