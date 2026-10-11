// The worker's feature-module scheduler (odd/tasks/feature-modules.md, T4):
// a module that is off runs 0 jobs and spawns 0 sidecars (activation jobs,
// timer ticks, poll requests, event handlers); a timer is cleared only when
// every module using it is off; a state change is picked up with no restart.
// Everything here is a fake runner, timer and event bus: nothing is spawned.

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { DEFAULT_FEATURE_MODULES, FEATURE_MODULES, workerJobsFor } from '../../src/core/feature_modules.ts'
import { createModuleScheduler, followStatus, modulesFromRead, modulesFromStatus } from './module-scheduler.mjs'

const ALL_OFF = { gate: 'off', 'model-router': 'off', steward: 'off', 'skill-selection': 'off', board: 'off' }

const INTERVAL_TRIGGERS = ['interval-15s', 'interval-account-quota-10min', 'interval-consumption-10min', 'interval-activity-10min']
const EVENT_TRIGGERS = ['agent.status.changed', 'worktree.created', 'worktree.removed']
const PERIODS = { 'interval-15s': 15_000, 'interval-account-quota-10min': 600_000, 'interval-consumption-10min': 600_001, 'interval-activity-10min': 600_002 }

function states (overrides) {
  return { ...DEFAULT_FEATURE_MODULES, ...overrides }
}

/** Every job with an activation or interval trigger has a runner; a runner counts its calls. */
function harness (initial = DEFAULT_FEATURE_MODULES) {
  const calls = []
  const logs = []
  const runners = {}
  const ids = new Set(FEATURE_MODULES.flatMap((module) => module.workerJobs.filter((job) => job.triggers.some((t) => t === 'activation' || t.startsWith('interval-'))).map((job) => job.id)))
  for (const id of ids) runners[id] = async () => { calls.push(id) }
  const eventHandlers = {}
  for (const trigger of EVENT_TRIGGERS) eventHandlers[trigger] = async () => { calls.push(trigger) }

  const timers = { live: new Map(), cleared: [], next: 1 }
  const timerApi = {
    setInterval: (fn, ms) => {
      const handle = { id: timers.next++, fn, ms, unref () {} }
      timers.live.set(handle.id, handle)
      return handle
    },
    clearInterval: (handle) => {
      timers.cleared.push(handle.id)
      timers.live.delete(handle.id)
    }
  }
  const subscriptions = { live: new Map(), made: [], next: 1 }
  const subscribe = (name, callback) => {
    const id = subscriptions.next++
    subscriptions.live.set(id, { name, callback })
    subscriptions.made.push(name)
    return () => subscriptions.live.delete(id)
  }
  const scheduler = createModuleScheduler({
    initial,
    runners,
    eventHandlers,
    periods: PERIODS,
    subscribe,
    timers: timerApi,
    log: (message) => logs.push(message)
  })
  const liveTimerMs = () => [...timers.live.values()].map((t) => t.ms).sort((a, b) => a - b)
  const tick = async (ms) => {
    for (const handle of [...timers.live.values()]) if (handle.ms === ms) handle.fn()
    await settle()
  }
  return { scheduler, calls, logs, timers, subscriptions, liveTimerMs, tick }
}

function settle () {
  return new Promise((resolve) => setImmediate(resolve))
}

const everyActivationJob = () => [...new Set(FEATURE_MODULES.flatMap((module) => module.workerJobs.filter((job) => job.triggers.includes('activation')).map((job) => job.id)))]

test('all modules active: every activation job runs once, all 4 timers and 3 event subscriptions exist', async () => {
  const h = harness()
  await h.scheduler.start()
  assert.deepEqual([...h.calls].sort(), everyActivationJob().sort())
  assert.equal(h.timers.live.size, 4)
  assert.deepEqual([...h.subscriptions.made].sort(), [...EVENT_TRIGGERS].sort())
})

test('every module off: 0 jobs run, 0 timers are set and 0 event handlers are registered', async () => {
  const h = harness(ALL_OFF)
  await h.scheduler.start()
  assert.deepEqual(h.calls, [])
  assert.equal(h.timers.live.size, 0)
  assert.equal(h.subscriptions.made.length, 0)
})

test('an off module runs none of its own jobs; a shared job still runs while another owner is on', async () => {
  const h = harness(states({ gate: 'off' }))
  await h.scheduler.start()
  assert.equal(h.calls.includes('gate-authorizations'), false)
  assert.equal(h.calls.includes('deny-tier-status'), false)
  assert.equal(h.calls.includes('gate-defaults'), false)
  assert.equal(h.calls.includes('measurements-summary'), true, 'skill-selection still uses it')
  assert.equal(h.calls.includes('activity-summary'), true, 'model-router still uses it')
  assert.equal(h.calls.includes('model-measurements'), true)

  const both = harness(states({ gate: 'off', 'skill-selection': 'off' }))
  await both.scheduler.start()
  assert.equal(both.calls.includes('measurements-summary'), false, 'both owners are off')
})

test('a timer tick runs only the jobs that are on', async () => {
  const h = harness(states({ gate: 'off' }))
  await h.scheduler.start()
  h.calls.length = 0
  await h.tick(PERIODS['interval-15s'])
  assert.deepEqual([...h.calls].sort(), ['measurements-summary', 'model-measurements'])
})

test('a timer is cleared only when every module using it is off', async () => {
  const h = harness()
  await h.scheduler.start()
  assert.equal(h.liveTimerMs().includes(PERIODS['interval-15s']), true)

  await h.scheduler.apply(states({ gate: 'off' }))
  assert.equal(h.liveTimerMs().includes(PERIODS['interval-15s']), true, 'model-router and skill-selection still use the 15 s timer')

  await h.scheduler.apply(states({ gate: 'off', 'model-router': 'off' }))
  assert.equal(h.liveTimerMs().includes(PERIODS['interval-15s']), true, 'skill-selection still uses it')

  await h.scheduler.apply(states({ gate: 'off', 'model-router': 'off', 'skill-selection': 'off' }))
  assert.equal(h.liveTimerMs().includes(PERIODS['interval-15s']), false, 'every owner is off: cleared')
  assert.equal(h.liveTimerMs().includes(PERIODS['interval-consumption-10min']), true, 'the steward still reads the consumption summary')
})

test('the shared 10 min timers follow their owners: consumption needs router or steward, activity needs gate or router', async () => {
  const h = harness()
  await h.scheduler.start()
  await h.scheduler.apply(states({ 'model-router': 'off', steward: 'off' }))
  assert.equal(h.liveTimerMs().includes(PERIODS['interval-consumption-10min']), false)
  assert.equal(h.liveTimerMs().includes(PERIODS['interval-activity-10min']), true, 'the gate still uses it')
  assert.equal(h.liveTimerMs().includes(PERIODS['interval-account-quota-10min']), false)
  await h.scheduler.apply(states({ 'model-router': 'off', steward: 'off', gate: 'off' }))
  assert.equal(h.liveTimerMs().includes(PERIODS['interval-activity-10min']), false)
})

test('a state change is picked up with no restart: the board handlers come and go', async () => {
  const h = harness(states({ board: 'off' }))
  await h.scheduler.start()
  assert.equal(h.subscriptions.live.size, 0)

  await h.scheduler.apply(states({ board: 'active' }))
  assert.equal(h.subscriptions.live.size, 3)
  const status = [...h.subscriptions.live.values()].find((s) => s.name === 'agent.status.changed')
  status.callback({ any: 'payload' })
  await settle()
  assert.deepEqual(h.calls.filter((c) => c === 'agent.status.changed'), ['agent.status.changed'])

  await h.scheduler.apply(states({ board: 'off' }))
  assert.equal(h.subscriptions.live.size, 0, 'the handlers are unregistered')
})

test('a module turned on runs its activation jobs once; jobs already on are not run again', async () => {
  const h = harness(states({ 'model-router': 'off' }))
  await h.scheduler.start()
  h.calls.length = 0
  await h.scheduler.apply(states({ 'model-router': 'active' }))
  assert.deepEqual([...h.calls].sort(), ['account-quota', 'model-docs-check', 'model-measurements', 'models-catalog'])
  assert.equal(h.liveTimerMs().includes(PERIODS['interval-account-quota-10min']), true)
  h.calls.length = 0
  await h.scheduler.apply(states({ 'model-router': 'shadow' }))
  assert.deepEqual(h.calls, [], 'active to shadow changes no job')
})

test('run: a poll request job is attended only while its module is on', async () => {
  const h = harness(states({ steward: 'off', 'model-router': 'off' }))
  await h.scheduler.start()
  let attended = 0
  assert.equal(await h.scheduler.run('router-config-request', async () => { attended += 1; return 'x' }), undefined)
  assert.equal(attended, 0, 'both owners of the router config request are off')
  await h.scheduler.apply(states({ steward: 'active', 'model-router': 'off' }))
  assert.equal(await h.scheduler.run('router-config-request', async () => { attended += 1; return 'x' }), 'x')
  assert.equal(attended, 1, 'the steward still uses it')
  assert.equal(await h.scheduler.run('trusted-program-request', async () => 'y'), 'y', 'the gate is on')
})

test('a failing job is logged and does not stop the others or the timer', async () => {
  const h = harness()
  const boom = async () => { throw new Error('sidecar exploded') }
  const failing = createModuleScheduler({ initial: DEFAULT_FEATURE_MODULES, runners: { 'measurements-summary': boom, 'model-measurements': async () => { h.calls.push('model-measurements') } }, eventHandlers: {}, periods: PERIODS, subscribe: () => () => {}, timers: { setInterval: (fn, ms) => ({ fn, ms, unref () {} }), clearInterval () {} }, log: (m) => h.logs.push(m) })
  await failing.start()
  assert.deepEqual(h.calls, ['model-measurements'])
  assert.match(h.logs.join('\n'), /measurements-summary.*sidecar exploded/)
})

test('a job that waits for another (the docs check needs the seeded catalog) starts after it', async () => {
  const order = []
  const slow = async () => { order.push('catalog:start'); await settle(); order.push('catalog:end') }
  const docs = async () => { order.push('docs') }
  const scheduler = createModuleScheduler({ initial: DEFAULT_FEATURE_MODULES, runners: { 'models-catalog': slow, 'model-docs-check': docs }, eventHandlers: {}, periods: PERIODS, subscribe: () => () => {}, timers: { setInterval: () => ({ unref () {} }), clearInterval () {} }, log: () => {}, after: { 'model-docs-check': 'models-catalog' } })
  await scheduler.start()
  assert.deepEqual(order, ['catalog:start', 'catalog:end', 'docs'])
})

test('close clears every timer and unregisters every handler, and a later change starts nothing', async () => {
  const h = harness()
  await h.scheduler.start()
  h.scheduler.close()
  assert.equal(h.timers.live.size, 0)
  assert.equal(h.subscriptions.live.size, 0)
  await h.scheduler.apply(states({ board: 'active' }))
  assert.equal(h.timers.live.size, 0)
  assert.equal(h.subscriptions.live.size, 0)
})

test('every interval trigger of the registry has a period and every event trigger a handler slot', () => {
  for (const trigger of INTERVAL_TRIGGERS) assert.ok(workerJobsFor(trigger).length > 0, trigger)
  for (const trigger of EVENT_TRIGGERS) assert.ok(workerJobsFor(trigger).length > 0, trigger)
})

test('modulesFromStatus: the installer status carries the state it followed; anything else is no news', () => {
  const status = { ok: true, modules: { gate: { state: 'off' }, 'model-router': { state: 'shadow' }, steward: { state: 'active' }, 'skill-selection': { state: 'active' }, board: { state: 'off' } } }
  assert.deepEqual(modulesFromStatus(status), { gate: 'off', 'model-router': 'shadow', steward: 'active', 'skill-selection': 'active', board: 'off' })
  for (const bad of [null, undefined, 'x', { ok: false }, { ok: true }, { ok: true, modules: 3 }]) assert.equal(modulesFromStatus(bad), null, JSON.stringify(bad))
})

test('modulesFromRead: the sidecar answer is re-validated; a failed read is no news', () => {
  assert.deepEqual(modulesFromRead({ ok: true, value: { gate: 'off', 'model-router': 'banana' } }), { ...DEFAULT_FEATURE_MODULES, gate: 'off' })
  for (const bad of [null, { ok: false, reason: 'exception' }, { ok: true }, { ok: true, value: 'x' }]) assert.equal(modulesFromRead(bad), null, JSON.stringify(bad))
})

test('followStatus: the base rescan\'s installer status moves the scheduler, at no extra spawn, and is handed back unchanged', async () => {
  const applied = []
  const scheduler = { apply: async (modules) => { applied.push(modules) } }
  let reads = 0
  const status = { ok: true, targets: [], modules: { gate: { state: 'off' }, 'model-router': { state: 'active' }, steward: { state: 'active' }, 'skill-selection': { state: 'active' }, board: { state: 'active' } } }
  const readStatus = async () => { reads += 1; return status }
  const followed = followStatus(scheduler, readStatus)
  assert.equal(await followed(), status)
  assert.equal(reads, 1, 'one installer run, the same the rescan already made')
  assert.deepEqual(applied, [{ ...DEFAULT_FEATURE_MODULES, gate: 'off' }])

  const failing = followStatus(scheduler, async () => ({ ok: false, reason: 'no-json' }))
  assert.deepEqual(await failing(), { ok: false, reason: 'no-json' })
  assert.equal(applied.length, 1, 'a failed status changes nothing')
})
