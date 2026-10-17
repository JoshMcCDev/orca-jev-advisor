# Multi-provider decisions: Jev, Cloudflare Clef, or both

## Objective

The owner chooses which decision provider the plugin uses: **Jev**, **Clef** (Cloudflare Workers AI), or **both**. With both:
- Clef answers first and spends the free daily allowance.
- Jev answers when Clef is in doubt, when Clef fails, or when Clef's daily allowance is spent.

Every module keeps working as today with Jev alone. More providers can be added later as one new file.

## Evidence (2026-10-16 probe, 51 commands, real gate questions)

- **Contract.** Clef speaks the System One contract: the same request shape and the same `{model, answers, usage}` response.
- **Named noul criteria.** Clef rejects them with HTTP 422 "Extra inputs are not permitted". It accepts only `criteria: {true, false}`. Named criteria must become `criteria.true`.
- **Agreement and latency (p50 / p95):**

  | Model | Latency (ms) | Agrees with Jev |
  |---|---|---|
  | Jev | 156 / 231 | — |
  | clef | 394 / 1023 | 46/51 |
  | clef-flash | 497 / 601 | 46/51 |
  | clef-omni | 273 / 415 | 44/51 |

- **Gate doubt.** The gate's verdict depends only on `consequence` against the line (`GATE_CONSEQUENCE_CEILING - CONSEQUENCE_NOISE_MARGIN` = 1.66). Rule tested: escalate to Jev when |score − 1.66| < 0.2.

  | Model | Sent to Jev | Final verdict differs from Jev |
  |---|---|---|
  | clef | 10/51 | 0/51 |
  | flash | 14/51 | 1/51 |
  | omni | 7/51 | 4/51 |

- **Pricing.** Workers AI gives 10,000 free neurons per day, reset at 00:00 UTC. Neurons per million input tokens: clef 21,818; omni 13,636; flash 3,455. Output tokens are free. One gate call is about 480 input tokens.
- **Volume.** The owner's gate makes 1,500–2,500 Jev calls per day.

## Scope

- One provider layer behind the existing `callJev` entry point. Every caller keeps its call.
- A Cloudflare provider covering the endpoint, the account id plus token auth, the `{result}` envelope, the noul-criteria mapping and the limits (64 questions, 2–10 score levels).
- Mode (Jev / Clef / both) and the Clef model, chosen in the config panel. The Cloudflare token goes in the plugin's secrets store next to the Jev key.
- Both mode works as a cascade:
  - Clef answers first.
  - Jev answers on doubt, on failure, or once the day's neuron budget is spent.
  - Doubt is a predicate each caller supplies (the gate: consequence near the line), with a generic default.
- The board shows, per window: who answered, how often doubt escalated, neurons used against the free allowance, and failovers.

## Tasks

- [x] P1. A provider interface plus the Jev provider. `callJev` routes through it; behaviour is unchanged (all existing tests pass).
- [x] P2. A Cloudflare Clef provider: request mapping (noul criteria), envelope unwrap, error classes (auth, quota/429, 5xx, timeout), usage to neurons.
- [x] P3. A daily neuron budget: a counter keyed by UTC day in the cache dir. Once spent, or when Cloudflare reports the quota as exhausted, Clef is skipped until the next UTC day.
- [x] P4. The cascade in both mode: Clef, then Jev on doubt, failure or spent budget. Doubt is a per-call predicate; the gate's is consequence within 0.2 of its line; there is a generic default for the rest. Each decision records which provider answered and why it escalated.
- [x] P5. Keys and settings reach every runtime the Jev key reaches today: the worker, the gate hook, the router hook, the mod (options) and the CLIs. Settings are the mode and the Clef model (default `clef`).
- [x] P6. A config panel section: provider mode, Clef model, Cloudflare account id and token (stored as a secret, shown masked), and a connection test.
- [x] P7. A board section: answers by provider, doubt escalations, neurons against 10k, and failovers, following the global window.
- [ ] P8. Release, live check and `odd/qa/qa-<version>.md`.

## Acceptance

- Jev-only mode is byte-for-byte today's behaviour.
- Clef-only mode works with no Jev key. Both mode works with either key missing, falling back to the other.
- Replaying the 51-command corpus in both mode gives the same verdicts as Jev, sending at most 25% of the calls to Jev.
- The free budget is never exceeded silently: the board shows the switch to Jev.
- No secret is ever logged, written outside the secrets store or the documented fallback files, or shown unmasked.

## Checks

`npm test`, `npm run typecheck`, `npm run test:panels`, panel screenshots (the changed sections, at 1440 and 390), and a live replay on the installed plugin.

## Review notes (advisor, 2026-10-16), binding on the build

1. **Default stays Jev after an upgrade.** Clef and both are strictly opt-in, so existing installs (the partner's Linux machine included) behave as before.
2. **"A provider is available", not "a Jev key exists".** Today a missing Jev key takes the no-key branch before any model call. That branch exists in gate-bash, the mod's `resolveApiKey`, the router's key check, the worker's `api-key` health check and the no-key notice. Each one must accept the Cloudflare credentials too.
3. **Find how the gate hook received the Jev key before 2026-10-16.**
   - Before that date there was no env var and no `~/.config/orca-supervisor/env`, yet about 2,000 `source:"jev"` rows a day.
   - The worker's secret mirror (`write-secret-mirror.mjs`) is the likely path. Deliver the Cloudflare credentials the same way.
   - The live check runs only after the owner's hand-made plaintext files are deleted. It is proven by `provider: clef` rows in the installed gate's log.
4. **The manifest's `net:fetch` hosts must include `api.cloudflare.com`.** Check whether the mod's `$.http.fetch` has its own host restriction.
5. **Split the latency budget.** Clef gets a sub-budget that always leaves room for a full Jev call (Jev p95 is about 230 ms). A Clef timeout escalates to Jev and never fails open while Jev is reachable.
6. **One provider's answers per decision.** On escalation, Jev is re-asked every question and only Jev's answers are used. Clef and Jev answers are never mixed.
7. **Gate doubt.**
   - Use the effective per-destination ceiling: `consequenceCeiling - CONSEQUENCE_NOISE_MARGIN`, not a hardcoded 1.66.
   - Any command-scoped policy question escalates.
   - More than 64 questions goes straight to Jev, recorded as `unsupported`, not as a failure.
8. **The neuron budget is the only stop.**
   - On Workers Paid, going past the free allowance bills the account instead of failing, so stop with a margin below 10k.
   - Use an append-only ledger: the mod's `appendToFile` reads and then rewrites, and loses rows under concurrency.
   - A per-minute rate limit escalates that one call. A daily-allowance error skips Clef until 00:00 UTC.
9. **The meaning of `source` stays unchanged.** Add `provider` and `escalation` fields. First find every reader of `source:"jev"`: the board, `gate-decisions-totals.json` and the QA scripts.
10. **Secrets.** Read what `secret_redaction.ts` asks the model.
    - If its state can hold a secret, pin it to Jev; the owner's rule is that a secret never reaches a new remote silently.
    - The panel says what Clef receives (the skill and memory states contain prompt text).
11. **Other modules' doubt is unmeasured.** The router, skills, tools, memory and verify-done thresholds were tuned on Jev. In both mode they stay on Jev until a probe replay of their own question sets sets their doubt test. Only the gate cascades in this release.
12. **Watch for confident errors.** A small sampled share of non-escalated Clef gate answers is also asked of Jev in shadow. The board shows that confident-error rate.
13. **Cache, fixtures and copy.**
    - Key the gate cache by provider, or clear it when the mode changes.
    - Build test fixtures from a real Cloudflare response with the account id removed.
    - The panel says the default `clef` free tier covers about 950 gate calls a day.
