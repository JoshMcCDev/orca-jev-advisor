// The feature-module registry (odd/tasks/feature-modules.md, T1): one pure
// list of the modules the owner can turn off, what each owns (settings.json
// hook entries, features of the shared mod copy, worker jobs, existing
// modes), and the parser of `<configDir>/feature-modules.json`.
//
// The installer has no exported list of its hook entries (hookSpecs is
// private to install-claude-integration.mjs), so the ownership test checks
// the registry against INSTALLED_HOOKS below, a fixed list mirroring the
// installer's header, and checks that list against the `{ event, matcher,
// owner: hookOwner('<script>' ...` rows of hookSpecs read from the
// installer's own source, so a hook added there without an owner here fails.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  DEFAULT_FEATURE_MODULES,
  FEATURE_MODULES,
  FEATURE_MODULES_FILE,
  MODULE_IDS,
  effectiveMode,
  hooksFor,
  modCopyNeeded,
  modFeaturesOn,
  moduleState,
  parseFeatureModules,
  switchMode,
  workerJobsOn,
} from "./feature_modules.ts";
import type { FeatureMode, FeatureModules, HookEntry, ModuleId, ModuleState } from "./feature_modules.ts";

/** The eight entries install-claude-integration.mjs installs today (its header and hookSpecs). */
const INSTALLED_HOOKS: readonly HookEntry[] = [
  { event: "PreToolUse", matcher: "Bash", script: "gate-bash.ts" },
  { event: "PostToolUse", matcher: "Bash", script: "gate-outcome.ts" },
  { event: "PermissionDenied", matcher: "Bash", script: "gate-outcome.ts" },
  { event: "PostToolUseFailure", matcher: "Bash", script: "gate-outcome.ts" },
  { event: "PreToolUse", matcher: "Agent", script: "agent-model.ts" },
  { event: "PostToolUse", matcher: "Agent", script: "agent-model.ts" },
  { event: "PostToolUseFailure", matcher: "Agent", script: "agent-model.ts" },
  { event: "PreToolUse", matcher: "Edit|Write|MultiEdit|NotebookEdit", script: "gate-files.mjs" },
];

const hookKey = (hook: HookEntry): string => `${hook.event} ${hook.matcher} ${hook.script}`;

function withStates(states: Partial<Record<ModuleId, ModuleState>>): FeatureModules {
  return { ...DEFAULT_FEATURE_MODULES, ...states };
}

function fileWith(modules: unknown): string {
  return JSON.stringify({ modules });
}

/** hookSpecs' rows, read from the installer's source, as hookKey strings: event, matcher (FILE_TOOLS_MATCHER resolved) and the script hookOwner names. */
function installerHookKeys(): readonly string[] {
  const source = readFileSync(new URL("../../adapters/orca/install-claude-integration.mjs", import.meta.url), "utf8");
  const fileTools = /const FILE_TOOLS_MATCHER = '([^']+)'/.exec(source)?.[1];
  assert.ok(fileTools !== undefined, "FILE_TOOLS_MATCHER is declared in the installer");
  const rows = [...source.matchAll(/\{ event: '(\w+)', matcher: ('[^']+'|FILE_TOOLS_MATCHER), owner: hookOwner\('([^']+)'/g)];
  return rows.map((row) => `${row[1] ?? ""} ${row[2] === "FILE_TOOLS_MATCHER" ? fileTools : (row[2] ?? "").slice(1, -1)} ${row[3] ?? ""}`);
}

test("the registry holds exactly the five modules, in MODULE_IDS order", () => {
  assert.deepEqual(MODULE_IDS, ["gate", "model-router", "steward", "skill-selection", "board"]);
  assert.deepEqual(FEATURE_MODULES.map((module) => module.id), MODULE_IDS);
});

test("the module file lives in the config dir as feature-modules.json", () => {
  assert.equal(FEATURE_MODULES_FILE, "feature-modules.json");
});

test("the registry module is pure: no node: import, so the mod sandbox can load it", () => {
  const source = readFileSync(new URL("./feature_modules.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from "node:/);
});

test("defaults: every module is active, so an upgrade with no file keeps 0.6.28 behaviour", () => {
  assert.deepEqual(DEFAULT_FEATURE_MODULES, { gate: "active", "model-router": "active", steward: "active", "skill-selection": "active", board: "active" });
  for (const module of FEATURE_MODULES) assert.equal(module.defaultState, "active", module.id);
  assert.deepEqual(parseFeatureModules(""), DEFAULT_FEATURE_MODULES);
});

test("defaults: each feature's own mode decides, exactly as today", () => {
  const modules = parseFeatureModules("");
  // The router, the steward and the work kind default to measure; the skills mod's two switches to measurement.
  assert.equal(effectiveMode(moduleState(modules, "model-router"), "measure"), "measure");
  assert.equal(effectiveMode(moduleState(modules, "model-router"), "active"), "active");
  assert.equal(effectiveMode(moduleState(modules, "model-router"), "off"), "off");
  assert.equal(effectiveMode(moduleState(modules, "steward"), "measure"), "measure");
  assert.equal(effectiveMode(moduleState(modules, "skill-selection"), switchMode(false)), "measure");
  assert.equal(effectiveMode(moduleState(modules, "skill-selection"), switchMode(true)), "active");
  assert.equal(effectiveMode(moduleState(modules, "gate"), "active"), "active");
});

test("defaults: every installed hook, every mod feature and every worker job stays on", () => {
  const modules = parseFeatureModules("");
  assert.deepEqual(new Set(hooksFor(modules).map(hookKey)), new Set(INSTALLED_HOOKS.map(hookKey)));
  assert.equal(hooksFor(modules).length, INSTALLED_HOOKS.length);
  assert.deepEqual(new Set(modFeaturesOn(modules)), new Set(FEATURE_MODULES.flatMap((module) => module.modFeatures.map((feature) => feature.id))));
  assert.equal(modCopyNeeded(modules), true);
  assert.deepEqual(new Set(workerJobsOn(modules)), new Set(FEATURE_MODULES.flatMap((module) => module.workerJobs.map((job) => job.id))));
});

test("parse: a valid file sets each module's state", () => {
  const modules = parseFeatureModules(fileWith({ gate: "off", "model-router": "shadow", steward: "off", "skill-selection": "shadow", board: "off" }));
  assert.deepEqual(modules, { gate: "off", "model-router": "shadow", steward: "off", "skill-selection": "shadow", board: "off" });
});

test("parse: malformed or non-object content falls back to the defaults, never throws", () => {
  for (const content of ["{", "null", "123", '"active"', "[]", "true", JSON.stringify({ modules: null }), JSON.stringify({ modules: [] }), JSON.stringify({ modules: "off" }), JSON.stringify({ gate: "off" })]) {
    assert.deepEqual(parseFeatureModules(content), DEFAULT_FEATURE_MODULES, content);
  }
});

test("parse: a wrong-typed or unknown state falls back for that module alone", () => {
  const modules = parseFeatureModules(fileWith({ gate: false, "model-router": "off", steward: 1, "skill-selection": "measure", board: null }));
  assert.deepEqual(modules, withStates({ "model-router": "off" }));
});

test("parse: unknown module ids are ignored", () => {
  const modules = parseFeatureModules('{"modules":{"steward":"off","jev-belay":"active","__proto__":"off","constructor":"off"}}');
  assert.deepEqual(modules, withStates({ steward: "off" }));
  assert.deepEqual(Object.keys(modules), MODULE_IDS);
});

test("parse: a state the module does not support falls back to its default", () => {
  // The gate and the board have no measure mode, so no shadow (a second shadow switch is never added).
  const modules = parseFeatureModules(fileWith({ gate: "shadow", board: "shadow", steward: "shadow" }));
  assert.deepEqual(modules, withStates({ steward: "shadow" }));
});

test("moduleState reads one module's state", () => {
  const modules = withStates({ steward: "off", "skill-selection": "shadow" });
  assert.equal(moduleState(modules, "steward"), "off");
  assert.equal(moduleState(modules, "skill-selection"), "shadow");
  assert.equal(moduleState(modules, "gate"), "active");
});

test("effectiveMode: off wins over every existing mode (zero Jev calls)", () => {
  for (const own of ["off", "measure", "active"] as const) assert.equal(effectiveMode("off", own), "off", own);
});

test("effectiveMode: shadow caps the existing mode at measure and never turns on an own off", () => {
  const expected: Record<FeatureMode, FeatureMode> = { off: "off", measure: "measure", active: "measure" };
  for (const own of ["off", "measure", "active"] as const) assert.equal(effectiveMode("shadow", own), expected[own], own);
});

test("effectiveMode: active leaves the existing mode to decide", () => {
  for (const own of ["off", "measure", "active"] as const) assert.equal(effectiveMode("active", own), own, own);
});

test("switchMode maps the skills mod's and the legacy model switch's boolean onto measure/active", () => {
  assert.equal(switchMode(false), "measure");
  assert.equal(switchMode(true), "active");
});

test("hooksFor: an off module's entries are left out; shadow keeps them", () => {
  const gateOff = hooksFor(withStates({ gate: "off" }));
  assert.deepEqual(gateOff.map((hook) => hook.script), ["agent-model.ts", "agent-model.ts", "agent-model.ts"]);
  const routerOff = hooksFor(withStates({ "model-router": "off" }));
  assert.deepEqual(new Set(routerOff.map((hook) => hook.script)), new Set(["gate-bash.ts", "gate-outcome.ts", "gate-files.mjs"]));
  assert.equal(routerOff.length, 5);
  assert.deepEqual(hooksFor(withStates({ gate: "off", "model-router": "off" })), []);
  assert.equal(hooksFor(withStates({ "model-router": "shadow" })).length, 8);
});

test("modFeaturesOn and modCopyNeeded: the mod copy stays while any mod module is on", () => {
  const skillsOff = withStates({ "skill-selection": "off" });
  assert.equal(modFeaturesOn(skillsOff).includes("skill-selection"), false);
  assert.equal(modFeaturesOn(skillsOff).includes("tool-selection"), false);
  assert.equal(modFeaturesOn(skillsOff).includes("router-tier"), true);
  assert.equal(modCopyNeeded(skillsOff), true);
  const modModulesOff = withStates({ "model-router": "off", steward: "off", "skill-selection": "off" });
  assert.deepEqual(modFeaturesOn(modModulesOff), []);
  assert.equal(modCopyNeeded(modModulesOff), false);
  assert.equal(modCopyNeeded(withStates({ gate: "off", board: "off" })), true);
  assert.equal(modCopyNeeded(withStates({ "model-router": "off", steward: "off", "skill-selection": "shadow" })), true);
});

test("workerJobsOn: a shared job runs while any owner is on, and is listed once", () => {
  const all = workerJobsOn(DEFAULT_FEATURE_MODULES);
  assert.equal(all.length, new Set(all).size);
  assert.equal(workerJobsOn(withStates({ gate: "off" })).includes("measurements-summary"), true);
  assert.equal(workerJobsOn(withStates({ gate: "off", "skill-selection": "off" })).includes("measurements-summary"), false);
  assert.equal(workerJobsOn(withStates({ "model-router": "off" })).includes("consumption-summary"), true);
  assert.equal(workerJobsOn(withStates({ "model-router": "off", steward: "off" })).includes("consumption-summary"), false);
  assert.equal(workerJobsOn(withStates({ gate: "off" })).includes("gate-authorizations"), false);
  const boardOff = workerJobsOn(withStates({ board: "off" }));
  for (const id of ["board-agent-status", "board-worktree-created", "board-worktree-removed"] as const) assert.equal(boardOff.includes(id), false, id);
  assert.deepEqual(workerJobsOn(withStates({ gate: "off", "model-router": "off", steward: "off", "skill-selection": "off", board: "off" })), []);
});

test("every hook the installer installs today is owned by exactly one module", () => {
  for (const hook of INSTALLED_HOOKS) {
    const owners = FEATURE_MODULES.filter((module) => module.hooks.some((owned) => hookKey(owned) === hookKey(hook)));
    assert.equal(owners.length, 1, hookKey(hook));
  }
  const registered = FEATURE_MODULES.flatMap((module) => module.hooks.map(hookKey));
  assert.deepEqual([...registered].sort(), INSTALLED_HOOKS.map(hookKey).sort());
});

test("the fixed hook list mirrors the installer's hookSpecs", () => {
  assert.deepEqual(installerHookKeys(), INSTALLED_HOOKS.map(hookKey));
});

test("every mod feature is owned by exactly one module, and job ids are unique per module", () => {
  const features = FEATURE_MODULES.flatMap((module) => module.modFeatures.map((feature) => feature.id));
  assert.equal(features.length, new Set(features).size);
  for (const module of FEATURE_MODULES) {
    const jobs = module.workerJobs.map((job) => job.id);
    assert.equal(jobs.length, new Set(jobs).size, module.id);
  }
});

test("a module offers shadow exactly when one of its existing modes has a measure value", () => {
  for (const module of FEATURE_MODULES) {
    const hasMeasure = module.modes.some((mode) => mode.shadowValue !== null);
    assert.equal(module.states.includes("shadow"), hasMeasure, module.id);
    assert.equal(module.states.includes(module.defaultState), true, module.id);
  }
});
