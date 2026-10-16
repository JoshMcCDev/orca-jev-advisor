// Multi-provider P5 (odd/tasks/multi-provider.md): the Cloudflare credentials
// reach the gate hook the way the Jev key does -- the worker's secrets store,
// mirrored by this sidecar into the same 0600 env file -- and the provider
// choice is mirrored to decision-provider.json. Same fixture discipline as the
// sibling write-secret-mirror tests: an isolated HOME and config dir.
import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'

const SCRIPT_PATH = fileURLToPath(new URL('./write-secret-mirror.mjs', import.meta.url))
const temps = []
after(() => { for (const dir of temps) rmSync(dir, { recursive: true, force: true }) })

function configDir (existingEnv) {
  const home = mkdtempSync(join(tmpdir(), 'orca-jev-mirror-providers-'))
  temps.push(home)
  const dir = join(home, '.config', 'orca-supervisor')
  mkdirSync(dir, { recursive: true })
  if (existingEnv !== undefined) writeFileSync(join(dir, 'env'), existingEnv, { mode: 0o600 })
  return { home, dir }
}

function run ({ home, dir }, args, input) {
  const env = { ...process.env, HOME: home, ORCA_SUPERVISOR_CONFIG_DIR: dir }
  delete env.XDG_CONFIG_HOME
  return JSON.parse(execFileSync(process.execPath, [SCRIPT_PATH, ...args], { env, encoding: 'utf8', input: input ?? '' }))
}

test('save with a Cloudflare name writes its own line and keeps the Jev key', () => {
  const where = configDir('TYPESAFE_API_KEY=jev\n')
  assert.deepEqual(run(where, ['save', 'CLOUDFLARE_ACCOUNT_ID'], 'acct'), { ok: true })
  assert.deepEqual(run(where, ['save', 'CLOUDFLARE_API_TOKEN'], 'tok'), { ok: true })
  assert.equal(readFileSync(join(where.dir, 'env'), 'utf8'), 'TYPESAFE_API_KEY=jev\nCLOUDFLARE_ACCOUNT_ID=acct\nCLOUDFLARE_API_TOKEN=tok\n')
  assert.equal(statSync(join(where.dir, 'env')).mode & 0o777, 0o600)
  assert.deepEqual(run(where, ['save', 'CLOUDFLARE_API_TOKEN'], 'tok2'), { ok: true })
  assert.match(readFileSync(join(where.dir, 'env'), 'utf8'), /CLOUDFLARE_API_TOKEN=tok2\n$/)
})

test('clear with a Cloudflare name removes only that line; the file goes when nothing is left', () => {
  const where = configDir('TYPESAFE_API_KEY=jev\nCLOUDFLARE_API_TOKEN=tok\n')
  assert.deepEqual(run(where, ['clear', 'CLOUDFLARE_API_TOKEN']), { ok: true })
  assert.equal(readFileSync(join(where.dir, 'env'), 'utf8'), 'TYPESAFE_API_KEY=jev\n')
  assert.deepEqual(run(where, ['clear']), { ok: true })
  assert.equal(existsSync(join(where.dir, 'env')), false)
})

test('save and clear refuse any name that is not one of the three secrets', () => {
  const where = configDir('TYPESAFE_API_KEY=jev\n')
  const result = run(where, ['save', 'PATH'], 'x')
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'unknown-secret')
  assert.equal(readFileSync(join(where.dir, 'env'), 'utf8'), 'TYPESAFE_API_KEY=jev\n')
})

test('provider-settings-save writes the normalized choice, Jev-only for anything malformed', () => {
  const where = configDir()
  assert.deepEqual(run(where, ['provider-settings-save'], JSON.stringify({ mode: 'both', clefModel: 'clef-omni', extra: 1 })), { ok: true })
  assert.deepEqual(JSON.parse(readFileSync(join(where.dir, 'decision-provider.json'), 'utf8')), { mode: 'both', clefModel: 'clef-omni' })
  assert.deepEqual(run(where, ['provider-settings-save'], '{nope'), { ok: true })
  assert.deepEqual(JSON.parse(readFileSync(join(where.dir, 'decision-provider.json'), 'utf8')), { mode: 'jev', clefModel: 'clef' })
})
