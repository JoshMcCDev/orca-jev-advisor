// Unit tests for gate_advice_text.ts's composeAdviceText -- pure input to
// pure output.

import assert from "node:assert/strict";
import test from "node:test";

import { affectedSegments, composeAdviceText, MODEL_RISK_REASON, modelRiskReasonFor } from "./gate_advice_text.ts";
import type { RecoverabilitySegmentResult } from "./git_recoverability.ts";

test("never contains the word REFUSED -- the model must be able to tell an advice apart from a hard stop", () => {
  const { modelText } = composeAdviceText({
    command: "rm -rf dist src/a.ts",
    reasons: ["it can't be undone", "the effect leaves this machine"],
    sessionEligibleForRetry: true,
  });
  assert.doesNotMatch(modelText, /REFUSED/i);
});

test("contains the retry clause when the session is eligible", () => {
  const { modelText } = composeAdviceText({
    command: "rm -rf dist",
    reasons: ["it can't be undone"],
    sessionEligibleForRetry: true,
  });
  assert.match(modelText, /run the same command again unchanged and it will go through/);
});

test("does not promise a retry pass when the session could not be identified", () => {
  const { modelText } = composeAdviceText({
    command: "rm -rf dist",
    reasons: ["it can't be undone"],
    sessionEligibleForRetry: false,
  });
  assert.doesNotMatch(modelText, /run the same command again unchanged and it will go through/);
  assert.match(modelText, /could not be identified/);
});

test("names concrete affected segments, at most two, never a tier-1a-safe one", () => {
  const { modelText } = composeAdviceText({
    command: "git status && rm -rf dist && terraform apply",
    reasons: ["it can't be undone"],
    sessionEligibleForRetry: true,
  });
  assert.doesNotMatch(modelText, /`git status`/);
  assert.match(modelText, /`rm -rf dist`/);
  assert.match(modelText, /`terraform apply`/);
});

test("affectedSegments truncates a long segment to about 80 chars", () => {
  const longArg = "x".repeat(120);
  const [segment] = affectedSegments(`echo ${longArg}`);
  assert.ok((segment?.length ?? 0) <= 80);
});

test("affectedSegments caps at two segments even when more are risky", () => {
  const segments = affectedSegments("rm -rf a && rm -rf b && rm -rf c");
  assert.equal(segments.length, 2);
});

test("carries plain-English reasons through, joined", () => {
  const { modelText } = composeAdviceText({
    command: "gh workflow run deploy.yml",
    reasons: ["it can't be undone and the effect leaves your machine", "other people will notice"],
    sessionEligibleForRetry: true,
  });
  assert.match(modelText, /it can't be undone and the effect leaves your machine/);
  assert.match(modelText, /other people will notice/);
});

test("recoverability naming: protected targets are named with why, and a safe rm alternative is offered", () => {
  const recoverability: readonly RecoverabilitySegmentResult[] = [
    {
      shape: "rm",
      classified: [
        { path: "dist", why: "build-or-temp", matchedBuildTempName: "dist" },
        { path: "src/a.ts", why: "uncommitted-changes" },
        { path: ".env", why: "secret" },
      ],
      unresolvedTargets: [],
    },
  ];
  const { modelText } = composeAdviceText({
    command: "rm -rf dist src/a.ts .env",
    reasons: ["it can't be undone"],
    recoverability,
    sessionEligibleForRetry: true,
  });
  assert.match(modelText, /src\/a\.ts \(uncommitted changes\)/);
  assert.match(modelText, /\.env \(looks like a secret\)/);
  assert.match(modelText, /rm -rf dist`/);
  assert.doesNotMatch(modelText, /dist \(/, "dist itself must never be named as protected");
});

test("recoverability naming: an unresolved target is said so, never guessed", () => {
  const recoverability: readonly RecoverabilitySegmentResult[] = [
    { shape: "rm", classified: [], unresolvedTargets: ["$TMP"] },
  ];
  const { modelText } = composeAdviceText({
    command: "rm -rf $TMP",
    reasons: ["it can't be undone"],
    recoverability,
    sessionEligibleForRetry: true,
  });
  assert.match(modelText, /Unresolved/);
  assert.match(modelText, /\$TMP/);
});

test("recoverability naming: nothing to say when every target is safe -- no sentence is added", () => {
  const recoverability: readonly RecoverabilitySegmentResult[] = [
    { shape: "rm", classified: [{ path: "dist", why: "build-or-temp", matchedBuildTempName: "dist" }], unresolvedTargets: [] },
  ];
  const { modelText } = composeAdviceText({
    command: "rm -rf dist",
    reasons: ["it can't be undone"],
    recoverability,
    sessionEligibleForRetry: true,
  });
  assert.doesNotMatch(modelText, /would lose work/);
});

test("effectSummary is a short phrase, useful for the person-facing status line", () => {
  const { effectSummary } = composeAdviceText({
    command: "rm -rf dist src/a.ts",
    reasons: ["it can't be undone"],
    sessionEligibleForRetry: true,
  });
  assert.equal(effectSummary, "it can't be undone");
});

test("empty reasons still produce a coherent, non-empty advice rather than an empty sentence", () => {
  const { modelText } = composeAdviceText({ command: "some-tool --flag", reasons: [], sessionEligibleForRetry: true });
  assert.ok(modelText.length > 0);
  assert.doesNotMatch(modelText, /Why: \.$/m);
});

test("personEffectSummary, when supplied, is what effectSummary carries -- never the English reasons text", () => {
  const { effectSummary } = composeAdviceText({
    command: "rm -rf dist",
    reasons: ["it can't be undone"],
    sessionEligibleForRetry: true,
    personEffectSummary: "queda justo en el límite",
  });
  assert.equal(effectSummary, "queda justo en el límite");
});

test("MODEL_RISK_REASON: every phrasing is written for the model, never 'you'/'your' (the person), never REFUSED", () => {
  for (const [key, phrasing] of Object.entries(MODEL_RISK_REASON)) {
    assert.doesNotMatch(phrasing as string, /\byou\b|\byour\b/i, `${key} addresses "you"`);
    assert.doesNotMatch(phrasing as string, /REFUSED/, `${key} contains REFUSED`);
  }
});

test("MODEL_RISK_REASON covers the near-limit case with model-appropriate text", () => {
  assert.match(MODEL_RISK_REASON["reason.tooCloseToTheLine"] as string, /Jev's risk score/);
});

// 0.6.15 T1 (N-11, qa-0.6.14): a heredoc body is not a command line, so its
// first statement is never named as what the command would run.
test("affectedSegments never names a line of a heredoc body", () => {
  const segments = affectedSegments(`node - <<'EOF'\nconst fs = require("fs")\nfs.writeFileSync("notes.md", "x")\nEOF`);
  assert.ok(!segments.some((segment) => segment.includes("require")), segments.join(" | "));
});

test("C2: the header names Clef when Clef judged, and stays Jev's otherwise", () => {
  const input = { command: "rm -rf dist", reasons: ["it can't be undone"], sessionEligibleForRetry: true };
  const jev = composeAdviceText(input).modelText;
  assert.equal(composeAdviceText({ ...input, judge: "jev" }).modelText, jev);
  assert.match(jev, /^Jev advice \(not a refusal\): /);
  const clef = composeAdviceText({ ...input, judge: "clef" }).modelText;
  assert.match(clef, /^Clef advice \(not a refusal\): /);
  assert.equal(clef.replace(/^Clef advice/, "Jev advice"), jev);
});

// 0.13.7 (odd/tasks/advice-no-repeat.md): the model wrote the command, so the
// advice never repeats it, nor an effect the command already makes obvious.
test("0.13.7: a single-segment deploy advice repeats neither the command nor its obvious effect", () => {
  const { modelText } = composeAdviceText({
    command: "gh workflow run lab-release.yml -R ab2webco/orca-oss --ref main",
    reasons: ["triggers a deployment workflow on GitHub Actions"],
    sessionEligibleForRetry: true,
  });
  assert.doesNotMatch(modelText, /It would run/);
  assert.doesNotMatch(modelText, /Why:/);
  assert.doesNotMatch(modelText, /triggers a deployment workflow/);
  assert.match(modelText, /^Jev advice \(not a refusal\): /);
  assert.match(modelText, /run the same command again unchanged and it will go through/);
});

test("0.13.7: obvious-effect and config-only reasons are dropped, specific ones kept, also from a cached joined reason", () => {
  const { modelText } = composeAdviceText({
    command: "some-tool --flag",
    reasons: [
      `${MODEL_RISK_REASON["reason.cannotUndoAndLeavesMachine"]} · if it is wrong, it breaks something that matters to someone`,
      "this directory doesn't match any catalog destination, so the global thresholds were used",
    ],
    sessionEligibleForRetry: true,
  });
  assert.doesNotMatch(modelText, /leaves this machine/);
  assert.doesNotMatch(modelText, /catalog destination/);
  assert.match(modelText, /Why: if it is wrong, it breaks something that matters to someone\./);
});

test("0.13.7: a command of one segment is not echoed back; a compound one still names the segments that concern", () => {
  assert.doesNotMatch(composeAdviceText({ command: "rm -rf dist", reasons: ["it can't be undone"], sessionEligibleForRetry: true }).modelText, /It would run/);
  assert.match(composeAdviceText({ command: "npm test && rm -rf dist", reasons: ["it can't be undone"], sessionEligibleForRetry: true }).modelText, /It would run: `rm -rf dist`\./);
});

test("0.13.7: the advice is shorter than before for the measured common case", () => {
  const { modelText } = composeAdviceText({
    command: "git push origin main",
    reasons: ["if it is wrong, it needs cleanup afterwards", MODEL_RISK_REASON["reason.cannotUndoAndLeavesMachine"] as string],
    sessionEligibleForRetry: true,
  });
  assert.ok(modelText.length < 300, `${modelText.length} chars: ${modelText}`);
});

test("C2: the model-facing risk reason names the judge", () => {
  assert.equal(modelRiskReasonFor("reason.tooCloseToTheLine", "jev"), MODEL_RISK_REASON["reason.tooCloseToTheLine"]);
  assert.equal(modelRiskReasonFor("reason.tooCloseToTheLine", "clef"), "Clef's risk score for this command is right at its limit");
  assert.equal(modelRiskReasonFor("reason.cannotUndo", "clef"), MODEL_RISK_REASON["reason.cannotUndo"]);
  assert.equal(modelRiskReasonFor("reason.allowClear", "clef"), undefined);
});
