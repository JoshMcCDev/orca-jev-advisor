import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, symlink, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { codexGateOutput, codexPatchPaths } from '../../src/core/codex_hooks.ts'
import { configureCodex, discoverCodexHomes } from '../orca/install-codex-integration.mjs'
import { createCodexIntegration } from '../orca/codex-integration.mjs'
import { handleCodexHook } from './hook.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
async function temporary (t) {
  const path = await mkdtemp(join(tmpdir(), 'jev-codex-'))
  t.after(() => rm(path, { recursive: true, force: true }))
  return path
}

test('Codex protocol preserves policy stops and leaves normal approvals in charge', () => {
  for (const decision of ['deny', 'ask']) {
    const result = codexGateOutput({ hookSpecificOutput: { permissionDecision: decision, permissionDecisionReason: 'policy x' }, systemMessage: 'notice' })
    assert.equal(result.hookSpecificOutput.permissionDecision, 'deny')
    assert.match(result.hookSpecificOutput.permissionDecisionReason, /policy x/)
    assert.equal(result.systemMessage, 'notice')
  }
  assert.equal(codexGateOutput({ hookSpecificOutput: { permissionDecision: 'allow' } }), null)
  assert.deepEqual(codexGateOutput({ systemMessage: 'missing key' }), { systemMessage: 'missing key' })
})

test('patch paths include add, update, delete and move destinations but ignore content', () => {
  assert.deepEqual(codexPatchPaths('*** Begin Patch\r\n*** Add File: a b\r\n+*** Delete File: inert\r\n*** Update File: old\r\n*** Move to: next\r\n*** Delete File: gone\r\n*** End Patch'), ['a b', 'old', 'next', 'gone'])
})

test('Codex preserves nonblocking advisory context without granting approval', () => {
  assert.deepEqual(codexGateOutput({ hookSpecificOutput: {
    hookEventName: 'PreToolUse', additionalContext: 'Jev advice: review the effect.'
  }, systemMessage: 'notice' }), {
    hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'Jev advice: review the effect.' },
    systemMessage: 'notice'
  })
})

test('advisory hook pair correlates execution without recording approval or command', async t => {
  const cache = await temporary(t)
  const previousCache = process.env.ORCA_SUPERVISOR_CACHE_DIR
  const previousConfig = process.env.ORCA_SUPERVISOR_CONFIG_DIR
  process.env.ORCA_SUPERVISOR_CACHE_DIR = cache
  process.env.ORCA_SUPERVISOR_CONFIG_DIR = cache
  t.after(() => { for (const [key, value] of [['ORCA_SUPERVISOR_CACHE_DIR', previousCache], ['ORCA_SUPERVISOR_CONFIG_DIR', previousConfig]]) { if (value === undefined) delete process.env[key]; else process.env[key] = value } })
  const run = async script => script === 'gate-bash.ts' ? JSON.stringify({ hookSpecificOutput: { additionalContext: 'advice' } }) : ''
  const payload = { session_id: 'session', tool_name: 'Bash', tool_use_id: 'same-id', tool_input: { command: 'secret-command' }, cwd: cache }
  await handleCodexHook({ ...payload, hook_event_name: 'PreToolUse' }, run)
  await handleCodexHook({ ...payload, tool_use_id: 'other-id', hook_event_name: 'PostToolUse' }, run)
  await handleCodexHook({ ...payload, hook_event_name: 'PostToolUse' }, run)
  const dir = join(cache, 'gate-advisory-records')
  const names = await readdir(dir)
  assert.equal(names.length, 1)
  const raw = await readFile(join(dir, names[0]), 'utf8')
  assert.equal(JSON.parse(raw).state, 'executed')
  assert.equal(raw.includes('secret-command'), false)
  await Promise.all(Array.from({ length: 8 }, () => handleCodexHook({ ...payload, hook_event_name: 'PreToolUse' }, run)))
  await Promise.all(Array.from({ length: 8 }, () => handleCodexHook({ ...payload, hook_event_name: 'PostToolUse' }, run)))
  await handleCodexHook({ ...payload, session_id: 'another', hook_event_name: 'PreToolUse' }, run)
  const distinct = await readdir(dir)
  assert.equal(distinct.length, 2)
  assert.deepEqual((await Promise.all(distinct.map(async name => JSON.parse(await readFile(join(dir, name), 'utf8')).state))).sort(), ['executed', 'pending'])
})

test('advisory storage failure permits a later retry', async t => {
  const cache = await temporary(t)
  const old = process.env.ORCA_SUPERVISOR_CACHE_DIR
  const oldConfig = process.env.ORCA_SUPERVISOR_CONFIG_DIR
  process.env.ORCA_SUPERVISOR_CACHE_DIR = cache
  process.env.ORCA_SUPERVISOR_CONFIG_DIR = cache
  t.after(() => { if (old === undefined) delete process.env.ORCA_SUPERVISOR_CACHE_DIR; else process.env.ORCA_SUPERVISOR_CACHE_DIR = old })
  t.after(() => { if (oldConfig === undefined) delete process.env.ORCA_SUPERVISOR_CONFIG_DIR; else process.env.ORCA_SUPERVISOR_CONFIG_DIR = oldConfig })
  const dir = join(cache, 'gate-advisory-records')
  await writeFile(dir, 'obstruction')
  const payload = { session_id: 's', tool_use_id: 'i', tool_name: 'Bash', tool_input: { command: 'x' }, hook_event_name: 'PreToolUse' }
  const run = async () => JSON.stringify({ hookSpecificOutput: { additionalContext: 'advice' } })
  await handleCodexHook(payload, run)
  await rm(dir)
  await handleCodexHook(payload, run)
  assert.equal((await readdir(dir)).length, 1)
})

test('separate processes converge and a failed post write can be retried', async t => {
  const cache = await temporary(t)
  const env = { ...process.env, ORCA_SUPERVISOR_CACHE_DIR: cache, ORCA_SUPERVISOR_CONFIG_DIR: cache }
  const moduleUrl = new URL('./hook.mjs', import.meta.url).href
  const script = `
    import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    if (process.env.FAIL_RENAME) { fs.renameSync = () => { throw new Error('injected'); }; syncBuiltinESMExports(); }
    const { handleCodexHook } = await import(${JSON.stringify(moduleUrl)});
    await handleCodexHook({ session_id: 's', tool_use_id: 'i', tool_name: 'Bash', tool_input: { command: 'private' }, hook_event_name: process.env.EVENT }, async () => JSON.stringify({hookSpecificOutput:{additionalContext:'advice'}}));
  `
  const run = (event, fail = false) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...env, EVENT: event, ...(fail ? { FAIL_RENAME: '1' } : {}) }, stdio: 'ignore' })
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`child exited ${code}`)))
  })
  await Promise.all(Array.from({ length: 8 }, () => run('PreToolUse')))
  const dir = join(cache, 'gate-advisory-records')
  const names = await readdir(dir)
  assert.equal(names.length, 1)
  const record = join(dir, names[0])
  await run('PostToolUseFailure', true)
  assert.equal(JSON.parse(await readFile(record, 'utf8')).state, 'pending')
  await Promise.all(Array.from({ length: 8 }, () => run('PostToolUseFailure')))
  assert.equal(JSON.parse(await readFile(record, 'utf8')).state, 'executed')
  assert.deepEqual(await readdir(dir), names)
})

test('real Codex hook correlates Jev advice and preserves legacy outcomes', async t => {
  const home = await temporary(t)
  const config = join(home, 'config')
  const cache = join(home, 'cache')
  await mkdir(config)
  await writeFile(join(config, 'decision-provider.json'), JSON.stringify({ mode: 'jev' }))
  const answers = { reversible: { type: 'noul', noul: 0.9 }, external: { type: 'noul', noul: 0.05 }, consequence: { type: 'score', score: 2.5, legend: { 0: 'a', 1: 'b', 2: 'c', 3: 'd' }, probabilities: { 0: 1, 1: 0, 2: 0, 3: 0 }, confidence: 0.9 } }
  const env = { ...process.env, HOME: home, ORCA_SUPERVISOR_CONFIG_DIR: config, ORCA_SUPERVISOR_CACHE_DIR: cache, ORCA_USER_DATA_PATH: join(home, 'user-data'), TYPESAFE_API_KEY: 'test-private-key', NODE_OPTIONS: `--import=${join(root, 'adapters/claude/fixtures/system-one-fetch-preload.mjs')}`, SYSTEM_ONE_FETCH_SCRIPT: JSON.stringify({ 'api.typesafe.ai': { status: 200, body: JSON.stringify({ model: 'jev-latest', answers, usage: { input_tokens: 480, output_tokens: 10 } }) } }) }
  const payload = { cwd: home, session_id: 'test-session', tool_name: 'Bash', tool_use_id: 'advice-id', tool_input: { command: 'some-unmeasured-tool --flag' } }
  const hook = (event, id = 'advice-id') => execFileSync(process.execPath, [join(root, 'adapters/codex/hook.mjs')], { env, input: JSON.stringify({ ...payload, hook_event_name: event, tool_use_id: id }), encoding: 'utf8', timeout: 15000 })
  const advice = JSON.parse(hook('PreToolUse'))
  assert.match(advice.hookSpecificOutput.additionalContext, /Jev advice/)
  assert.equal(advice.hookSpecificOutput.permissionDecision, undefined)
  const path = join(cache, 'gate-approvals.jsonl')
  hook('PostToolUse', 'different-id')
  hook('PostToolUseFailure')
  const dir = join(cache, 'gate-advisory-records')
  const names = await readdir(dir)
  assert.equal(names.length, 1)
  assert.equal(JSON.parse(await readFile(join(dir, names[0]), 'utf8')).state, 'executed')
  hook('PostToolUse')
  hook('PostToolUse')
  assert.equal((await readdir(dir)).length, 1)
  assert.doesNotMatch(await readFile(join(dir, names[0]), 'utf8'), /some-unmeasured-tool|test-private-key/)
  await writeFile(path, JSON.stringify({ type: 'gate-pending', toolUseId: 'legacy-id' }) + '\n', { flag: 'a' })
  hook('PostToolUse', 'legacy-id')
  const legacy = (await readFile(path, 'utf8')).trim().split('\n').map(JSON.parse).at(-1)
  assert.equal(legacy.type, 'gate-outcome')
  assert.equal(legacy.outcome, 'approved')
})

test('setup is idempotent, backs up original bytes, and reverts only advisor hooks', async t => {
  const home = await temporary(t)
  const path = join(home, 'hooks.json')
  const original = '{"description":"mine","hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"my-hook"}]}],"Stop":[]}}\n'
  await writeFile(path, original)
  const options = { homes: [home], node: process.execPath }
  assert.equal((await configureCodex('install', root, options)).installed, true)
  const first = await readFile(path, 'utf8')
  await configureCodex('install', root, options)
  assert.equal(await readFile(path, 'utf8'), first)
  assert.equal(await readFile(`${path}.jev-advisor.bak`, 'utf8'), original)
  if (process.platform !== 'win32') assert.equal((await stat(`${path}.jev-advisor.bak`)).mode & 0o777, 0o600)
  assert.equal((await configureCodex('status', root, options)).installed, true)
  await configureCodex('uninstall', root, options)
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), JSON.parse(original))
  assert.equal((await configureCodex('status', root, options)).installed, false)
})

test('status does not execute discovery candidates and recognizes a custom Node', { skip: process.platform === 'win32' }, async t => {
  const home = await temporary(t)
  const customNode = join(home, 'custom-node')
  const candidate = join(home, 'candidate')
  const marker = join(home, 'executed')
  await symlink(process.execPath, customNode)
  await writeFile(candidate, `#!/bin/sh\ntouch '${marker}'\necho v24.0.0\n`, { mode: 0o755 })
  const options = { homes: [home], node: customNode }
  assert.equal((await configureCodex('install', root, options)).installed, true)
  const previous = process.env.ORCA_JEV_NODE_CANDIDATES
  process.env.ORCA_JEV_NODE_CANDIDATES = candidate
  try {
    assert.equal((await configureCodex('status', root, { homes: [home] })).installed, true)
    await assert.rejects(stat(marker), { code: 'ENOENT' })
  } finally {
    if (previous === undefined) delete process.env.ORCA_JEV_NODE_CANDIDATES
    else process.env.ORCA_JEV_NODE_CANDIDATES = previous
  }
})

test('status never runs a discovery candidate', { skip: process.platform === 'win32' }, async t => {
  const home = await temporary(t)
  const candidate = join(home, 'candidate')
  const marker = join(home, 'executed')
  await writeFile(candidate, `#!/bin/sh\ntouch '${marker}'\necho v24.0.0\n`, { mode: 0o755 })
  await configureCodex('install', root, { homes: [home], node: process.execPath })
  const previous = process.env.ORCA_JEV_NODE_CANDIDATES
  process.env.ORCA_JEV_NODE_CANDIDATES = candidate
  try {
    await configureCodex('status', root, { homes: [home] })
    await assert.rejects(stat(marker), { code: 'ENOENT' })
  } finally {
    if (previous === undefined) delete process.env.ORCA_JEV_NODE_CANDIDATES
    else process.env.ORCA_JEV_NODE_CANDIDATES = previous
  }
})

test('install rejects an unsupported custom Node before changing hooks', { skip: process.platform === 'win32' }, async t => {
  const home = await temporary(t)
  const node = join(home, 'old-node')
  const hooks = join(home, 'hooks.json')
  await writeFile(node, '#!/bin/sh\necho v18.0.0\n', { mode: 0o755 })
  await writeFile(hooks, '{}')
  await assert.rejects(configureCodex('install', root, { homes: [home], node }), /Node 24 or newer/)
  assert.equal(await readFile(hooks, 'utf8'), '{}')
})

test('invalid later targets cannot cause an earlier hook file to be overwritten', async t => {
  const base = await temporary(t)
  const homes = [join(base, 'one'), join(base, 'two')]
  for (const home of homes) await mkdir(home)
  await writeFile(join(homes[0], 'hooks.json'), '{}')
  await writeFile(join(homes[1], 'hooks.json'), '{"hooks":{"PreToolUse":{}}}')
  await assert.rejects(configureCodex('install', root, { homes, node: process.execPath }), /Invalid PreToolUse/)
  assert.equal(await readFile(join(homes[0], 'hooks.json'), 'utf8'), '{}')
})

test('discovery includes custom Codex home and only marked Orca account homes', async t => {
  const home = await temporary(t)
  const userData = join(home, 'orca')
  const account = join(userData, 'codex-accounts', 'account-id', 'home')
  const unrelated = join(userData, 'codex-accounts', 'unrelated', 'home')
  await mkdir(account, { recursive: true })
  await mkdir(unrelated, { recursive: true })
  await writeFile(join(account, '.orca-managed-home'), 'account-id\n')
  const custom = join(home, 'custom')
  assert.deepEqual(await discoverCodexHomes({ CODEX_HOME: custom, ORCA_USER_DATA_PATH: userData }, home), [join(home, '.codex'), custom, account])
})

test('worker sidecar installs under its filesystem grants and keeps requests correlated', async t => {
  const home = await temporary(t)
  const userData = join(home, 'orca')
  const store = new Map()
  const integration = createCodexIntegration({ root, home, userData,
    env: { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: join(home, '.codex'), ORCA_USER_DATA_PATH: userData },
    storage: { get: async key => store.get(key), set: async (key, value) => store.set(key, value), delete: async key => store.delete(key) }, log: () => {} })
  store.set('codexIntegrationRequest', { id: 'install-one', at: new Date().toISOString(), intent: 'install' })
  await integration.attend()
  assert.equal(store.get('codexIntegrationResult').id, 'install-one')
  assert.equal(store.get('codexIntegrationResult').ok, true)
  assert.equal(store.get('codexIntegrationStatus').installed, true)
  assert.equal(store.get('agentIntegration'), 'codex')
  assert.equal(store.has('codexIntegrationRequest'), false)
  store.set('codexIntegrationRequest', { id: 'expired', at: '2000-01-01T00:00:00Z', intent: 'uninstall' })
  await integration.attend()
  assert.equal(store.get('codexIntegrationResult').ok, false)
  assert.equal((await integration.run('status')).installed, true)
  assert.equal((await integration.configure('uninstall')).installed, false)
})

test('restricted status discovers a managed Node', { skip: process.platform === 'win32' }, async t => {
  const home = await temporary(t)
  const codex = join(home, '.codex')
  const bin = join(home, '.nvm/versions/node/v99.0.0/bin')
  await mkdir(codex, { recursive: true })
  await mkdir(bin, { recursive: true })
  await symlink(process.execPath, join(bin, 'node'))
  const preload = join(codex, 'electron.cjs')
  await writeFile(preload, "Object.defineProperty(process.versions, 'electron', { value: 'test' })")
  const integration = createCodexIntegration({ root, home, userData: join(home, 'orca'),
    env: { ...process.env, HOME: home, CODEX_HOME: codex, ORCA_USER_DATA_PATH: join(home, 'orca'), PATH: '', NODE_OPTIONS: `--require=${preload}` },
    storage: {}, log: () => {} })
  assert.equal((await integration.run('install')).installed, true)
  assert.match(await readFile(join(codex, 'hooks.json'), 'utf8'), /\.nvm/)
  assert.equal((await integration.run('status')).installed, true)
})

test('activation with Codex selected does not install a Claude configuration', async t => {
  const home = await temporary(t)
  const config = join(home, 'config')
  await mkdir(config)
  await writeFile(join(config, 'feature-modules.json'), JSON.stringify({ modules: Object.fromEntries(['gate', 'model-router', 'steward', 'skill-selection', 'board', 'verify-done', 'ci-watch', 'memory'].map(id => [id, 'off'])) }))
  const code = `
    import { existsSync } from 'node:fs';
    import activate from ${JSON.stringify(new URL('../orca/main.mjs', import.meta.url).href)};
    const values = new Map([['agentIntegration', 'codex']]);
    const orca = { log: () => {}, events: { on: () => () => {} }, commands: { register: () => {} }, host: { call: async (method, args) => {
      if (method === 'storage.get') return { value: values.get(args.key) ?? null };
      if (method === 'storage.set') { values.set(args.key, args.value); return { ok: true }; }
      if (method === 'storage.delete') { values.delete(args.key); return { ok: true }; }
      if (method === 'secrets.get') return { value: null };
      return { ok: true };
    } } };
    const teardown = activate(orca);
    await new Promise(resolve => setTimeout(resolve, 1000));
    teardown();
    console.log(JSON.stringify({ claude: existsSync(${JSON.stringify(join(home, '.claude'))}), codexStatus: values.has('codexIntegrationStatus') }));
    process.exit(0);
  `
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 10000,
    env: { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: join(home, '.codex'), ORCA_USER_DATA_PATH: join(home, 'orca'), ORCA_SUPERVISOR_CONFIG_DIR: config, ORCA_SUPERVISOR_CACHE_DIR: join(home, 'cache') } })
  assert.deepEqual(JSON.parse(output), { claude: false, codexStatus: true })
})

test('native Codex hooks gate commands and patches without executing a command or installing Claude', async t => {
  const home = await temporary(t)
  const config = join(home, 'config')
  await mkdir(config)
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: join(home, '.codex'), ORCA_USER_DATA_PATH: join(home, 'orca'), ORCA_SUPERVISOR_CONFIG_DIR: config, ORCA_SUPERVISOR_CACHE_DIR: join(home, 'cache') }
  const hook = payload => execFileSync(process.execPath, [join(root, 'adapters/codex/hook.mjs')], { env, input: JSON.stringify({ cwd: home, session_id: 'codex-test', tool_use_id: 'call-test', hook_event_name: 'PreToolUse', ...payload }), encoding: 'utf8', timeout: 15000 })
  assert.equal(hook({ tool_name: 'Bash', tool_input: { command: 'pwd' } }), '')
  const blocked = JSON.parse(hook({ tool_name: 'Bash', tool_input: { command: 'rm -rf /' } }))
  assert.equal(blocked.hookSpecificOutput.permissionDecision, 'deny')
  const patched = JSON.parse(hook({ tool_name: 'apply_patch', tool_input: { command: `*** Begin Patch\n*** Add File: ${join(config, 'policies.json')}\n+{}\n*** End Patch` } }))
  assert.equal(patched.hookSpecificOutput.permissionDecision, 'deny')
  const selfEdit = JSON.parse(hook({ tool_name: 'apply_patch', tool_input: { command: `*** Begin Patch\n*** Update File: ${join(env.CODEX_HOME, 'hooks.json')}\n@@\n-a\n+b\n*** End Patch` } }))
  assert.equal(selfEdit.hookSpecificOutput.permissionDecision, 'deny')
  const shellEdit = JSON.parse(hook({ tool_name: 'Bash', tool_input: { command: `echo '{}' > '${join(env.CODEX_HOME, 'hooks.json')}'` } }))
  assert.equal(shellEdit.hookSpecificOutput.permissionDecision, 'deny')
  const workdirEdit = JSON.parse(hook({ tool_name: 'Bash', tool_input: { command: "echo '{}' > hooks.json", workdir: env.CODEX_HOME } }))
  assert.equal(workdirEdit.hookSpecificOutput.permissionDecision, 'deny')
  const otherAccount = join(env.ORCA_USER_DATA_PATH, 'codex-accounts', 'other-account', 'home', 'hooks.json')
  const accountEdit = JSON.parse(hook({ tool_name: 'apply_patch', tool_input: { command: `*** Begin Patch\n*** Add File: ${otherAccount}\n+{}\n*** End Patch` } }))
  assert.equal(accountEdit.hookSpecificOutput.permissionDecision, 'deny')
  await writeFile(join(config, 'feature-modules.json'), JSON.stringify({ modules: { gate: 'off' } }))
  assert.equal(hook({ tool_name: 'Bash', tool_input: { command: 'rm -rf /' } }), '')
  await assert.rejects(stat(join(home, '.claude')), { code: 'ENOENT' })
})
