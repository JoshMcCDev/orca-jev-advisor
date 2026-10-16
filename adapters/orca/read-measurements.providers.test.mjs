// Multi-provider P7 (odd/tasks/multi-provider.md): the board's gate reading
// carries, per window, who answered, why Jev did, Clef's failovers and
// confident errors, and the neurons spent from the append-only ledger, plus
// today's spend against the free allowance. Same harness as
// read-measurements.test.mjs: a throwaway HOME and cache dir.
import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'

import { gateDecisionFileName } from '../../src/core/measurement_files.ts'
import { neuronLedgerFileName, serializeNeuronLedgerEntry } from '../../src/core/neuron_budget.ts'

const SCRIPT_PATH = fileURLToPath(new URL('./read-measurements.mjs', import.meta.url))
const homes = []
after(() => { for (const dir of homes) rmSync(dir, { recursive: true, force: true }) })

function setup () {
  const home = mkdtempSync(join(tmpdir(), 'orca-jev-read-providers-'))
  homes.push(home)
  const cache = join(home, '.cache', 'orca-supervisor')
  mkdirSync(cache, { recursive: true })
  return { home, cache }
}

function run (home) {
  const env = { ...process.env, HOME: home, ORCA_SUPERVISOR_CACHE_DIR: join(home, '.cache', 'orca-supervisor') }
  delete env.XDG_CACHE_HOME
  return JSON.parse(execFileSync(process.execPath, [SCRIPT_PATH], { env, encoding: 'utf8' }))
}

const at = (msAgo) => new Date(Date.now() - msAgo).toISOString()
let n = 0
const row = (overrides) => ({ type: 'gate-decision', id: `r-${++n}`, at: at(60_000), project: 'demo', commandFamily: 'git push', source: 'jev', verdict: 'allow', latencyMs: 300, pluginVersion: '0.13.0', stopReason: 'risk', ...overrides })

test('the gate reading counts providers per window and the ledger neurons, with today against the allowance', () => {
  const { home, cache } = setup()
  const rows = [
    row({ provider: 'clef' }),
    row({ provider: 'clef', shadowAgrees: false }),
    row({ provider: 'jev', escalation: 'doubt' }),
    row({ provider: 'jev', escalation: 'rate-limit' }),
    row({ source: 'none', provider: 'clef', failureClass: 'timeout', latencyMs: null, stopReason: 'unreachable' }),
    row({ at: at(3 * 24 * 3600_000), provider: 'clef' })
  ]
  for (const r of rows) {
    writeFileSync(join(cache, gateDecisionFileName(r.at)), `${JSON.stringify(r)}\n`, { flag: 'a' })
  }
  const now = new Date()
  writeFileSync(join(cache, neuronLedgerFileName(now)),
    serializeNeuronLedgerEntry({ type: 'neurons', at: at(60_000), model: 'clef', neurons: 10.5 }) +
    serializeNeuronLedgerEntry({ type: 'neurons', at: at(30_000), model: 'clef', neurons: 9.5 }))
  const old = new Date(Date.now() - 3 * 24 * 3600_000)
  writeFileSync(join(cache, neuronLedgerFileName(old)), serializeNeuronLedgerEntry({ type: 'neurons', at: old.toISOString(), model: 'clef', neurons: 100 }))

  const { gate } = run(home)
  const day = gate.windows.day
  assert.deepEqual(day.providers.answeredBy, { jev: 2, clef: 2 })
  assert.equal(day.providers.escalations.doubt, 1)
  assert.equal(day.providers.escalations['rate-limit'], 1)
  assert.equal(day.providers.clefUnanswered, 1)
  assert.deepEqual(day.providers.shadow, { agree: 0, disagree: 1 })
  assert.deepEqual(day.neurons, { spent: 20, calls: 2 })
  assert.deepEqual(gate.windows.week.neurons, { spent: 120, calls: 3 })
  assert.equal(gate.windows.week.providers.answeredBy.clef, 3)
  // A UTC day can straddle the 24-hour window; today is the UTC day the clock is in.
  assert.deepEqual(gate.clefBudget, { today: { spent: 20, calls: 2, exhausted: false }, allowance: 10000, stop: 9000 })
})

test('a Jev-only install reads no provider decisions and no neurons', () => {
  const { home, cache } = setup()
  const r = row({})
  writeFileSync(join(cache, gateDecisionFileName(r.at)), `${JSON.stringify(r)}\n`)
  const { gate } = run(home)
  assert.equal(gate.windows.day.providers.tagged, 0)
  assert.deepEqual(gate.windows.day.neurons, { spent: 0, calls: 0 })
  assert.deepEqual(gate.clefBudget.today, { spent: 0, calls: 0, exhausted: false })
})
