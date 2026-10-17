// Multi-provider P5 (odd/tasks/multi-provider.md): the worker keeps the
// Cloudflare credentials in `secrets` next to the Jev key, mirrors them to
// the same env file the gate hook reads (the path the Jev key has always
// taken, review note 3), mirrors the provider choice, publishes a masked
// status, and its doctor no longer fails a Clef-only install for having no
// Jev key (review note 2). Paths are redirected to a temp dir before
// main.mjs is imported, so the real sidecar writes only there.
import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

// The real path, twice: the sidecar's permission sandbox does not follow the
// /var -> /private/var link, and its write guard only allows the OS temp dir,
// which the sidecar learns from TMPDIR.
process.env.TMPDIR = realpathSync(tmpdir())
const PATHS_OVERRIDE_DIR = mkdtempSync(join(realpathSync(tmpdir()), 'orca-jev-main-providers-test-'))
process.env.ORCA_SUPERVISOR_CONFIG_DIR = join(PATHS_OVERRIDE_DIR, 'config')
process.env.ORCA_SUPERVISOR_CACHE_DIR = join(PATHS_OVERRIDE_DIR, 'cache')
// The sidecar may write only inside the config dir, so it must exist, as it does on a real machine.
mkdirSync(process.env.ORCA_SUPERVISOR_CONFIG_DIR, { recursive: true })
after(() => rmSync(PATHS_OVERRIDE_DIR, { recursive: true, force: true }))

const {
  attendClefTestRequest,
  attendSecretRequest,
  CLEF_TEST_RESULT_KEY,
  checkDecisionProviders,
  mirrorAllSecrets,
  mirrorCatalogAndPolicies,
  publishSecretStatus,
  SECRET_RESULT_KEY
} = await import('./main.mjs')

const ENV_FILE = join(PATHS_OVERRIDE_DIR, 'config', 'env')

function fakeOrca () {
  const logs = []
  return { log: (message) => logs.push(message), _logs: logs }
}
function fakeHost (initial) {
  const store = { ...(initial || {}) }
  return {
    async get (key) { return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null },
    async set (key, value) { store[key] = value },
    async delete (key) { delete store[key] },
    async keys () { return Object.keys(store) },
    _store: store
  }
}
const now = () => new Date().toISOString()

test('a Cloudflare token saved from the panel lands in secrets and in the env file mirror, never in the result', async () => {
  const storage = fakeHost({ secretRequest: { id: 'cf-1', at: now(), intent: 'save', secret: 'cloudflareApiToken', value: ' tok-1234 ' } })
  const secrets = fakeHost()
  const orca = fakeOrca()
  await attendSecretRequest(orca, storage, secrets)
  assert.deepEqual(orca._logs, [])
  const result = await storage.get(SECRET_RESULT_KEY)
  assert.equal(result.ok, true)
  assert.equal(result.secret, 'cloudflareApiToken')
  assert.ok(!JSON.stringify(result).includes('tok-1234'))
  assert.equal(await secrets.get('cloudflareApiToken'), 'tok-1234')
  assert.equal(await secrets.get('typesafeApiKey'), null)
  assert.match(readFileSync(ENV_FILE, 'utf8'), /^CLOUDFLARE_API_TOKEN=tok-1234$/m)
})

test('clearing the Cloudflare account id removes it from secrets and its line from the mirror', async () => {
  const secrets = fakeHost()
  await attendSecretRequest(fakeOrca(), fakeHost({ secretRequest: { id: 'cf-2', at: now(), intent: 'save', secret: 'cloudflareAccountId', value: 'acct-9' } }), secrets)
  assert.match(readFileSync(ENV_FILE, 'utf8'), /^CLOUDFLARE_ACCOUNT_ID=acct-9$/m)
  await attendSecretRequest(fakeOrca(), fakeHost({ secretRequest: { id: 'cf-3', at: now(), intent: 'clear', secret: 'cloudflareAccountId' } }), secrets)
  assert.equal(await secrets.get('cloudflareAccountId'), null)
  assert.doesNotMatch(existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : '', /CLOUDFLARE_ACCOUNT_ID/)
})

test('a request naming any other secret is refused and stores nothing', async () => {
  const storage = fakeHost({ secretRequest: { id: 'cf-4', at: now(), intent: 'save', secret: 'githubToken', value: 'x' } })
  const secrets = fakeHost()
  await attendSecretRequest(fakeOrca(), storage, secrets)
  const result = await storage.get(SECRET_RESULT_KEY)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'unknown-secret')
  assert.deepEqual(secrets._store, {})
})

test('the published status masks the Cloudflare credentials like the Jev key', async () => {
  const storage = fakeHost()
  await publishSecretStatus(fakeOrca(), storage, fakeHost({ typesafeApiKey: 'jev-abcd', cloudflareAccountId: 'acct-5678', cloudflareApiToken: 'tok-wxyz' }))
  const status = await storage.get('secretStatus')
  assert.equal(status.configured, true)
  assert.deepEqual(status.cloudflare, { accountId: { configured: true, endsWith: '5678' }, token: { configured: true, endsWith: 'wxyz' } })
  assert.ok(!JSON.stringify(status).includes('tok-'))
  const empty = fakeHost()
  await publishSecretStatus(fakeOrca(), empty, fakeHost())
  assert.deepEqual((await empty.get('secretStatus')).cloudflare, { accountId: { configured: false, endsWith: null }, token: { configured: false, endsWith: null } })
})

test('activation mirrors every secret, a missing one as a clear', async () => {
  const calls = []
  const run = async (mode, stdin, args) => { calls.push({ mode, stdin, args }); return { ok: true } }
  await mirrorAllSecrets(fakeOrca(), fakeHost({ typesafeApiKey: 'jev', cloudflareApiToken: 'tok' }), { run })
  assert.deepEqual(calls, [
    { mode: 'save', stdin: 'jev', args: ['TYPESAFE_API_KEY'] },
    { mode: 'clear', stdin: undefined, args: ['CLOUDFLARE_ACCOUNT_ID'] },
    { mode: 'save', stdin: 'tok', args: ['CLOUDFLARE_API_TOKEN'] }
  ])
})

// 0.13.2: a transient error from Orca's secrets host at activation cleared the
// Jev key's env line, and the gate ran without Jev until the key was saved again.
test('a secret whose read throws at activation keeps its env line, logs its name only, and the others still mirror', async () => {
  const calls = []
  const run = async (mode, stdin, args) => { calls.push({ mode, stdin, args }); return { ok: true } }
  const secrets = fakeHost({ typesafeApiKey: 'jev-secret-value', cloudflareApiToken: 'tok' })
  const get = secrets.get
  secrets.get = async (key) => { if (key === 'typesafeApiKey') throw new Error('secrets host busy'); return get(key) }
  const orca = fakeOrca()
  await mirrorAllSecrets(orca, secrets, { run })
  assert.deepEqual(calls, [
    { mode: 'clear', stdin: undefined, args: ['CLOUDFLARE_ACCOUNT_ID'] },
    { mode: 'save', stdin: 'tok', args: ['CLOUDFLARE_API_TOKEN'] }
  ])
  assert.deepEqual(orca._logs, ['secret mirror skipped for TYPESAFE_API_KEY: secrets host busy'])
  assert.ok(!orca._logs.join('').includes('jev-secret-value'))
})

test('the provider choice saved by the panel is mirrored, normalized, with the other settings', async () => {
  const calls = []
  const run = async (mode, stdin) => { calls.push({ mode, stdin }); return { ok: true } }
  await mirrorCatalogAndPolicies(fakeOrca(), fakeHost({ decisionProvider: { mode: 'both', clefModel: 'clef-flash' } }), { run })
  assert.deepEqual(JSON.parse(calls.find((call) => call.mode === 'provider-settings-save').stdin), { mode: 'both', clefModel: 'clef-flash' })
  calls.length = 0
  await mirrorCatalogAndPolicies(fakeOrca(), fakeHost(), { run })
  assert.deepEqual(JSON.parse(calls.find((call) => call.mode === 'provider-settings-save').stdin), { mode: 'jev', clefModel: 'clef' })
})

const CLEF_OK = JSON.stringify({ result: { model: 'clef', answers: { check: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 40, output_tokens: 0 } }, success: true, errors: [], messages: [] })
const JEV_OK = JSON.stringify({ model: 'jev-latest', answers: { check: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 40, output_tokens: 1 } })
function fetchBy (byHost) {
  const hosts = []
  const fetchImpl = async (url) => {
    const host = new URL(url).host
    hosts.push(host)
    const entry = byHost[host]
    return { ok: entry.status === 200, status: entry.status, text: async () => entry.body }
  }
  return { fetchImpl, hosts }
}

test('doctor, Jev only: exactly the Jev key check, no Clef check', async () => {
  const net = fetchBy({ 'api.typesafe.ai': { status: 200, body: JEV_OK } })
  const checks = await checkDecisionProviders(fakeHost({ typesafeApiKey: 'jev' }), fakeHost(), { fetchImpl: net.fetchImpl })
  assert.deepEqual(checks.map((check) => [check.id, check.ok]), [['api-key', true]])
  assert.deepEqual(net.hosts, ['api.typesafe.ai'])
})

test('doctor, Clef only with no Jev key: the missing Jev key is not a failure, and Clef is pinged', async () => {
  const net = fetchBy({ 'api.cloudflare.com': { status: 200, body: CLEF_OK } })
  const checks = await checkDecisionProviders(fakeHost({ cloudflareAccountId: 'acct', cloudflareApiToken: 'tok' }), fakeHost({ decisionProvider: { mode: 'clef' } }), { fetchImpl: net.fetchImpl })
  assert.deepEqual(checks.map((check) => [check.id, check.ok]), [['api-key', true], ['clef', true]])
  assert.deepEqual(net.hosts, ['api.cloudflare.com'])
})

test('doctor, both: a rejected Cloudflare token fails the Clef check by name', async () => {
  const net = fetchBy({ 'api.typesafe.ai': { status: 200, body: JEV_OK }, 'api.cloudflare.com': { status: 401, body: '{"result":null,"success":false,"errors":[{"code":10000,"message":"Authentication error"}],"messages":[]}' } })
  const checks = await checkDecisionProviders(fakeHost({ typesafeApiKey: 'jev', cloudflareAccountId: 'acct', cloudflareApiToken: 'tok' }), fakeHost({ decisionProvider: { mode: 'both' } }), { fetchImpl: net.fetchImpl })
  const clef = checks.find((check) => check.id === 'clef')
  assert.equal(clef.ok, false)
  assert.match(clef.detail, /rejected \(401\)/)
  assert.ok(!clef.detail.includes('tok'))
})

test('doctor, Clef mode with no Cloudflare credentials says so', async () => {
  const checks = await checkDecisionProviders(fakeHost({ typesafeApiKey: 'jev' }), fakeHost({ decisionProvider: { mode: 'clef' } }), { fetchImpl: fetchBy({}).fetchImpl })
  const clef = checks.find((check) => check.id === 'clef')
  assert.equal(clef.ok, false)
  assert.match(clef.detail, /No Cloudflare credentials/)
})

// P6: the config panel's "Test connection" button. A request the worker
// attends with the stored credentials and the model the panel shows; the
// result is a reason code the panel translates, never the token.
test('the connection test answers ok with the latency, for the model the panel names', async () => {
  const net = fetchBy({ 'api.cloudflare.com': { status: 200, body: CLEF_OK } })
  const storage = fakeHost({ clefTestRequest: { id: 't-1', at: now(), model: 'clef-flash' } })
  await attendClefTestRequest(fakeOrca(), storage, fakeHost({ cloudflareAccountId: 'acct', cloudflareApiToken: 'tok' }), { fetchImpl: net.fetchImpl })
  const result = await storage.get(CLEF_TEST_RESULT_KEY)
  assert.equal(result.id, 't-1')
  assert.equal(result.ok, true)
  assert.equal(result.reason, 'ok')
  assert.equal(result.model, 'clef-flash')
  assert.equal(typeof result.latencyMs, 'number')
  assert.equal(await storage.get('clefTestRequest'), null, 'the request is consumed')
})

test('the connection test names a rejected token, missing credentials, and a spent day by code', async () => {
  const rejected = fakeHost({ clefTestRequest: { id: 't-2', at: now(), model: 'clef' } })
  await attendClefTestRequest(fakeOrca(), rejected, fakeHost({ cloudflareAccountId: 'acct', cloudflareApiToken: 'tok' }), { fetchImpl: fetchBy({ 'api.cloudflare.com': { status: 401, body: '{"errors":[{"code":10000}]}' } }).fetchImpl })
  assert.deepEqual([(await rejected.get(CLEF_TEST_RESULT_KEY)).reason, (await rejected.get(CLEF_TEST_RESULT_KEY)).status], ['rejected', 401])
  const spent = fakeHost({ clefTestRequest: { id: 't-3', at: now(), model: 'clef' } })
  await attendClefTestRequest(fakeOrca(), spent, fakeHost({ cloudflareAccountId: 'acct', cloudflareApiToken: 'tok' }), { fetchImpl: fetchBy({ 'api.cloudflare.com': { status: 429, body: '{"errors":[{"code":3036}]}' } }).fetchImpl })
  assert.equal((await spent.get(CLEF_TEST_RESULT_KEY)).reason, 'allowance')
  const none = fakeHost({ clefTestRequest: { id: 't-4', at: now(), model: 'not-a-model' } })
  const prior = { account: process.env.CLOUDFLARE_ACCOUNT_ID, token: process.env.CLOUDFLARE_API_TOKEN }
  await attendClefTestRequest(fakeOrca(), none, fakeHost(), { fetchImpl: fetchBy({}).fetchImpl, resolveCredentials: async () => null })
  const result = await none.get(CLEF_TEST_RESULT_KEY)
  assert.equal(result.reason, 'no-credentials')
  assert.equal(result.model, 'clef', 'an unknown model falls back to the default')
  assert.deepEqual(prior, { account: process.env.CLOUDFLARE_ACCOUNT_ID, token: process.env.CLOUDFLARE_API_TOKEN })
})

test('an expired connection test request publishes expired, not silence', async () => {
  const storage = fakeHost({ clefTestRequest: { id: 't-5', at: new Date(Date.now() - 11 * 60 * 1000).toISOString(), model: 'clef' } })
  await attendClefTestRequest(fakeOrca(), storage, fakeHost(), { fetchImpl: fetchBy({}).fetchImpl })
  assert.equal((await storage.get(CLEF_TEST_RESULT_KEY)).reason, 'expired')
})
