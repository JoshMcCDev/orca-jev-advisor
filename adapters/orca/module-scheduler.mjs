/**
 * The worker's feature-module scheduler (odd/tasks/feature-modules.md, T4).
 *
 * src/core/feature_modules.ts says which worker jobs each module owns and
 * when each runs (at activation, on a poll turn, on one of four shared
 * intervals, or on an Orca event). This turns that into behaviour:
 *
 *   - a job runs only while at least one module that owns it is not off
 *     (a shared job keeps running for as long as one owner is on);
 *   - an off module spawns no sidecar: its activation jobs, interval ticks,
 *     poll requests and event handlers are never started;
 *   - an interval is cleared, and an event handler unregistered, only when
 *     every job behind that trigger is off (the 15 s and 10 min timers are
 *     shared by several modules, per T0);
 *   - a state change (`apply`) takes effect with no restart: timers and
 *     handlers are created or removed, and the activation jobs of a module
 *     just turned on run once.
 *
 * The state reaches the worker two ways, neither of them a per-tick file
 * read (the worker's sandbox cannot read the config dir, so a file read is a
 * node process): one `feature-modules-read` sidecar at activation, and the
 * installer's `status`, which the base rescan already spawns about once a
 * minute and which now carries the module states it followed
 * (modulesFromStatus). A panel write handled by this worker can call `apply`
 * directly.
 *
 * Pure of Orca and of child processes: the runners, the event bus and the
 * timers are injected, so the tests count calls instead of spawning.
 */

import { MODULE_IDS, parseFeatureModules, workerJobsFor, workerJobsOn, workerTriggerOn } from '../../src/core/feature_modules.ts'

function isRecord (value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The module states the installer's `status` reports (`modules[id].state`),
 * or null when it carries none (a failed run, an older installer): no news,
 * so the worker keeps the state it has.
 */
export function modulesFromStatus (status) {
  if (!isRecord(status) || status.ok !== true || !isRecord(status.modules)) return null
  const states = {}
  for (const id of MODULE_IDS) {
    const row = status.modules[id]
    if (isRecord(row)) states[id] = row.state
  }
  return parseFeatureModules(JSON.stringify({ modules: states }))
}

/**
 * The module states the `feature-modules-read` sidecar answered (`{ ok,
 * value }`), re-validated through the same parser; null on a failed read.
 */
export function modulesFromRead (result) {
  if (!isRecord(result) || result.ok !== true || !isRecord(result.value)) return null
  return parseFeatureModules(JSON.stringify({ modules: result.value }))
}

/**
 * Wraps the rescan's status read: whatever module states the installer
 * reports move the scheduler, and the status goes back unchanged to the
 * rescan. The rescan runs about once a minute and already spawns the
 * installer, so following the state through it costs no extra process.
 */
export function followStatus (scheduler, readStatus) {
  return async () => {
    const status = await readStatus()
    const modules = modulesFromStatus(status)
    if (modules !== null) await scheduler.apply(modules)
    return status
  }
}

/**
 * @param {object} deps
 * @param {object} deps.initial       FeatureModules before the first read (the defaults).
 * @param {Record<string, () => Promise<unknown>>} deps.runners  A job's work, by registry job id: the activation and interval jobs.
 * @param {Record<string, (payload: unknown) => Promise<unknown>>} deps.eventHandlers  By Orca event name.
 * @param {Record<string, number>} deps.periods  Interval trigger -> milliseconds.
 * @param {(name: string, callback: (payload: unknown) => void) => unknown} deps.subscribe  `orca.events.on`; may return an unsubscribe function.
 * @param {{ setInterval: Function, clearInterval: Function }} [deps.timers]
 * @param {(message: string) => void} deps.log
 * @param {Record<string, string>} [deps.after]  A job that starts only after another one of the same batch (the docs check needs the seeded catalog).
 */
export function createModuleScheduler ({ initial, runners, eventHandlers, periods, subscribe, timers = { setInterval, clearInterval }, log, after = {} }) {
  let modules = initial
  let on = new Set(workerJobsOn(modules))
  let started = false
  let closed = false

  async function runOne (id) {
    const runner = runners[id]
    if (!on.has(id) || runner === undefined) return
    try {
      await runner()
    } catch (error) {
      log(`${id} failed: ${String(error?.message ?? error)}`)
    }
  }

  function runBatch (ids) {
    const pending = new Map()
    const launch = (id) => {
      if (!pending.has(id)) {
        const prerequisite = after[id]
        const wait = prerequisite !== undefined && ids.includes(prerequisite) ? launch(prerequisite) : Promise.resolve()
        pending.set(id, wait.then(() => runOne(id)))
      }
      return pending.get(id)
    }
    return Promise.all(ids.map(launch))
  }

  const stopOf = (value) => (typeof value === 'function' ? value : () => {})

  const groups = [
    ...Object.keys(periods).map((trigger) => ({
      trigger,
      stop: null,
      start: () => {
        const handle = timers.setInterval(() => {
          for (const id of workerJobsFor(trigger)) void runOne(id)
        }, periods[trigger])
        if (typeof handle?.unref === 'function') handle.unref()
        return () => timers.clearInterval(handle)
      }
    })),
    ...Object.keys(eventHandlers).map((trigger) => ({
      trigger,
      stop: null,
      start: () => stopOf(subscribe(trigger, (payload) => {
        if (!workerTriggerOn(modules, trigger)) return
        Promise.resolve(eventHandlers[trigger](payload)).catch((error) => log(`${trigger} handler failed: ${String(error?.message ?? error)}`))
      }))
    }))
  ]

  /** Creates what a trigger needs while one of its jobs is on, and removes it when none is. */
  function sync () {
    for (const group of groups) {
      const wanted = !closed && workerTriggerOn(modules, group.trigger)
      if (wanted && group.stop === null) group.stop = group.start()
      else if (!wanted && group.stop !== null) {
        group.stop()
        group.stop = null
      }
    }
  }

  return {
    isOn: (jobId) => on.has(jobId),

    /** Starts the timers and handlers of the modules that are on, and runs their activation jobs. */
    async start () {
      started = true
      sync()
      await runBatch(workerJobsFor('activation').filter((id) => on.has(id)))
    },

    /** A new module state: timers and handlers follow it, and what was just turned on runs its activation jobs once. */
    async apply (next) {
      const before = on
      modules = next
      on = new Set(workerJobsOn(next))
      if (!started || closed) return
      sync()
      await runBatch(workerJobsFor('activation').filter((id) => on.has(id) && !before.has(id)))
    },

    /** Runs a poll turn's request handler only while its job is on; undefined (and nothing started) otherwise. */
    async run (jobId, work) {
      if (!on.has(jobId)) return undefined
      return work()
    },

    close () {
      closed = true
      sync()
    }
  }
}
