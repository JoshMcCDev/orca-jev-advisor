import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probe, status } from './jev_status_cli.ts';
import { JevRequestError, JevTimeoutError } from '../../src/core/jev.ts';
import type { DecisionProvider } from '../../src/core/decision_provider.ts';
// @ts-expect-error JavaScript installer has no declarations.
import { configureCodex, discoverCodexHomes, mergeCodexHooks } from '../orca/install-codex-integration.mjs';

test('status isolates malformed homes and detects stale paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-status-'));
  try {
    const good = join(root, 'good'), bad = join(root, 'bad'), stale = join(root, 'stale');
    await mkdir(good); await mkdir(bad); await mkdir(stale);
    await mkdir(join(root, 'adapters/codex'), { recursive: true });
    await writeFile(join(root, 'adapters/codex/hook.mjs'), '// fixture');
    const hook = (path: string) => ({ hooks: Object.fromEntries(['PreToolUse', 'PostToolUse'].map(event => [event, [{ matcher: event === 'PreToolUse' ? '^(Bash|apply_patch)$' : '^Bash$', hooks: [{ statusMessage: 'orca-jev-advisor: Codex gate', type: 'command', timeout: 15, command: `'${process.execPath}' '${path}/adapters/codex/hook.mjs'` }] }]])) });
    await writeFile(join(good, 'hooks.json'), JSON.stringify(hook(root)));
    await writeFile(join(stale, 'hooks.json'), JSON.stringify(hook('/old')));
    await writeFile(join(bad, 'hooks.json'), '{');
    const result = await configureCodex('status', root, { homes: [good, bad, stale] });
    assert.deepEqual(result.targets.map((t: { state: string }) => t.state), ['configured', 'unreadable', 'missing-or-stale']);
    await rm(join(root, 'adapters/codex/hook.mjs'));
    assert.equal((await configureCodex('status', root, { homes: [good] })).installed, false);
    await mkdir(join(root, 'adapters/codex/hook.mjs'));
    assert.equal((await configureCodex('status', root, { homes: [good] })).installed, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('discovery preserves known homes when account discovery fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-discovery-'));
  try {
    const userData = join(root, 'orca'); await mkdir(userData);
    await writeFile(join(userData, 'codex-accounts'), 'not a directory');
    const errors: string[] = [];
    const homes = await discoverCodexHomes({ ORCA_USER_DATA_PATH: userData, CODEX_HOME: join(root, 'custom') }, root, errors);
    assert.ok(homes.includes(join(root, '.codex')));
    assert.ok(homes.includes(join(root, 'custom')));
    assert.equal(errors.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('provider mode combinations and unreadable settings are reported honestly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-provider-status-'));
  const previous = process.env.ORCA_SUPERVISOR_CONFIG_DIR;
  process.env.ORCA_SUPERVISOR_CONFIG_DIR = root;
  try {
    for (const [mode, expected] of [['jev', ['jev']], ['clef', ['clef']], ['both', ['jev', 'clef']]] as const) {
      await writeFile(join(root, 'decision-provider.json'), JSON.stringify({ mode }));
      const result = await status(root, false, []);
      assert.equal(result.mode, mode);
      assert.deepEqual(Object.keys(result.providers), expected);
      assert.ok(Object.values(result.providers).every(p => p.status === 'not-checked'));
    }
    await rm(join(root, 'decision-provider.json'));
    await mkdir(join(root, 'decision-provider.json'));
    const result = await status(root, true, []);
    assert.equal(result.mode, 'unknown');
    assert.deepEqual(result.providers, {});
  } finally {
    if (previous === undefined) delete process.env.ORCA_SUPERVISOR_CONFIG_DIR; else process.env.ORCA_SUPERVISOR_CONFIG_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('provider checks are opt-in and classify failures without exposing them', async () => {
  let calls = 0;
  const provider = (error: Error): DecisionProvider => ({ id: 'jev', ask: async () => { calls++; throw error; } });
  assert.equal((await probe(provider(new Error('secret')), false)).status, 'not-checked');
  assert.equal(calls, 0);
  assert.equal((await probe(null, true)).status, 'missing');
  assert.equal((await probe(provider(new JevRequestError('secret', 401)), true)).status, 'rejected');
  assert.equal((await probe(provider(new JevTimeoutError(1)), true)).status, 'unreachable');
});

test('status rejects duplicate, malformed, and unavailable owned commands', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-status-invalid-'));
  try {
    const home = join(root, 'home'); await mkdir(home);
    await mkdir(join(root, 'adapters/codex'), { recursive: true });
    await writeFile(join(root, 'adapters/codex/hook.mjs'), '// fixture');
    const command = `'${process.execPath}' '${root}/adapters/codex/hook.mjs'`;
    const hook = { type: 'command', timeout: 15, statusMessage: 'orca-jev-advisor: Codex gate', command };
    const value = () => ({ hooks: {
      PreToolUse: [{ matcher: '^(Bash|apply_patch)$', hooks: [{ ...hook }] }],
      PostToolUse: [{ matcher: '^Bash$', hooks: [{ ...hook }] }],
    } });
    await writeFile(join(home, 'hooks.json'), JSON.stringify(value()));
    assert.equal((await configureCodex('status', root, { homes: [home] })).installed, true);
    const unrelated = { ...hook, command: 'other-command' };
    const mixed = value(); mixed.hooks.PreToolUse[0].hooks.push(unrelated);
    assert.deepEqual(mergeCodexHooks(mixed, null).hooks.PreToolUse[0].hooks, [unrelated]);
    const variants = [
      (v: ReturnType<typeof value>) => v.hooks.PreToolUse[0].hooks.push({ ...hook }),
      (v: ReturnType<typeof value>) => v.hooks.PreToolUse[0].hooks.push({ ...hook, command: 'other-command' }),
      (v: ReturnType<typeof value>) => { v.hooks.PreToolUse[0].hooks[0].command = `'/missing/node' '${root}/adapters/codex/hook.mjs'`; },
      (v: ReturnType<typeof value>) => { v.hooks.PreToolUse[0].hooks[0].command += ' extra'; },
      (v: ReturnType<typeof value>) => { v.hooks.PreToolUse[0].hooks[0].command = `'${root}/adapters/codex/hook.mjs'`; },
      (v: ReturnType<typeof value>) => { v.hooks.PreToolUse[0].hooks[0].timeout = 1; },
    ];
    for (const mutate of variants) {
      const v = value(); mutate(v);
      await writeFile(join(home, 'hooks.json'), JSON.stringify(v));
      assert.equal((await configureCodex('status', root, { homes: [home] })).installed, false);
    }
    const marker = join(root, 'executed');
    const executable = join(root, 'fake-node');
    await writeFile(executable, `#!/bin/sh\ntouch '${marker}'\necho v24.0.0\n`, { mode: 0o755 });
    const malicious = value();
    malicious.hooks.PreToolUse[0].hooks[0].command = `'${executable}' '${root}/adapters/codex/hook.mjs'`;
    await writeFile(join(home, 'hooks.json'), JSON.stringify(malicious));
    assert.equal((await configureCodex('status', root, { homes: [home] })).installed, false);
    await assert.rejects(access(marker));
  } finally { await rm(root, { recursive: true, force: true }); }
});
