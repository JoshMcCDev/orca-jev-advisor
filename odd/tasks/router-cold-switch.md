# Router: a switch is free when the cache is cold (track R)

Branch `feat/router-cold-switch`, from `origin/main` at af721bf (0.8.0). Source: `mods-review.md` §1 row 3, §2.3, §3.1 (cache-clock, I-3) and §6 chain R.

## Objective

The router's break-even (`breakEven`, `effortBreakEven` in `src/core/model_router_stage.ts`) charges a rewrite of the whole context for every model or effort switch, because the prompt cache is per model and per effort. After a gap longer than the cache TTL that rewrite happens anyway, so the switch costs nothing extra. Baseline (7 days, `model-router-decisions`): 33 `break-even` and 7 `effort-break-even` holds; 29,082 of 29,085 main responses wrote the 1h cache bucket.

## Scope

In:
- A pure reader of transcript-tail rows (`src/core/cache_warmth.ts`): the newest main-thread assistant row's cache bucket (1h or 5m) and its time, as cache-clock's `readTtl` does; `cacheWarm(now)`.
- `breakEven` / `effortBreakEven` take `cacheWarm`; known cold makes the switch cost 0. The decision record gets `cacheWarm`.
- Mode: the cold switch follows the router's own measure/active mode. Measure logs `wouldApplyCold` and changes nothing; active applies it and logs `appliedCold`.
- Mod wiring in `hooks/index.ts`: `classic.Stop` reads the transcript tail for the TTL; each main step stamps the last main step time; both in `$.state` (`routerCache`).
- The board's model router card shows "switches after a cold cache: N (7 days)", es and en.

Out: the steward's pre-cold tier (track S), a cache countdown band, a version bump, CHANGELOG, README, `claude-code.d.ts`.

## Design decisions

- **Unknown is warm.** No TTL read yet, no last main step, a malformed or missing row: the cache counts as warm, which is today's behaviour.
- **Last main step time** is stamped after each main step's response (later than the request, so it can only overstate warmth, never understate it).
- **Cold made the difference** is decided by running the same stage decision with a warm cache: a switch the warm decision would have held is a cold switch. Hysteresis still applies.

## Checklist

Strict TDD for each: RED observed, then GREEN, then a Conventional Commit on this branch.

- [ ] R0 `src/core/cache_warmth.ts` + test: 1h, 5m, missing usage (unknown), malformed row, sidechain rows skipped, `cacheWarm` warm/cold/unknown.
- [ ] R1 `breakEven` / `effortBreakEven` / `decideStage` take `cacheWarm`; cold makes `switchCost` 0; `routerDecisionRecord` gets `cacheWarm`. `model_router_stage.test.ts` and `model_router_decide.test.ts` stay green.
- [ ] R2 Mod wiring: `routerCache` in `$.state`; `classic.Stop` TTL read; measure logs `wouldApplyCold` and changes nothing, active applies and logs `appliedCold`. `hooks.test.ts` loads the mod with the new `src/core` import; sticky model across reloads unchanged.
- [ ] R3 Board card line in es and en, from a 7-day count in `read-consumption.mjs`; panel copy test; one screenshot at 1440 and one at 390, read.

## Acceptance criteria

- With the cache unknown or warm, every existing router decision is unchanged.
- With the cache known cold, a downgrade or effort lowering that only the rewrite held passes break-even; measure mode changes no step.
- `npm run typecheck` exits 0; `npm test` and `npm run test:panels` pass.

## Checks

`npm run typecheck`, `npm test`, `npm run test:panels`, the two screenshots.
