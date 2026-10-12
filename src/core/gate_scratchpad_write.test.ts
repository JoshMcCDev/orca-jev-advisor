// Gate secret guard G6 (odd/tasks/gate-secret-guard.md): a real false
// positive. On 2026-10-12T18:53:59Z (gate-decisions-2026-10-12T18.jsonl, row
// bd21309a, source jev, verdict deny, policyId never_write_to_main), a
// background agent whose session sat in the main checkout ran a Python
// script that rewrote one file in its own scratchpad, under
// $CLAUDE_CODE_TMPDIR. Jev judged it a write on main.
//
// What the gate itself does with that command is right: Python is an
// interpreter, so the command is never "contained" (its code may write
// anywhere), and the place it acts in is the session's own checkout, so
// never_write_to_main survives the branch-reach filter. The fault was in what
// Jev read: every path is pseudonymised, and the scratchpad -- on another
// volume, not a system location -- became an opaque `<path-1>`, so nothing
// said the file being written was a temporary one outside the repository.
// The copy Jev reads now marks a temp-root path as `$TMPDIR/<path-N>`: still
// no name in clear, but the fact the judgment needs. Run with:
//   node --test --experimental-strip-types src/core/gate_scratchpad_write.test.ts

import assert from "node:assert/strict";
import test from "node:test";

import { branchReachPlaces } from "./branch_reach.ts";
import { isContainedToTempRoots, tempRootsFromEnvironment } from "./contained_effect.ts";
import { buildActionGateState } from "./decisions.ts";
import { createJevPseudonyms } from "./jev_pseudonyms.ts";

const HOME = "/Users/someone";
const SESSION = `${HOME}/Projects/orca-supervisor`;
const CLAUDE_TMP = "/Volumes/Data/claude-tmp";
const SCRATCHPAD = `${CLAUDE_TMP}/claude-501/-Users-someone-Projects-orca-supervisor/8a7f5770-85e2-4d02-8cfe-4bf762b7023d/scratchpad`;

// The refused command's shape, as the agent wrote it: the file in a variable,
// a quoted heredoc handing Python its script, then a grep of the result.
const COMMAND = `F=${SCRATCHPAD}/mods-review.md; python3 -I - "$F" <<'EOF'
import sys
p=sys.argv[1]; s=open(p).read()
s=s.replace("a","b")
open(p,"w").write(s)
EOF
grep -n "Status" "$F"`;

const TEMP_ROOTS = tempRootsFromEnvironment({ HOME, CLAUDE_CODE_TMPDIR: CLAUDE_TMP }, "/var/folders/xy/T", 501);
const CONTEXT = "repository orca-supervisor, branch main, this is the shared main branch, clean";

test("G6 reproduction: an interpreter's write is never contained, and the session's main checkout is where it acts", () => {
  assert.ok(TEMP_ROOTS.includes(`${CLAUDE_TMP}/claude-501`), "the scratchpad sits in a temp root the environment names");
  assert.equal(
    isContainedToTempRoots(COMMAND, { tempRoots: TEMP_ROOTS, cwd: SESSION, env: { HOME, CLAUDE_CODE_TMPDIR: CLAUDE_TMP }, realpath: (path) => path, sessionRepoRoot: SESSION, isLinkedWorktree: () => false }),
    false,
    "Python may write anywhere: never contained",
  );
  assert.ok(branchReachPlaces(COMMAND, SESSION, HOME).includes(SESSION), "so a protected-branch policy still reaches it");
});

test("G6 reproduction: without temp roots, Jev reads the scratchpad as an opaque path, the cause of the deny", () => {
  const state = buildActionGateState(COMMAND, CONTEXT, undefined, undefined, createJevPseudonyms());
  assert.match(String(state["proposed_command"]), /^F=<path-1>; python3/);
});

test("G6: Jev reads a temp-root path as a temporary one, never in clear", () => {
  const state = buildActionGateState(COMMAND, CONTEXT, undefined, undefined, createJevPseudonyms({ tempRoots: TEMP_ROOTS }));
  const proposed = String(state["proposed_command"]);
  assert.match(proposed, /^F=\$TMPDIR\/<path-1>; python3/);
  assert.ok(!proposed.includes(CLAUDE_TMP) && !proposed.includes("orca-supervisor"), proposed);
});

test("G6: a path outside every temp root, the home directory and a repository stay as before", () => {
  const names = createJevPseudonyms({ tempRoots: TEMP_ROOTS });
  assert.equal(names.redactText(`cp ${SESSION}/a.md ${SCRATCHPAD}/a.md`), "cp <path-1> $TMPDIR/<path-2>");
  assert.equal(names.redactText(`cat ${SCRATCHPAD}/a.md`), "cat $TMPDIR/<path-2>", "the same path keeps its placeholder");
  assert.equal(names.name("path", `${SCRATCHPAD}/a.md`), "$TMPDIR/<path-2>");
  assert.equal(names.redactText("rm -rf /Volumes/Data/claude-tmp-other/x"), "rm -rf <path-3>", "a sibling of a temp root is not inside it");
  assert.equal(names.redactText("ls /tmp/x ~/notes"), "ls /tmp/x <path-4>");
});
