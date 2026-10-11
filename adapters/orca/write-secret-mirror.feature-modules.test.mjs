// feature-modules T4 -- write-secret-mirror.mjs's `feature-modules-read`
// mode, spawned the way main.mjs spawns its read-only modes (a clean child,
// real fs), against a real temp config dir. It is the worker's one read of
// `<configDir>/feature-modules.json` at activation (the worker's own sandbox
// cannot read the config dir); the parsing is src/core/feature_modules.ts's,
// covered on its own, so this only proves the I/O around it.
//
// Same fixture discipline as the sibling write-secret-mirror tests: an
// isolated mkdtemp HOME and an explicit ORCA_SUPERVISOR_CONFIG_DIR.

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT_PATH = join(__dirname, 'write-secret-mirror.mjs')

const temps = []
after(() => { for (const dir of temps) rmSync(dir, { recursive: true, force: true }) })

function readModules (content) {
  const home = mkdtempSync(join(tmpdir(), 'orca-jev-feature-modules-read-'))
  temps.push(home)
  const configDir = join(home, '.config', 'orca-supervisor')
  if (content !== undefined) {
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, 'feature-modules.json'), content)
  }
  const env = { ...process.env, HOME: home, ORCA_SUPERVISOR_CONFIG_DIR: configDir }
  delete env.XDG_CONFIG_HOME
  return JSON.parse(execFileSync(process.execPath, [SCRIPT_PATH, 'feature-modules-read'], { env, encoding: 'utf8' }))
}

const ALL_ACTIVE = { gate: 'active', 'model-router': 'active', steward: 'active', 'skill-selection': 'active', board: 'active' }

test('feature-modules-read: a missing file reads as every module active', () => {
  assert.deepEqual(readModules(undefined), { ok: true, value: ALL_ACTIVE })
})

test('feature-modules-read: the states in the file come back', () => {
  const result = readModules(JSON.stringify({ modules: { gate: 'off', 'model-router': 'shadow', board: 'off' } }))
  assert.deepEqual(result, { ok: true, value: { ...ALL_ACTIVE, gate: 'off', 'model-router': 'shadow', board: 'off' } })
})

test('feature-modules-read: a corrupt file reads as every module active', () => {
  assert.deepEqual(readModules('{ not json'), { ok: true, value: ALL_ACTIVE })
})
