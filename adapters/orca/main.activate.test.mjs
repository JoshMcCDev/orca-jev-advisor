// Activation, end to end, with the REAL sidecars (feature-modules T4): the
// worker is activated against a fake Orca host in a child process whose HOME
// and config/cache dirs are a throwaway directory, once with every module off
// and once with only some off. What a module that is off must not do is read
// off what reached `storage` (every job publishes its result there) and what
// was subscribed to on the event bus: with its module off a job's key never
// appears and its event handlers are never registered.
//
// T4b: the intervals that are alive at the end tell which refreshes a panel
// signal moves: with no panel open the timers of the panel-only jobs do not
// exist, and with one open (either panel's own key) they do.
//
// This is the only test that runs `activate` itself; the scheduler's rules
// are covered one by one in module-scheduler.test.mjs.

import { strict as assert } from 'node:assert'
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MAIN_PATH = join(__dirname, 'main.mjs')

const temps = []
after(() => { for (const dir of temps) rmSync(dir, { recursive: true, force: true }) })

const CHILD = `
const liveIntervals = new Map()
const realSetInterval = globalThis.setInterval
const realClearInterval = globalThis.clearInterval
globalThis.setInterval = (fn, ms, ...rest) => { const handle = realSetInterval(fn, ms, ...rest); liveIntervals.set(handle, ms); return handle }
globalThis.clearInterval = (handle) => { liveIntervals.delete(handle); return realClearInterval(handle) }
const { default: activate } = await import(${JSON.stringify(MAIN_PATH)})
const sets = new Set()
const subscribed = []
const logs = []
const store = new Map()
if (process.env.PANEL_KEY) store.set(process.env.PANEL_KEY, { at: new Date().toISOString() })
const orca = {
  log: (message) => logs.push(String(message)),
  events: { on: (name) => { subscribed.push(name); return () => {} } },
  commands: { register: () => {} },
  host: {
    call: async (method, args) => {
      if (method === 'storage.get') return { value: store.has(args.key) ? store.get(args.key) : null }
      if (method === 'storage.set') { sets.add(args.key); store.set(args.key, args.value); return { ok: true } }
      if (method === 'storage.delete') { store.delete(args.key); return { ok: true } }
      if (method === 'storage.keys') return { keys: [...store.keys()] }
      if (method === 'secrets.get') return { value: null }
      return { ok: true }
    }
  }
}
const teardown = activate(orca)
await new Promise((resolve) => setTimeout(resolve, Number(process.env.SETTLE_MS)))
const intervals = [...liveIntervals.values()].sort((a, b) => a - b)
teardown()
process.stdout.write(JSON.stringify({ sets: [...sets], subscribed, logs, intervals }))
process.exit(0)
`

function runActivation (modules, panelKey = '') {
  const home = mkdtempSync(join(tmpdir(), 'orca-jev-activate-'))
  temps.push(home)
  const configDir = join(home, '.config', 'orca-supervisor')
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, 'feature-modules.json'), JSON.stringify({ modules }))
  const env = {
    ...process.env,
    HOME: home,
    ORCA_SUPERVISOR_CONFIG_DIR: configDir,
    ORCA_SUPERVISOR_CACHE_DIR: join(home, '.cache', 'orca-supervisor'),
    // No real Orca CLI: its calls fail fast instead of reaching a running Orca.
    ORCA_CLI_COMMAND: '/usr/bin/false',
    SETTLE_MS: '3500',
    PANEL_KEY: panelKey
  }
  delete env.XDG_CONFIG_HOME
  delete env.XDG_CACHE_HOME
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', CHILD], { env, timeout: 30_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error)
      else resolve(JSON.parse(stdout))
    })
  })
}

const ALL_OFF = { gate: 'off', 'model-router': 'off', steward: 'off', 'skill-selection': 'off', board: 'off' }

test('every module off: no module job publishes anything and no Orca event handler is registered', { skip: process.platform === 'win32' }, async () => {
  const { sets, subscribed } = await runActivation(ALL_OFF)
  const moduleKeys = ['measurementsSummary', 'modelMeasurements', 'gateAuthorizationsStatus', 'modelRouterStatus', 'consumptionSummary', 'activityByProjectSummary', 'modSkillsStatus', 'denyTierStatus', 'trustedProgramsStatus', 'gateDefaults', 'models']
  assert.deepEqual(sets.filter((key) => moduleKeys.includes(key)), [])
  assert.deepEqual(subscribed, [])
  assert.ok(sets.includes('workerHeartbeat'), 'the base heartbeat still runs')
})

test('some modules off: only the jobs of the modules that are on publish, and the board handlers follow the board', { skip: process.platform === 'win32' }, async () => {
  const { sets, subscribed } = await runActivation({ gate: 'active', 'model-router': 'off', steward: 'off', 'skill-selection': 'active', board: 'off' })
  for (const key of ['measurementsSummary', 'gateAuthorizationsStatus', 'modSkillsStatus', 'denyTierStatus', 'trustedProgramsStatus', 'gateDefaults', 'activityByProjectSummary']) assert.ok(sets.includes(key), `${key} is a job of the gate or skill-selection`)
  for (const key of ['modelMeasurements', 'modelRouterStatus', 'consumptionSummary', 'models']) assert.equal(sets.includes(key), false, `${key} belongs to the router or steward, both off`)
  assert.deepEqual(subscribed, [], 'the board is off')
})

const FIFTEEN_S = 15_000
const TEN_MIN = 600_000

test('no panel open: only the timers with a decision input exist; with every decision input off no timer exists at all', { skip: process.platform === 'win32' }, async () => {
  const router = await runActivation({})
  assert.deepEqual(router.intervals, [FIFTEEN_S, TEN_MIN], 'model-measurements and account-quota keep their cadence')
  const gateOnly = await runActivation({ 'model-router': 'off', steward: 'off', board: 'off' })
  assert.deepEqual(gateOnly.intervals, [], 'the gate and skill-selection jobs on the timers only feed a panel')
})

test('a panel signal (either panel) brings back the timers of the jobs it shows, and the config panel does not need to be the one', { skip: process.platform === 'win32' }, async () => {
  const gateOnly = { 'model-router': 'off', steward: 'off', board: 'off' }
  const config = await runActivation(gateOnly, 'configPanelSeen')
  assert.deepEqual(config.intervals, [FIFTEEN_S, TEN_MIN], 'the 15 s measurements and gate authorizations, the 10 min activity summary')
  const board = await runActivation(gateOnly, 'boardPanelSeen')
  assert.deepEqual(board.intervals, [FIFTEEN_S, TEN_MIN])
})
