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
  /** `git log --name-status` of the outgoing commits, keyed by `<sources> -> <remote>`; null: git failed. */
  readonly outgoing?: Readonly<Record<string, string | null>>;
  /** Text of `<commit>:<path>`. */
  readonly committed?: Readonly<Record<string, string>>;
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
    outgoingLog: (dir, sources, remote) => {
      const key = `${sources.join(" ")} -> ${remote ?? "*"}`;
      calls.push(`outgoing ${dir} ${key}`);
      const answer = repo.outgoing?.[key];
      return answer === undefined ? "" : answer;
    },
    commitContent: (dir, commit, path) => {
      calls.push(`committed ${dir} ${commit}:${path}`);
      return repo.committed?.[`${commit}:${path}`] ?? null;
    },
  };
}

/** `git log --format='commit %h' --name-status` text for commits, newest first. */
function log(...commits: readonly (readonly [string, readonly string[]])[]): string {
  return commits.map(([sha, changes]) => `commit ${sha}\n\n${changes.join("\n")}\n`).join("\n");
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

test("secret publish G3: a push whose outgoing commits touched a secret path is found, naming the commit", () => {
  const outgoing = { "feat/x -> origin": log(["b2", ["M\tsrc/a.ts"]], ["a1", ["A\t.env", "A\tsrc/a.ts"]]) };
  assert.deepEqual(find("git push origin feat/x", { outgoing }), { kind: "found", finding: { kind: "push", path: ".env", commit: "a1" } });
  assert.deepEqual(find("git push -u origin feat/x 2>&1 | tail -5", { outgoing }), { kind: "found", finding: { kind: "push", path: ".env", commit: "a1" } });
  assert.deepEqual(find(`cd ${REPO} && git push origin feat/x`, { outgoing }), { kind: "found", finding: { kind: "push", path: ".env", commit: "a1" } });
});

test("secret publish G3: a secret added and then deleted inside the range is still found", () => {
  const outgoing = { "HEAD -> *": log(["c3", ["D\tconfig/.env"]], ["b2", ["A\tconfig/.env"]], ["a1", ["A\tsrc/a.ts"]]) };
  assert.deepEqual(find("git push", { outgoing }), { kind: "found", finding: { kind: "push", path: "config/.env", commit: "b2" } });
});

test("secret publish G3: what each push sends: its refspec sources, HEAD, every branch, and its remote", () => {
  const calls: string[] = [];
  const read = (command: string) => findSecretPublish(command, REPO, HOME, reader({}, calls));
  read("git push");
  read("git push origin");
  read("git push origin HEAD:feat/y");
  read("git push origin +feat/x:feat/y feat/z");
  read("git push --all origin");
  read("git push --repo=upstream");
  read("git push https://github.com/acme/widgets.git feat/x");
  assert.deepEqual(calls, [
    `outgoing ${REPO} HEAD -> *`,
    `outgoing ${REPO} HEAD -> origin`,
    `outgoing ${REPO} HEAD -> origin`,
    `outgoing ${REPO} feat/x feat/z -> origin`,
    `outgoing ${REPO} --branches -> origin`,
    `outgoing ${REPO} HEAD -> upstream`,
    `outgoing ${REPO} feat/x -> *`,
  ]);
});

test("secret publish G3: a deletion, a template and a clean range are clean; deletes read nothing", () => {
  const calls: string[] = [];
  for (const command of ["git push origin --delete feat/x", "git push origin :feat/x", "git push -d origin feat/x"]) {
    assert.deepEqual(findSecretPublish(command, REPO, HOME, reader({}, calls)), { kind: "clean" }, command);
  }
  assert.deepEqual(calls, []);
  assert.deepEqual(find("git push origin feat/x", { outgoing: { "feat/x -> origin": log(["a1", ["D\t.env"]]) } }), { kind: "clean" }, "deleting a secret publishes nothing");
  assert.deepEqual(find("git push origin feat/x", { outgoing: { "feat/x -> origin": log(["a1", ["A\t.env.example", "M\tid_rsa.pub"]]) } }), { kind: "clean" });
  assert.deepEqual(find("git push origin feat/x", { outgoing: { "feat/x -> origin": "" } }), { kind: "clean" }, "nothing outgoing");
  assert.deepEqual(find("git push origin feat/x", { outgoing: { "feat/x -> origin": null } }), { kind: "unknown" });
});

test("secret publish G3: a pushed .npmrc is found only when that commit's copy holds a credential", () => {
  const outgoing = { "feat/x -> origin": log(["b2", ["M\t.npmrc"]], ["a1", ["A\t.npmrc"]]) };
  assert.deepEqual(find("git push origin feat/x", { outgoing, committed: { "a1:.npmrc": "registry=https://registry.npmjs.org/\n", "b2:.npmrc": "//registry.npmjs.org/:_authToken=npm_abc123\n" } }), { kind: "found", finding: { kind: "push", path: ".npmrc", commit: "b2" } });
  assert.deepEqual(find("git push origin feat/x", { outgoing, committed: { "a1:.npmrc": "registry=https://registry.npmjs.org/\n", "b2:.npmrc": "registry=https://npm.example.com/\n" } }), { kind: "clean" });
});
