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
  /** Staged paths; null: git failed. */
  readonly staged?: readonly string[] | null;
  /** Tracked paths modified in the working tree; null: git failed. */
  readonly modified?: readonly string[] | null;
  readonly index?: Readonly<Record<string, string>>;
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
    stagedPaths: (dir) => {
      calls.push(`staged ${dir}`);
      return repo.staged === undefined ? [] : repo.staged;
    },
    modifiedTrackedPaths: (dir) => {
      calls.push(`modified ${dir}`);
      return repo.modified === undefined ? [] : repo.modified;
    },
    indexContent: (dir, path) => {
      calls.push(`index ${dir} ${path}`);
      return repo.index?.[path] ?? null;
    },
    treeContent: (dir, path) => {
      calls.push(`tree ${dir} ${path}`);
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
    "git add -A",
    "git add . 2>&1",
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

test("secret publish G2: a commit with a staged secret path is found, from the index", () => {
  assert.deepEqual(find("git commit -qm x", { staged: ["src/a.ts", "config/.env"] }), { kind: "found", finding: { kind: "commit", path: "config/.env" } });
  assert.deepEqual(find("git commit -m 'fix: thing' --amend", { staged: [".env.local"] }), { kind: "found", finding: { kind: "commit", path: ".env.local" } });
  assert.deepEqual(find("git commit -qm x", { staged: [".npmrc"], index: { ".npmrc": "//registry.npmjs.org/:_authToken=npm_abc123\n" } }), { kind: "found", finding: { kind: "commit", path: ".npmrc" } });
  assert.deepEqual(find("git commit -qm x", { staged: [".npmrc"], index: { ".npmrc": "registry=https://registry.npmjs.org/\n" } }), { kind: "clean" });
});

test("secret publish G2: -a also commits modified tracked files; a pathspec commits only what it names", () => {
  assert.deepEqual(find("git commit -am x", { modified: [".env"] }), { kind: "found", finding: { kind: "commit", path: ".env" } });
  assert.deepEqual(find("git commit --all -m x", { modified: ["certs/server.key"] }), { kind: "found", finding: { kind: "commit", path: "certs/server.key" } });
  assert.deepEqual(find("git commit -m x", { modified: [".env"] }), { kind: "clean" }, "without -a a modified file is not committed");
  assert.deepEqual(find("git commit -m x -- .env"), { kind: "found", finding: { kind: "commit", path: ".env" } });
  assert.deepEqual(find("git commit -m x src/a.ts", { staged: [".env"] }), { kind: "clean" }, "a pathspec commits only what it names");
  assert.deepEqual(find("git commit -i -m x src/a.ts", { staged: [".env"] }), { kind: "found", finding: { kind: "commit", path: ".env" } }, "--include keeps the index");
});

test("secret publish G2: a commit message, a dry run and a clean index are clean; a failed read is unknown", () => {
  assert.deepEqual(find("git commit -m '.env'", { staged: ["src/a.ts"] }), { kind: "clean" }, "a message is not a pathspec");
  assert.deepEqual(find("git commit -F .env.msg -q", { staged: ["src/a.ts"] }), { kind: "clean" });
  assert.deepEqual(find("git commit --dry-run", { staged: [".env"] }), { kind: "clean" });
  assert.deepEqual(find("git add -A && git commit -qm wip", { staged: ["src/a.ts"] }), { kind: "clean" });
  assert.deepEqual(find("git commit -qm x", { staged: null }), { kind: "unknown" });
});
