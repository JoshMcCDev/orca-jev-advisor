// The CI watcher (odd/tasks/ci-watcher.md, C1): the pure rules behind it. The
// hook wiring is covered in adapters/claude/mod-skills/hooks.test.ts.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CI_NO_RUN_MS,
  CI_RUN_FIELDS,
  CI_WATCH_CAP_MS,
  CI_WATCH_DECISIONS_FILE_PATTERN,
  CI_WATCH_MAX_POLLS,
  ciBandRows,
  ciBashCallFrom,
  ciNoteText,
  ciWatchDecisionFileName,
  ciWatchRecord,
  ciWatchStep,
  classifyAgentCall,
  couldStartCiWatch,
  detectCiTriggers,
  extendCiWatch,
  isCiPollCommand,
  isCiWatchNote,
  newCiWatchProgress,
  parseCiBandRows,
  parseCiRuns,
  parsePrMergeView,
  sleepSeconds,
  summarizeCiWatchRows,
} from "./ci_watch.ts";
import type { CiBandRow, CiBashCall, CiRun, CiWatchProgress, CiWatchStep, CiWatchTarget } from "./ci_watch.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER_SHA = "fedcba9876543210fedcba9876543210fedcba98";
const T0 = Date.parse("2026-10-12T10:00:00.000Z");

test("the module is pure: no node: import, so the mod sandbox can load it", () => {
  const source = readFileSync(new URL("./ci_watch.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from "node:/);
});

// ---------------------------------------------------------------------------
// The parser of `gh run list --json ...`
// ---------------------------------------------------------------------------

function ghRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    databaseId: 101,
    status: "completed",
    conclusion: "success",
    headBranch: "feat/ci-watcher",
    headSha: SHA,
    workflowName: "CI",
    url: "https://github.com/ab2webco/orca-jev-advisor/actions/runs/101",
    createdAt: "2026-10-12T10:00:30Z",
    ...overrides,
  };
}

test("the requested fields are the ones the parser reads", () => {
  assert.equal(CI_RUN_FIELDS, "databaseId,status,conclusion,headBranch,headSha,workflowName,url,createdAt");
});

test("parser: a gh run list array gives typed runs; an empty conclusion (a run still going) reads as null", () => {
  const runs = parseCiRuns(JSON.stringify([ghRow(), ghRow({ databaseId: 102, status: "in_progress", conclusion: "", workflowName: "Deploy" })]));
  assert.deepEqual(runs, [
    { id: 101, status: "completed", conclusion: "success", branch: "feat/ci-watcher", sha: SHA, workflow: "CI", url: "https://github.com/ab2webco/orca-jev-advisor/actions/runs/101", createdAtMs: Date.parse("2026-10-12T10:00:30Z") },
    { id: 102, status: "in_progress", conclusion: null, branch: "feat/ci-watcher", sha: SHA, workflow: "Deploy", url: "https://github.com/ab2webco/orca-jev-advisor/actions/runs/101", createdAtMs: Date.parse("2026-10-12T10:00:30Z") },
  ]);
});

test("parser: an empty list is an empty answer, anything that is not a list is null (a failed poll)", () => {
  assert.deepEqual(parseCiRuns("[]"), []);
  for (const bad of ["", "not json", "{}", "null", '"x"']) assert.equal(parseCiRuns(bad), null, bad);
});

test("parser: an entry missing its id, status or sha is skipped; the rest stay", () => {
  const runs = parseCiRuns(JSON.stringify([ghRow({ databaseId: "x" }), ghRow({ status: 3 }), ghRow({ headSha: undefined }), "text", null, ghRow({ databaseId: 7 })]));
  assert.deepEqual(runs?.map((run) => run.id), [7]);
});

test("parser: a missing createdAt is time zero, never a throw", () => {
  const runs = parseCiRuns(JSON.stringify([ghRow({ createdAt: undefined })]));
  assert.equal(runs?.[0]?.createdAtMs, 0);
});

// ---------------------------------------------------------------------------
// Trigger detection: the engine's own gitOperation first, the command second
// ---------------------------------------------------------------------------

const HOME = "/home/dev";
const BASE = "/home/dev/Projects/app";

function bash(command: string, extra: Partial<CiBashCall> = {}): CiBashCall {
  return { command, isError: false, output: "", gitOperation: undefined, ...extra };
}

function kinds(call: CiBashCall): string[] {
  return detectCiTriggers(call, BASE, HOME).map((trigger) => trigger.kind);
}

test("command layer: git push, with and without a remote and branch", () => {
  assert.deepEqual(detectCiTriggers(bash("git push"), BASE, HOME), [{ kind: "push", branch: null, dir: BASE, pr: null, url: null }]);
  assert.deepEqual(detectCiTriggers(bash("git push -u origin feat/x"), BASE, HOME), [{ kind: "push", branch: "feat/x", dir: BASE, pr: null, url: null }]);
  assert.equal(detectCiTriggers(bash("git push origin HEAD:refs/heads/feat/y"), BASE, HOME)[0]?.branch, "feat/y");
  assert.equal(detectCiTriggers(bash("git push --force-with-lease origin +feat/z"), BASE, HOME)[0]?.branch, "feat/z");
  assert.equal(detectCiTriggers(bash("git push origin HEAD"), BASE, HOME)[0]?.branch, null, "HEAD names no branch: git says which");
  assert.equal(detectCiTriggers(bash("git -c push.default=current push"), BASE, HOME)[0]?.kind, "push");
});

test("command layer: the directory the push ran in follows cd and git -C", () => {
  assert.equal(detectCiTriggers(bash("cd /home/dev/Projects/other && git push"), BASE, HOME)[0]?.dir, "/home/dev/Projects/other");
  assert.equal(detectCiTriggers(bash("git -C ../other push origin main"), BASE, HOME)[0]?.dir, "/home/dev/Projects/other");
  assert.equal(detectCiTriggers(bash("git push && cd /tmp"), BASE, HOME)[0]?.dir, BASE, "a cd after the push does not move it");
});

test("command layer: gh pr create and gh pr merge", () => {
  const created = detectCiTriggers(bash("gh pr create --title t --body b", { output: "https://github.com/ab2webco/orca-jev-advisor/pull/54\n" }), BASE, HOME);
  assert.deepEqual(created, [{ kind: "pr-create", branch: null, dir: BASE, pr: 54, url: "https://github.com/ab2webco/orca-jev-advisor/pull/54" }]);
  assert.deepEqual(detectCiTriggers(bash("gh pr merge 53 --squash"), BASE, HOME), [{ kind: "pr-merge", branch: null, dir: BASE, pr: 53, url: null }]);
  assert.equal(detectCiTriggers(bash("gh pr merge https://github.com/a/b/pull/12"), BASE, HOME)[0]?.pr, 12);
  assert.equal(detectCiTriggers(bash("gh pr merge"), BASE, HOME)[0]?.pr, null);
});

test("command layer: a chain of push and pr create is two triggers", () => {
  assert.deepEqual(kinds(bash("git push -u origin feat/x && gh pr create --fill")), ["push", "pr-create"]);
});

test("command layer: dry runs, deletes, tags alone, up-to-date pushes and failed calls start nothing", () => {
  for (const command of ["git push --dry-run", "git push -n origin main", "git push origin --delete feat/x", "git push origin :feat/x", "git push --tags", "gh pr create --dry-run", "git status", "echo git push", "git commit -m 'git push'"]) {
    assert.deepEqual(kinds(bash(command)), [], command);
  }
  assert.deepEqual(kinds(bash("git push", { output: "Everything up-to-date\n" })), []);
  assert.deepEqual(kinds(bash("git push", { isError: true })), []);
  assert.deepEqual(kinds(bash("gh pr merge 53", { isError: true })), []);
});

test("engine layer: gitOperation.push gives the branch and wins over the command's own reading", () => {
  const triggers = detectCiTriggers(bash("git push", { gitOperation: { push: { branch: "feat/engine" } } }), BASE, HOME);
  assert.deepEqual(triggers, [{ kind: "push", branch: "feat/engine", dir: BASE, pr: null, url: null }]);
  assert.equal(detectCiTriggers(bash("git push origin feat/cmd", { gitOperation: { push: { branch: "feat/engine" } } }), BASE, HOME)[0]?.branch, "feat/engine");
});

test("engine layer: a push the command does not show (a script) still counts when the engine saw one", () => {
  assert.deepEqual(kinds(bash("./scripts/ship.sh", { gitOperation: { push: { branch: "feat/x" } } })), ["push"]);
});

test("engine layer: pr actions - created and merged start a watch; a queued auto-merge, a comment or a close do not", () => {
  assert.deepEqual(detectCiTriggers(bash("gh pr create --fill", { gitOperation: { pr: { number: 9, url: "https://github.com/a/b/pull/9", action: "created" } } }), BASE, HOME), [{ kind: "pr-create", branch: null, dir: BASE, pr: 9, url: "https://github.com/a/b/pull/9" }]);
  assert.deepEqual(kinds(bash("gh pr merge 9", { gitOperation: { pr: { number: 9, action: "merged" } } })), ["pr-merge"]);
  for (const action of ["auto-merge-enabled", "auto-merge-disabled", "commented", "closed", "edited", "draft", "reopened", "ready"]) {
    assert.deepEqual(kinds(bash("gh pr merge 9 --auto", { gitOperation: { pr: { number: 9, action } } })), [], action);
  }
});

test("precedence: when the engine and the command disagree, the engine's category wins; a category it does not report falls back to the command", () => {
  // The command reads as a merge, the engine says only that auto-merge was switched on: no merge happened.
  assert.deepEqual(kinds(bash("gh pr merge 9 --auto --squash", { gitOperation: { pr: { number: 9, action: "auto-merge-enabled" } } })), []);
  // The engine reported a commit only; the command's push is still a push.
  assert.deepEqual(kinds(bash("git commit -m x && git push", { gitOperation: { commit: { sha: "abc", kind: "committed" } } })), ["push"]);
  // The engine reported the push; the command also merged and the engine did not say so.
  assert.deepEqual(kinds(bash("git push && gh pr merge 9", { gitOperation: { push: { branch: "feat/x" } } })), ["push", "pr-merge"]);
  // A malformed gitOperation is no report at all.
  assert.deepEqual(kinds(bash("git push", { gitOperation: "push" })), ["push"]);
  assert.deepEqual(kinds(bash("git push", { gitOperation: { push: { branch: 4 } } })), ["push"]);
});

test("an up-to-date push is no trigger even when the engine reports it", () => {
  assert.deepEqual(kinds(bash("git push", { output: "Everything up-to-date", gitOperation: { push: { branch: "main" } } })), []);
});

// ---------------------------------------------------------------------------
// The agent's own CI polls and sleeps
// ---------------------------------------------------------------------------

test("a CI poll is gh run list/view/watch or gh pr checks, wherever it sits in the command", () => {
  for (const command of ["gh run list --branch main", "gh run view 123 --log-failed", "gh run watch 123 --exit-status", "gh pr checks 53", "gh pr checks --watch", "cd app && gh run list -L 3", "sleep 30 && gh run view 5", "until gh run view 5 --exit-status; do sleep 20; done", "GH_TOKEN=x gh run list", "(gh run list)"]) {
    assert.equal(isCiPollCommand(command), true, command);
  }
  for (const command of ["gh pr view 53", "gh pr list", "gh run download 5", "gh api repos/a/b", "git push", "echo gh run list", "gh run rerun 5", "grep 'gh pr checks' README.md"]) {
    assert.equal(isCiPollCommand(command), false, command);
  }
});

test("sleepSeconds reads the longest sleep of the command, in seconds; none is null", () => {
  assert.equal(sleepSeconds("sleep 30"), 30);
  assert.equal(sleepSeconds("sleep 2m"), 120);
  assert.equal(sleepSeconds("sleep 1.5"), 1.5);
  assert.equal(sleepSeconds("sleep 5 && sleep 45 && echo"), 45);
  assert.equal(sleepSeconds("until x; do sleep 20; done"), 20);
  assert.equal(sleepSeconds("sleep"), null);
  assert.equal(sleepSeconds("sleep abc"), null);
  assert.equal(sleepSeconds("echo sleep 30"), null);
  assert.equal(sleepSeconds("ls"), null);
});

test("classifyAgentCall: a poll is a ci-poll (even with a sleep in the same command), a sleep of 10 s or more is a sleep, a short one is nothing", () => {
  assert.equal(classifyAgentCall("Bash", "gh run watch 5"), "ci-poll");
  assert.equal(classifyAgentCall("Bash", "sleep 60 && gh pr checks"), "ci-poll");
  assert.equal(classifyAgentCall("Bash", "sleep 90"), "sleep");
  assert.equal(classifyAgentCall("Bash", "sleep 10"), "sleep");
  assert.equal(classifyAgentCall("Bash", "sleep 2"), null);
  assert.equal(classifyAgentCall("Bash", "ls"), null);
  assert.equal(classifyAgentCall("Read", "gh run list"), null);
  assert.equal(classifyAgentCall("Bash", null), null);
});

// ---------------------------------------------------------------------------
// The poll schedule and the watch step
// ---------------------------------------------------------------------------

const TARGET: CiWatchTarget = { sha: SHA, sinceMs: T0 };

function run(overrides: Partial<CiRun> = {}): CiRun {
  return { id: 101, status: "completed", conclusion: "success", branch: "feat/x", sha: SHA, workflow: "CI", url: "https://github.com/a/b/actions/runs/101", createdAtMs: T0 + 5_000, ...overrides };
}

/** Feeds the step with each answer in turn, as the hook would, and returns every step. */
function drive(answers: readonly (readonly CiRun[] | null)[], target: CiWatchTarget = TARGET, start: CiWatchProgress = newCiWatchProgress()): CiWatchStep[] {
  const steps: CiWatchStep[] = [];
  let progress = start;
  for (const answer of answers) {
    const step = ciWatchStep(progress, answer, target);
    steps.push(step);
    if (step.kind !== "wait") break;
    progress = step.progress;
  }
  return steps;
}

function delays(steps: readonly CiWatchStep[]): number[] {
  return steps.flatMap((step) => (step.kind === "wait" ? [step.delayMs] : []));
}

test("schedule: 10, 15, 20, 30, 45, 60 seconds, then 90 seconds steady", () => {
  const steps = drive(Array.from({ length: 9 }, () => [run({ status: "in_progress", conclusion: null })]));
  assert.deepEqual(delays(steps), [10_000, 15_000, 20_000, 30_000, 45_000, 60_000, 90_000, 90_000, 90_000]);
});

test("schedule: elapsed time is the sum of the scheduled delays, so the cap is deterministic and bounds the gh calls", () => {
  const forever = Array.from({ length: 200 }, () => [run({ status: "in_progress", conclusion: null })]);
  const steps = drive(forever);
  const last = steps.at(-1);
  assert.equal(last?.kind, "stop");
  assert.equal(last?.kind === "stop" ? last.reason : null, "cap");
  assert.equal(steps.length, CI_WATCH_MAX_POLLS, "every poll up to the cap, no more");
  assert.equal(CI_WATCH_MAX_POLLS, 45);
  const total = delays(steps).reduce((sum, delay) => sum + delay, 0);
  assert.ok(total <= CI_WATCH_CAP_MS, "the last scheduled poll is at or before the cap");
  assert.ok(total > CI_WATCH_CAP_MS - 90_000, "and the cap is reached to within one step");
});

test("a run still going waits and counts the runs: seen and running", () => {
  const [step] = drive([[run({ id: 1 }), run({ id: 2, status: "queued", conclusion: null }), run({ id: 3, status: "in_progress", conclusion: null })]]);
  assert.equal(step?.kind, "wait");
  assert.deepEqual(step?.kind === "wait" ? { seen: step.seen, running: step.running } : null, { seen: 3, running: 2 });
});

test("no run for the sha yet: wait, then stop quietly after the no-run limit", () => {
  const nothing: readonly CiRun[] = [];
  const steps = drive(Array.from({ length: 60 }, () => nothing));
  const last = steps.at(-1);
  assert.equal(last?.kind === "stop" ? last.reason : null, "no-runs");
  assert.ok(delays(steps).reduce((sum, delay) => sum + delay, 0) <= CI_NO_RUN_MS + 90_000);
  assert.ok(delays(steps).reduce((sum, delay) => sum + delay, 0) >= CI_NO_RUN_MS - 90_000);
});

test("runs of other shas, and runs older than the trigger, are not this watch's", () => {
  const steps = drive([[run({ sha: OTHER_SHA }), run({ id: 5, createdAtMs: T0 - 10 * 60_000 })]]);
  assert.equal(steps[0]?.kind === "wait" ? steps[0].seen : -1, 0);
  // A run created a little before the trigger (clock skew between GitHub and this machine) still counts.
  const skewed = drive([[run({ createdAtMs: T0 - 60_000 })]]);
  assert.equal(skewed[0]?.kind === "wait" ? skewed[0].seen : -1, 1);
});

test("a short sha on either side still matches", () => {
  const short = drive([[run({ sha: SHA.slice(0, 7) })]]);
  assert.equal(short[0]?.kind === "wait" ? short[0].seen : -1, 1);
  const shortTarget = drive([[run()]], { sha: SHA.slice(0, 7), sinceMs: T0 });
  assert.equal(shortTarget[0]?.kind === "wait" ? shortTarget[0].seen : -1, 1);
});

test("done needs two identical polls with every run completed, a settle window since the trigger, and gives success", () => {
  const finished = [run()];
  // Poll 1 sees the run done but a second poll must agree; the confirm poll comes fast.
  const first = ciWatchStep(newCiWatchProgress(), finished, TARGET);
  assert.equal(first.kind, "wait");
  assert.equal(first.kind === "wait" ? first.delayMs : 0, 10_000);
  const progress = first.kind === "wait" ? first.progress : newCiWatchProgress();
  // Elapsed is 10 s: inside the settle window (30 s), so the second identical poll still waits.
  const second = ciWatchStep(progress, finished, TARGET);
  assert.equal(second.kind, "wait");
  const third = ciWatchStep(second.kind === "wait" ? second.progress : progress, finished, TARGET);
  assert.equal(third.kind, "wait");
  const fourth = ciWatchStep(third.kind === "wait" ? third.progress : progress, finished, TARGET);
  assert.equal(fourth.kind, "done");
  assert.deepEqual(fourth.kind === "done" ? fourth.verdict : null, { outcome: "success", url: "https://github.com/a/b/actions/runs/101", workflows: 1, failed: [] });
});

test("done after a long wait needs only the confirming poll", () => {
  let progress = newCiWatchProgress();
  const running = [run({ status: "in_progress", conclusion: null })];
  for (let i = 0; i < 8; i += 1) {
    const step = ciWatchStep(progress, running, TARGET);
    assert.equal(step.kind, "wait");
    progress = step.kind === "wait" ? step.progress : progress;
  }
  const finished = [run()];
  const seen = ciWatchStep(progress, finished, TARGET);
  assert.equal(seen.kind, "wait");
  assert.equal(seen.kind === "wait" ? seen.delayMs : 0, 10_000, "the confirming poll is not a full back-off away");
  const done = ciWatchStep(seen.kind === "wait" ? seen.progress : progress, finished, TARGET);
  assert.equal(done.kind, "done");
});

test("a change between two completed polls (another workflow appeared) is not yet agreement", () => {
  let progress = newCiWatchProgress();
  for (let i = 0; i < 6; i += 1) {
    const step = ciWatchStep(progress, [run({ status: "in_progress", conclusion: null })], TARGET);
    progress = step.kind === "wait" ? step.progress : progress;
  }
  const one = ciWatchStep(progress, [run()], TARGET);
  assert.equal(one.kind, "wait");
  const two = ciWatchStep(one.kind === "wait" ? one.progress : progress, [run(), run({ id: 202, workflow: "Deploy", status: "queued", conclusion: null })], TARGET);
  assert.equal(two.kind, "wait", "a new run that is not finished");
  const three = ciWatchStep(two.kind === "wait" ? two.progress : progress, [run(), run({ id: 202, workflow: "Deploy" })], TARGET);
  assert.equal(three.kind, "wait", "finished now, but different from the last poll");
  const four = ciWatchStep(three.kind === "wait" ? three.progress : progress, [run(), run({ id: 202, workflow: "Deploy" })], TARGET);
  assert.equal(four.kind, "done");
  assert.equal(four.kind === "done" ? four.verdict.workflows : 0, 2);
});

function settle(runs: readonly CiRun[], progress: CiWatchProgress = newCiWatchProgress()): CiWatchStep {
  let current = progress;
  // Past the settle window and the no-run limit: start from a progress that has waited a while.
  for (let i = 0; i < 6; i += 1) {
    const step = ciWatchStep(current, [run({ id: 999, status: "in_progress", conclusion: null })], TARGET);
    current = step.kind === "wait" ? step.progress : current;
  }
  let step = ciWatchStep(current, runs, TARGET);
  for (let i = 0; i < 3 && step.kind === "wait"; i += 1) step = ciWatchStep(step.progress, runs, TARGET);
  return step;
}

test("verdict: success, skipped and neutral are success", () => {
  const step = settle([run(), run({ id: 102, conclusion: "skipped", workflow: "Docs" }), run({ id: 103, conclusion: "neutral", workflow: "Lint" })]);
  assert.equal(step.kind === "done" ? step.verdict.outcome : null, "success");
});

test("verdict: anything else is failure, the failed workflows are named and the failed run's url is the one given", () => {
  for (const conclusion of ["failure", "timed_out", "cancelled", "action_required", "startup_failure", "stale", "something-new"]) {
    const step = settle([run(), run({ id: 102, conclusion, workflow: "Deploy", url: "https://github.com/a/b/actions/runs/102" })]);
    assert.equal(step.kind === "done" ? step.verdict.outcome : null, "failure", conclusion);
    assert.deepEqual(step.kind === "done" ? step.verdict.failed : null, ["Deploy"], conclusion);
    assert.equal(step.kind === "done" ? step.verdict.url : null, "https://github.com/a/b/actions/runs/102", conclusion);
  }
});

test("a completed run with no conclusion is failure, never a guess towards success", () => {
  const step = settle([run({ conclusion: null })]);
  assert.equal(step.kind === "done" ? step.verdict.outcome : null, "failure");
});

test("a failed poll waits; the third failed poll in a row stops quietly; an answer in between resets the count", () => {
  const steps = drive([null, null, null]);
  assert.deepEqual(steps.map((step) => step.kind), ["wait", "wait", "stop"]);
  const last = steps.at(-1);
  assert.equal(last?.kind === "stop" ? last.reason : null, "gh-failed");
  const reset = drive([null, null, [run({ status: "in_progress", conclusion: null })], null, null]);
  assert.deepEqual(reset.map((step) => step.kind), ["wait", "wait", "wait", "wait", "wait"]);
});

test("a later trigger on the same sha extends the watch: the settle window restarts and the last agreement is forgotten", () => {
  let progress = newCiWatchProgress();
  for (let i = 0; i < 7; i += 1) {
    const step = ciWatchStep(progress, [run()], TARGET);
    progress = step.kind === "wait" ? step.progress : progress;
    if (step.kind === "done") break;
  }
  const extended = extendCiWatch({ ...progress, signature: "x", failedPolls: 2 });
  assert.equal(extended.signature, null);
  assert.equal(extended.settleFromMs, extended.elapsedMs);
  assert.equal(extended.failedPolls, 0);
  assert.equal(extended.polls, progress.polls, "the poll count is the watch's, not reset");
});

// ---------------------------------------------------------------------------
// The texts
// ---------------------------------------------------------------------------

test("the agent's note: sha, branch, outcome and url; a failure names the workflows", () => {
  const url = "https://github.com/a/b/actions/runs/7";
  assert.equal(ciNoteText({ sha7: "0123456", branch: "feat/x" }, { outcome: "success", url, workflows: 2, failed: [] }), `CI for 0123456 on feat/x: success, ${url}`);
  assert.equal(ciNoteText({ sha7: "0123456", branch: "feat/x" }, { outcome: "failure", url, workflows: 2, failed: ["CI", "Deploy"] }), `CI for 0123456 on feat/x: failure (CI, Deploy), ${url}`);
  assert.equal(ciNoteText({ sha7: "0123456", branch: null }, { outcome: "success", url, workflows: 1, failed: [] }), `CI for 0123456: success, ${url}`);
  assert.equal(ciNoteText({ sha7: "0123456", branch: "b" }, { outcome: "failure", url, workflows: 6, failed: ["a", "b", "c", "d", "e"] }), `CI for 0123456 on b: failure (a, b, c and 2 more), ${url}`);
});

test("the note is recognised by its own wording", () => {
  assert.equal(isCiWatchNote("CI for 0123456 on feat/x: success, https://x"), true);
  assert.equal(isCiWatchNote("CI for the release is flaky, please look"), false);
  assert.equal(isCiWatchNote("hello"), false);
});

const ROW: CiBandRow = { id: "a", sha7: "0123456", branch: "feat/x", status: "watching", startedAtMs: T0, done: 1, total: 3, failed: [], finishedAtMs: null };

test("band rows: a running watch, a passed one and a failed one, in both languages", () => {
  assert.deepEqual(ciBandRows("en", [ROW], T0 + 4 * 60_000, 120), ["CI 0123456 feat/x: running, 1 of 3 runs done, 4 min"]);
  assert.deepEqual(ciBandRows("es", [ROW], T0 + 4 * 60_000, 120), ["CI 0123456 feat/x: en curso, 1 de 3 ejecuciones hechas, 4 min"]);
  assert.deepEqual(ciBandRows("en", [{ ...ROW, status: "success", finishedAtMs: T0 + 60_000 }], T0 + 90_000, 120), ["CI 0123456 feat/x: passed"]);
  assert.deepEqual(ciBandRows("en", [{ ...ROW, status: "failure", failed: ["CI", "Deploy"], finishedAtMs: T0 + 60_000 }], T0 + 90_000, 120), ["CI 0123456 feat/x: failed (CI, Deploy)"]);
  assert.deepEqual(ciBandRows("es", [{ ...ROW, status: "failure", failed: ["CI"], finishedAtMs: T0 + 60_000 }], T0 + 90_000, 120), ["CI 0123456 feat/x: falló (CI)"]);
  assert.deepEqual(ciBandRows("en", [{ ...ROW, branch: null }], T0, 120), ["CI 0123456: running, 1 of 3 runs done, 0 min"]);
});

test("band rows: before any run of the sha has appeared the row says it is waiting for them", () => {
  const waiting: CiBandRow = { ...ROW, done: 0, total: 0 };
  assert.deepEqual(ciBandRows("en", [waiting], T0 + 60_000, 120), ["CI 0123456 feat/x: waiting for the runs to appear, 1 min"]);
  assert.deepEqual(ciBandRows("es", [waiting], T0 + 60_000, 120), ["CI 0123456 feat/x: esperando que aparezcan las ejecuciones, 1 min"]);
});

test("band rows: every line fits the width, a watch past the cap is dropped, a finished row goes after its keep time", () => {
  for (const line of ciBandRows("en", [{ ...ROW, branch: "feat/a-very-long-branch-name-that-keeps-going-and-going" }], T0, 40)) assert.ok(line.length <= 40, line);
  assert.deepEqual(ciBandRows("en", [ROW], T0 + CI_WATCH_CAP_MS + 1, 120), []);
  assert.deepEqual(ciBandRows("en", [{ ...ROW, status: "success", finishedAtMs: T0 }], T0 + 10 * 60_000, 120), []);
  assert.deepEqual(ciBandRows("en", [], T0, 120), []);
});

test("band rows from state: tolerant of a bad value; a row missing a field is dropped", () => {
  assert.deepEqual(parseCiBandRows(undefined), []);
  assert.deepEqual(parseCiBandRows("x"), []);
  assert.deepEqual(parseCiBandRows({ rows: "x" }), []);
  assert.deepEqual(parseCiBandRows({ rows: [ROW, { id: 4 }, null] }), [ROW]);
});

// ---------------------------------------------------------------------------
// The decision row and its summary
// ---------------------------------------------------------------------------

test("the decision file is one per UTC hour", () => {
  assert.equal(ciWatchDecisionFileName("2026-10-12T10:31:02.000Z"), "ci-watch-decisions-2026-10-12T10.jsonl");
  assert.match("ci-watch-decisions-2026-10-12T10.jsonl", CI_WATCH_DECISIONS_FILE_PATTERN);
  assert.doesNotMatch("verify-done-decisions-2026-10-12T10.jsonl", CI_WATCH_DECISIONS_FILE_PATTERN);
});

test("the record holds numbers and names only: no command, path, url or branch", () => {
  const record = ciWatchRecord({ at: "2026-10-12T10:31:02.000Z", account: "acct", project: "app", sessionId: "s1", mode: "shadow", trigger: "push", outcome: "success", watchedMs: 187_400, ghCalls: 9, agentPolls: 4, agentSleeps: 3, notified: true, injected: false });
  assert.deepEqual(record, { at: "2026-10-12T10:31:02.000Z", account: "acct", project: "app", sessionId: "s1", mode: "shadow", trigger: "push", outcome: "success", watchedSeconds: 187, ghCalls: 9, agentPolls: 4, agentSleeps: 3, notified: true, injected: false });
  assert.deepEqual(Object.keys(record).filter((key) => /command|path|url|branch|sha/i.test(key)), []);
});

test("the summary counts watches, finished runs, gh calls, the agent's polls and sleeps it would have replaced, and notes sent, over the window", () => {
  const now = Date.parse("2026-10-12T12:00:00.000Z");
  const week = 7 * 24 * 3_600_000;
  const row = (at: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ at, outcome: "success", ghCalls: 10, agentPolls: 4, agentSleeps: 3, injected: false, ...extra });
  const summary = summarizeCiWatchRows(
    [
      row("2026-10-12T10:00:00.000Z"),
      row("2026-10-11T10:00:00.000Z", { outcome: "failure", agentPolls: 2, agentSleeps: 0, injected: true }),
      row("2026-10-10T10:00:00.000Z", { outcome: "no-runs", ghCalls: 3, agentPolls: 0, agentSleeps: 0 }),
      row("2026-10-01T10:00:00.000Z"),
      row("2026-10-13T10:00:00.000Z"),
      { at: "garbage" },
      "text",
      null,
    ],
    now,
    week,
  );
  assert.deepEqual(summary, { watches: 3, finished: 2, failed: 1, ghCalls: 23, pollsReplaced: 6, sleepsReplaced: 3, injected: 1 });
});

test("the summary of nothing is zeros, and says so", () => {
  assert.deepEqual(summarizeCiWatchRows([], Date.now(), 1000), { watches: 0, finished: 0, failed: 0, ghCalls: 0, pollsReplaced: 0, sleepsReplaced: 0, injected: 0 });
});

// ---------------------------------------------------------------------------
// C2: reading a tool.call outcome, and the merge commit of a pull request
// ---------------------------------------------------------------------------

test("a Bash outcome becomes a CiBashCall: the text the model read, the error flag and the engine's gitOperation", () => {
  const outcome = { result: { stdout: "out", stderr: "err", interrupted: false, gitOperation: { push: { branch: "feat/x" } } }, text: "out\nerr", ref: 3 };
  assert.deepEqual(ciBashCallFrom("git push", outcome), { command: "git push", isError: false, output: "out\nerr", gitOperation: { push: { branch: "feat/x" } } });
  assert.equal(ciBashCallFrom("git push", { ...outcome, isError: true })?.isError, true);
  assert.equal(ciBashCallFrom("git push", { result: { stdout: "o", stderr: "e" } })?.output, "o\ne", "no text: stdout and stderr");
  assert.equal(ciBashCallFrom("git push", { result: "ok" })?.gitOperation, undefined);
});

test("a denied or unreadable outcome is no call at all", () => {
  assert.equal(ciBashCallFrom("git push", { deny: "blocked" }), null);
  for (const bad of [null, undefined, "x", 3, []]) assert.equal(ciBashCallFrom("git push", bad), null, String(bad));
});

test("couldStartCiWatch is the cheap filter before any lookup: a push or pull-request command, or an engine report", () => {
  assert.equal(couldStartCiWatch("git push", false), true);
  assert.equal(couldStartCiWatch("cd x && git -C y push origin main", false), true);
  assert.equal(couldStartCiWatch("gh pr create --fill", false), true);
  assert.equal(couldStartCiWatch("gh pr merge 5", false), true);
  assert.equal(couldStartCiWatch("./ship.sh", true), true);
  assert.equal(couldStartCiWatch("ls -la", false), false);
  assert.equal(couldStartCiWatch("git status", false), false);
  assert.equal(couldStartCiWatch("gh pr list", false), false);
});

test("gh pr view --json mergeCommit,baseRefName: the merge commit and the branch it landed on; none while the merge is queued", () => {
  assert.deepEqual(parsePrMergeView(JSON.stringify({ mergeCommit: { oid: SHA }, baseRefName: "main" })), { sha: SHA, branch: "main" });
  assert.equal(parsePrMergeView(JSON.stringify({ mergeCommit: null, baseRefName: "main" })), null);
  assert.equal(parsePrMergeView(JSON.stringify({ baseRefName: "main" })), null);
  assert.equal(parsePrMergeView(JSON.stringify({ mergeCommit: { oid: "" }, baseRefName: "main" })), null);
  assert.deepEqual(parsePrMergeView(JSON.stringify({ mergeCommit: { oid: SHA } })), { sha: SHA, branch: null });
  for (const bad of ["", "x", "[]", "null"]) assert.equal(parsePrMergeView(bad), null, bad);
});
