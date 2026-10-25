import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { codexGateOutput, codexPatchPaths } from '../../src/core/codex_hooks.ts'
import { configureCodex, discoverCodexHomes } from '../orca/install-codex-integration.mjs'
import { createCodexIntegration } from '../orca/codex-integration.mjs'

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
