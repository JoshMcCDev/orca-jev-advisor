# Backlog

Things worth doing, not started. Each entry says what it is, why, and the
first thing to verify — because several ideas in this project died on a
contract nobody checked first.

---

## Jev picks the agent and model by the effort a task needs

**What.** Orca launches agents. Today the model is chosen by hand. Jev already
scores effort for two other things — which skill fits a prompt, which tool fits
a turn — so scoring "how much model does this task need" is the same shape,
not a new capability. A small, well-specified task goes to a fast model
(Haiku, Sonnet); a large or ambiguous one goes to a stronger one (Opus, Fable).
The choice should also be able to reach the other accounts configured in Orca,
not only the Claude ones.

**Why.** It is the same goal as the rest of this plugin stated plainly by its
owner: speed with fewer tokens. A large model is slow at deciding and expensive
in context; sending a mechanical task to it wastes both. Picking the model is
itself a decision, and decisions are what Jev is for.

**Feasibility: answered, and it is no — today.** Traced through Orca's source
with citations:

- `contributes.agents` exists (`plugin-manifest.ts:142`) but is **inert**. Its
  schema is a bare `{ path }` (`plugin-content-pack-contributions.ts:55`), and
  no parser for that file exists anywhere — compare
  `parsePluginVmRecipeArtifact` (`plugin-vm-recipe-artifact.ts:40`), which is
  what a real one looks like. Its only consumer is a byte-size check
  (`plugin-artifact-validation.ts:82`). A plugin can declare an agent profile
  and nothing will ever read it.
- A plugin **automation** can choose the agent BINARY but never a model:
  `pluginAgentAutomationSchema` carries `provider` and no model field
  (`plugin-automation-contribution.ts:65`).
- The model is decided from **global settings**, per agent type, not per task:
  `resolveTuiAgentLaunchArgs` reads `settings.agentDefaultArgs`
  (`tui-agent-launch-defaults.ts:82`), and chat-mode options come from
  `settings.nativeChatSessionOptions`.
- No plugin surface reaches that decision. The host API's whole method table
  (`plugin-host-method-bindings.ts:71-166`) has nothing for it, and
  `settings.set` is scoped to the plugin's own namespace.

The one adjacent capability: `terminal.sendText` could type a CLI's own
`/model` command into an ALREADY-RUNNING pane. That is reconfiguring a session
that already started on whatever Settings chose — not choosing at launch — and
building on it would be a workaround, not a feature.

**So the question stops being "can a plugin do this" and becomes "what do we
add to Orca", because Orca is ours.** Three candidates, smallest first:

1. Give `pluginAgentAutomationSchema` a model/session-options field and thread
   it through `plugin-automation-managed-fields.ts:66` into
   `headless-workspace-create.ts:43`, beside `startupAgent`.
2. Make the per-launch override reachable from a plugin. `agentArgs` already
   exists as a parameter on `LaunchAgentInNewTabArgs`
   (`launch-agent-in-new-tab.ts:37`) — it simply has no plugin-facing entry
   point. A capability-gated host method, gated as `terminal.sendText` is,
   would close it.
3. Actually implement the agent-profile artifact: a
   `parsePluginAgentProfileArtifact` mirroring the VM recipe one, with a schema
   carrying a model id and an account hint, and a registry the launch UI reads.

Option 2 is the smallest and the most general. Option 3 is the one that makes
`contributes.agents` mean something instead of being a declared-but-dead
contribution point.

**Accounts.** Orca already models the other providers as distinct agent
binaries — `claude`, `codex`, and `claude-zai`, the z.ai/GLM wrapper with its
own isolated config directory (`tui-agent-config.ts:12-70`). So "route to the Z
account" is expressible as an agent identity today; what is missing is only the
model choice within one, and any automatic routing at all.

**Then, and only then:** what the effort signal is measured against. A model
choice never checked against how the task actually went is a preference dressed
as a decision -- the same trap as an unmeasured threshold. Measurement mode
first, active mode only once there is data, exactly as the skills mod is
sequenced.

---

## Policy seeds cannot be updated once imported

The import merges by id and skips what you already have, so a corrected
baseline never reaches anyone who imported the old one. Needs a way to see what
differs and choose, never a blind overwrite — that would destroy edited
policies.

---

## Test isolation is opt-in, and it has failed three times

`mirrorCatalogAndPolicies` and `activate()` spawn subprocesses that write to the
real `~/.config/orca-supervisor/`, regardless of any fake host injected at the
module boundary. Three separate runs reached the developer's real files; one
destroyed their policies, recovered from Orca's plugin storage. The current
guard is an `options.mirror` override each test must remember to pass. The
durable fix is in `src/core/paths.ts`: refuse a real production path under test,
or honour an env override on every platform rather than XDG on Linux only.

---

## Nobody has run this on Windows or Linux

Implemented and unit-tested on both; executed on neither. The Windows path in
particular carries the `shell: true` decision for `.cmd` resolution and the
current-directory exposure that comes with it, and a symlink question that Node
answers differently there.

---

## Measurement-mode sampling for the skills mod

Two Jev calls per prompt, on every prompt, for data that is invisible until the
thresholds exist. Sampling a fraction would collect the same distribution at a
fraction of the load. Do this only after the mod has run long enough to know
what the distribution looks like — sampling a thing you have never observed is
how you miss the tail.

---

## Ideas from similar tools (reviewed 2026-10-10)

Source for this group: [toolgate](https://github.com/RiskAverseTech/toolgate)
0.16.0 (commit `87e26c1`), a Claude Code gate on Jev with the same shape as
ours, which publishes its measurements. They are ranked by expected value.
None of them is verified against our data yet. The first step of each one
is that verification.

### The task the person asked for softens the gate

**What.** toolgate sends Jev the latest user prompt, the two before it and
the session's first substantive request (`session_goal`). It adds an
`authorized` question: does the task explicitly call for this action? When it
does, each verdict softens one step, except secret exposure and explicit
prohibitions. Our gate state (`buildActionGateState`, `src/core/decisions.ts:916`) carries
the command, the destination and `branchEffect`, and nothing of what the person
asked for.

**Why.** Advice on work the person explicitly requested is the noise the
owner keeps hitting. Remembered delivery authorizations (0.6.28) cover only
five delivery classes. Their lesson is to use more than the latest prompt,
which in a working session is usually "yes" or "go ahead". Their `off_task`
axis caused most of their friction, so they capped it at ask.

**First thing to verify.** Replay the advised commands from the 0.6.28 measurement
set (834) with the three prompts and the session goal added to the state, and
count how many an `authorized` answer of 0.8 or more would soften. Do the same
for the 31 must-stop commands, which must still stop. Also measure the added
latency and what extra text leaves the machine.

### Write a file, then run it: the action ledger

**What.** When the agent writes a file, toolgate's gate also asks four
capability questions about the content: if executed, would it read secrets,
send data out, destroy data, or change privilege? It stores the booleans
(never the content) per session. When a later Bash call runs that path
(`bash x.sh`, `python x.py`, `./x`, `npm run` after `package.json` changed),
the command is judged by what the file does. A run that arrives before the
write is confirmed is floored at ask. Our file gate
(`adapters/claude/gate-files.ts`) only protects the plugin's own files; it
does not judge content.

**Why.** It is the one composition our gate cannot see: a freshly written
script looks harmless when it runs. toolgate's set 7 separated every pair by
ledger facts alone, with no dangerous allow.

**First thing to verify.** How often real transcripts contain a Write or Edit
followed by a Bash call that executes the same path, and how many of those
our gate allowed. If it is rare, this is a security feature with low
friction cost. If it is common, the extra Jev call on writes has a price.

### Frozen challenge sets for the gate

**What.** toolgate keeps small labelled sets (`docs/challenge-set-*.json`). Each
set is labelled before it is run, built in matched pairs (inert text against
the same effect performed), and run once per pinned build by
`scripts/challenge.mjs`.

**Why.** We measure on real logs, which finds friction, but a change to a
question's wording has no fixed regression to pass. The 31 must-stop commands
from 0.6.28 are already a seed set.

**First thing to verify.** Whether the 0.6.28 must-stop list and the 834
advised commands can be frozen into one JSON set and run against the gate
with no hook process.

### Project rules from CLAUDE.md as gate context

**What.** toolgate's roadmap item 11 (from Abide) lifts the explicit "never"
and "only" lines from the project's CLAUDE.md and AGENTS.md and passes them
to Jev as `project_constraints`.

**Why.** Rules stated once in the project would count on every call without
being copied into team policies.

**Caution from Abide** (coldteadotai/abide, which does exactly this for edits).
In their replay benchmark, edit-level precision was 26% and turn-level
precision was 73% (`benchmarks/replay/README.md`). The design that held up
compiles the instruction files into a rubric once, scopes each rule by glob,
and detects staleness with a hash. Only verdicts of 0.8 or more reach the
agent; verdicts from 0.5 to 0.8 are notes for the person.

**First thing to verify.** Which of our seeded policies already duplicate
CLAUDE.md lines, and whether extracting them adds signal or only noise to
the state. Review Abide before designing this.

### A `doctor` that proves the whole chain

**What.** `toolgate doctor` checks that the key is present, picks the backend,
gets one live verdict with its latency, and confirms the hook is installed
and answers under the minimal environment of a Dock-launched app.

**We already have most of it.** `advisor.doctor` (`cmdDoctor`,
`adapters/orca/main.mjs:2830`) checks the key against a real Jev call, CLI
reachability, the catalog, the secret mirror and the Claude Code integration.
What toolgate adds is running the installed hook itself under a minimal
environment and timing the verdict.

**Why.** Several of our incidents (the 0.6.10 reinstall, plugin errors that
only appear in memory) were cases where the integration existed but the
installed copy was the wrong one.

**First thing to verify.** Whether `cmdDoctor` would have caught the 0.6.10
reinstall. If it would not, the gap is checking the installed hook's version
and getting a real answer from it.

### The steward's harm measure: what the person asked next

**What.** [compact-adviser](https://github.com/kunchenguid/compact-adviser),
the direct competitor to our context steward, labels each checkpoint by the
user's next request: `context_need` is `none`, `tail`, `artifact` or `older`.
Only `older` means compacting would have hurt
(`packages/pi-extension/eval/README.md`). Their decision is a composed score,
P(finished) × (0.5 + 0.5 × P(hands_on)), with a floor that slides from 0.90 to
0.50 as context fills (`packages/claude-mod/lib/judge.ts:240-299`). Ours is an
argmax confidence of 0.7 or more plus fixed tiers
(`src/core/context_steward.ts`, `decideSteward`).

**Why.** 0.6.27 measures what a compaction saves, but nothing measures what a
wrong one costs. Without that, the threshold cannot be tuned in either
direction.

**First thing to verify.** Whether our steward decision log plus the
transcripts are enough to label `context_need` for the 50 compactions of the
0.6.27 week. Consider the sliding floor only after that.

### The steward stays out of non-interactive sessions

**What.** compact-adviser goes inert when the session is not interactive
(`register.ts:854`, `isInteractive`). Our steward never checks it: the field
is declared in `adapters/claude/mod-skills/claude-code.d.ts` and used nowhere.

**First thing to verify.** Whether the mod loads under `claude -p` at all. If
it does, this is a one-line guard with a test.

### Gate MCP tools, judged against the goal

**What.** [jev-browser](https://github.com/Ying-Kai-Liao/jev-browser) asks
whether the next action toward `task.goal` has an effect outside the browser
that is hard to undo. Above 0.6 it stops with `needs_confirmation`, unless
an explicit `allow_irreversible` flag authorizes it
(`src/session.mjs:285, 484-487, 535-537`). Our hooks match Bash, Agent and the
edit tools only (`adapters/orca/install-claude-integration.mjs:22-29`), so a
Slack send, a Plane delete or a Lune page delete through MCP is never judged.

**Why.** These are the actions with effects outside the machine: messages to
other people, and deletes in shared systems. That is what the owner wants
stopped.

**First thing to verify.** How many `mcp__*` calls the last week of
transcripts holds, and which of them are writes. A read-only MCP call should
never cost a Jev call. This shares the goal-in-state work with the `authorized`
idea above, so design the two together.

### Shadow mode for a new gate layer

**What.** [jev-belay](https://github.com/valentynkit/jev-belay) runs its full
pipeline and lets the turn end. The would-have-blocked line goes only to the
person (`belay.mjs:749-769`). Jev_steer_or_queue ships in shadow by default.

**Why.** A new skip layer like the ones in 0.6.28 could run live for a week,
and be measured on real work, before it decides anything.

**First thing to verify.** Where the gate log already records enough to
compare "what shadow would do" with "what happened", so shadow is only a
switch and a log field.

### A replay corpus, intervals and a pass rule

**What.** Abide replays past transcripts through its judge
(`lib/replay.ts`), and jev-belay extracts a labelled corpus. Before shipping
as a blocker, belay requires AUROC of at least 0.6 and at least 0.08 over the
baseline (`tools/measure.mjs:174`), and prints a bootstrap interval next to
every figure. Belay also measured the value of facts: giving Jev the run
facts raised AUROC from 0.777 to 0.976. That is the strongest evidence yet
for the write-then-run ledger above.

**Why.** It is the substrate the frozen challenge sets and the `authorized`
check both need. Our measurements report bare figures with no interval.

**First thing to verify.** Whether `scratchpad/mine_advise.py` (0.6.28) can
become a committed replay script that runs the gate in-process over a frozen
corpus.

### Dead and noisy questions in `jev-health`

**What.** Abide calls a rule dead when its median is at least 0.25 and its max
stays under 0.7, and noisy when it fires on 60% or more of real items
(`packages/cli/src/lib/calibration.ts:4-35`). We have `jev-health usage` and
`flips` (`src/core/jev_health_usage.ts`), but no such verdict per gate
question or policy.

**First thing to verify.** Whether the gate log keeps every question's score,
not only the deciding one.

Reviewed with nothing to take for the gate or the steward:
- [quicksilver](https://github.com/UditAkhourii/quicksilver) offloads bulk
  classification to Jev. Only its benchmark method is of interest: it charges
  the skill's own tokens and subtracts a control floor.
- [jev-seo](https://github.com/AgriciDaniel/jev-seo) is a site audit. It A/B
  tests question wording against a blind second judge
  (`references/evaluation.md`), which fits the replay corpus once it exists.
- [Jev_steer_or_queue](https://github.com/Larkspur-Wang/Jev_steer_or_queue)
  classifies mid-turn messages. Its lessons, shadow by default and logging
  `jev: null` on a failure, are covered above and since 0.6.21.

---

## Everything below was done on 2026-09-24 and is no longer backlog

The four findings from `MEJORAS-JEV-ADVISOR.md` were verified and then fixed
on `feat/advisor-board-charts`, not deferred:

- **Silent fail-open** -- `GateSource` gains `'none'`, recorded on the
  pass-through, with one notice after three consecutive failures
  (`909536a`), and the board shows the unjudged slice (`8172970`).
- **Panel not crossing the switches with the copy on disk** -- `20a9a2a`.
- **Measurement mode with no sampling and no activation metric** --
  `mod_skills_sampling.ts` (25% of prompts, 40/day, fail-open) and
  `mod_skills_readiness.ts` (1000 comparable prompts at a 70% match rate),
  with the panel rendering how far off the threshold is.
- **Windows symlink** -- already resolved in 0.3.1, which replaced the
  symlink with a copy. Only the README still described the deleted code
  (`9484732`).

The upstream issue (no event fires when a hook-originated `ask` is refused
under `bypassPermissions`) is drafted with counts verified against the real
log -- 61 pendings, 50 joined, 49 approved, 0 refused by a human -- and is
waiting on the repository owner to post it, since it publishes under their
account.
