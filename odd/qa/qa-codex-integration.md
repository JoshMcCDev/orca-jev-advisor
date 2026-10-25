# Codex integration validation — 2026-10-22

## Implemented

Native Codex PreToolUse hooks share the existing command/policy gate and
protect advisor decision files and Codex hook configuration from patches.
PostToolUse records execution outcomes for pending decisions. Orca exposes
setup/revert in the configuration page and command palette. Setup selects
Codex, suppressing subsequent automatic Claude installation. No Claude
executable or Claude configuration is required by the Codex hook runner.

See [the integration guide](../../adapters/codex/README.md) for setup and
feature limits. Model routing, the context steward and the skills mod remain
Claude-specific. Codex hook trust and live execution in Orca are unverified.

## Passing checks

49 focused tests passed across these runs:

```sh
node --test adapters/codex/integration.test.mjs src/core/gate_own_files.test.ts adapters/orca/panels/config_html_read_guard.test.mjs
# 28 passed
node --test adapters/orca/main.activate.test.mjs
# 4 passed
node --test --test-name-pattern='attendFeatureModules|attendClaudeIntegration|installClaudeIntegration' adapters/orca/main.test.mjs
# 17 passed
./node_modules/.bin/tsc -p tsconfig.json --noEmit
git diff --check
```

The eight new Codex tests also passed after the final hook change. They
exercise protocol translation, patch paths, installer preservation and
revert, malformed input, account ownership discovery, real sandboxed worker
setup, activation without Claude configuration, and real Node hook execution
against harmless and denied payloads. Commands being judged are never
executed by those hook tests. All installer writes use temporary homes.

Both executable configuration-page scripts parse successfully. Both Codex
command IDs are present in the Orca manifest.

## Broader regression boundary

A broader run of `main.test.mjs` also reported two failures in paths that
already had local modifications before this Codex work:

- `deriveCatalogFromOrca: reports a real failure detail instead of a fake
  empty success`: expects `ENOENT`; the configured Linux CLI shim instead
  reports `/usr/bin/env: ‘bash’: No such file or directory` under the test's
  restricted PATH.
- `activitySidecarArgv: read-only on the plugin root and the cache dir, no
  write grant, no config or ~/.claude* access`: expects two grants; the
  existing cache wildcard change produces three.

Those expectations were not changed. No before-task baseline run was made,
so this report does not claim an independently passing baseline or a fully
passing broad suite.

Repository dependencies were installed without lifecycle scripts or a new
lockfile to run the declared TypeScript compiler. No real Codex home was
configured, no hook trust was granted, and no Orca runtime behavior is
claimed from these automated checks.
