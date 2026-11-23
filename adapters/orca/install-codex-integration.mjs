#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyNode, managedNodeRoots, nodeCandidatePaths } from '../../src/core/node_runtime.ts'
import { resolveOrcaUserDataDir } from '../../src/core/orca_accounts.ts'
import { normalizePlatform } from '../../src/core/paths.ts'

const MARKER = 'orca-jev-advisor: Codex gate'
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)

export async function discoverCodexHomes (env = process.env, home = homedir(), errors = null) {
  const homes = new Set([join(home, '.codex'), resolve(env.CODEX_HOME || join(home, '.codex'))])
  const userData = resolveOrcaUserDataDir(normalizePlatform(process.platform), {
    home, appDataDir: env.APPDATA, xdgConfigHome: env.XDG_CONFIG_HOME, orcaUserDataPath: env.ORCA_USER_DATA_PATH
  }).path
  const accounts = join(userData, 'codex-accounts')
  let entries = []
  try { entries = await readdir(accounts, { withFileTypes: true }) } catch (error) { if (error.code !== 'ENOENT') { if (errors) errors.push(accounts); else throw error } }
  for (const entry of entries.filter(entry => entry.isDirectory())) {
    const target = join(accounts, entry.name, 'home')
    try {
      if ((await lstat(target)).isDirectory() && (await readFile(join(target, '.orca-managed-home'), 'utf8')).trim() === entry.name) homes.add(target)
    } catch (error) { if (error.code !== 'ENOENT') { if (errors) errors.push(target); else throw error } }
  }
  return [...homes]
}

async function readRaw (path) {
  try { return await readFile(path, 'utf8') } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

function parseHooks (raw) {
  let value
  try { value = raw === null ? {} : JSON.parse(raw) }
  catch { throw new Error('hooks.json contains invalid JSON; file left untouched') }
  if (!isRecord(value) || (value.hooks !== undefined && !isRecord(value.hooks))) throw new Error('hooks.json must contain an object with a hooks object')
  for (const event of ['PreToolUse', 'PostToolUse']) {
    if (value.hooks?.[event] !== undefined && (!Array.isArray(value.hooks[event]) || value.hooks[event].some(group => !isRecord(group) || !Array.isArray(group.hooks)))) throw new Error(`Invalid ${event} hook groups; file left untouched`)
  }
  return value
}

function ours (hook) {
  return isRecord(hook) && hook.statusMessage === MARKER && typeof hook.command === 'string' && /adapters[\\/]codex[\\/]hook\.mjs/.test(hook.command)
}

export function mergeCodexHooks (value, command) {
  const next = structuredClone(value)
  for (const event of ['PreToolUse', 'PostToolUse']) {
    const groups = next.hooks?.[event] ?? []
    const kept = groups.map(group => ({ ...group, hooks: group.hooks.filter(hook => !ours(hook)) }))
      .filter((group, i) => group.hooks.length > 0 || groups[i].hooks.length === 0)
    if (command !== null) kept.push({ matcher: event === 'PreToolUse' ? '^(Bash|apply_patch)$' : '^Bash$', hooks: [{ type: 'command', command, timeout: 15, statusMessage: MARKER }] })
    if (kept.length) { next.hooks ??= {}; next.hooks[event] = kept }
    else if (next.hooks) delete next.hooks[event]
  }
  // Removing our final entries should not leave an artificial empty container.
  if (next.hooks && Object.keys(next.hooks).length === 0) delete next.hooks
  return next
}

async function nodeCommand () {
  const managed = {}
  for (const { root } of managedNodeRoots(process.platform, homedir())) {
    try { managed[root] = await readdir(root) } catch { managed[root] = [] }
  }
  const candidates = [...nodeCandidatePaths({ platform: process.platform, home: homedir(), pathEnv: process.env.PATH ?? '', override: process.env.ORCA_JEV_NODE_CANDIDATES, managed })]
  if (!process.versions.electron && !process.env.ORCA_JEV_NODE_CANDIDATES) candidates.unshift(process.execPath)
  for (const path of candidates) {
    try { if (classifyNode(path, execFileSync(path, ['--version'], { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'pipe'] })).state === 'ok') return path } catch {}
  }
  throw new Error('Node 24 or newer is required for Codex hooks')
}

function quote (path) {
  if (process.platform === 'win32') {
    if (/["%!\r\n]/.test(path)) throw new Error('Unsupported character in Windows hook path')
    return `"${path}"`
  }
  return `'${path.replaceAll("'", "'\\''")}'`
}

async function configured (value, pluginRoot) {
  const scriptPath = join(pluginRoot, 'adapters', 'codex', 'hook.mjs')
  try {
    if (!(await lstat(scriptPath)).isFile()) return false
    await readFile(scriptPath)
  } catch { return false }
  const script = quote(scriptPath)
  let trustedNode
  try { trustedNode = await nodeCommand() } catch { return false }
  for (const event of ['PreToolUse', 'PostToolUse']) {
    const owned = (value.hooks?.[event] ?? []).flatMap(group => group.hooks.filter(hook => isRecord(hook) && hook.statusMessage === MARKER).map(hook => ({ group, hook })))
    if (owned.length !== 1) return false
    const { group, hook } = owned[0]
    if (!ours(hook) || group.matcher !== (event === 'PreToolUse' ? '^(Bash|apply_patch)$' : '^Bash$') || hook.type !== 'command' || hook.timeout !== 15) return false
    const suffix = ` ${script}`
    if (!hook.command.endsWith(suffix)) return false
    const executable = hook.command.slice(0, -suffix.length)
    let path
    if (process.platform === 'win32') {
      if (!/^"[^"%!,\r\n]+"$/.test(executable)) return false
      path = executable.slice(1, -1)
    } else {
      if (!/^'(?:[^']|'\\'' )*'$/.test(executable)) {
        // Decode only the exact shell quoting emitted by quote().
        const parts = executable.split("'\\''")
        if (!executable.startsWith("'") || !executable.endsWith("'") || parts.some((part, i) => (i === 0 ? part.slice(1) : i === parts.length - 1 ? part.slice(0, -1) : part).includes("'"))) return false
      }
      path = executable.slice(1, -1).replaceAll("'\\''", "'")
    }
    if (!path || quote(path) !== executable) return false
    if (path !== trustedNode) return false
  }
  return true
}

async function writeGuarded (path, expected, text) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, text, { mode: 0o600, flag: 'wx' })
    if (await readRaw(path) !== expected) throw new Error('hooks.json changed during setup; retry without overwriting the concurrent edit')
    await rename(temporary, path)
  } finally { await rm(temporary, { force: true }) }
}

export async function configureCodex (mode, pluginRoot, options = {}) {
  if (!['install', 'uninstall', 'status'].includes(mode)) throw new Error('Expected install, uninstall, or status')
  const discoveryErrors = []
  const homes = options.homes ?? await discoverCodexHomes(process.env, homedir(), mode === 'status' ? discoveryErrors : null)
  if (mode === 'status') {
    const targets = await Promise.all(homes.map(async home => {
      try {
        const value = parseHooks(await readRaw(join(home, 'hooks.json')))
        const installed = await configured(value, pluginRoot)
        return { home, installed, state: installed ? 'configured' : 'missing-or-stale' }
      } catch { return { home, installed: false, state: 'unreadable' } }
    }))
    return { ok: true, targets, discoveryErrors, installed: discoveryErrors.length === 0 && targets.length > 0 && targets.every(target => target.installed), trustRequired: true }
  }
  if (mode === 'install' && !(await lstat(join(pluginRoot, 'adapters', 'codex', 'hook.mjs'))).isFile()) throw new Error('Codex hook script is missing')
  // Validate every target before changing any of them.
  const inputs = await Promise.all(homes.map(async home => {
    const path = join(home, 'hooks.json')
    const raw = await readRaw(path)
    return { home, path, raw, value: parseHooks(raw) }
  }))
  const command = mode === 'install' ? `${quote(options.node ?? await nodeCommand())} ${quote(join(pluginRoot, 'adapters', 'codex', 'hook.mjs'))}` : null
  const targets = []
  for (const { home, path, raw, value } of inputs) {
    if (mode !== 'status') {
      const next = mergeCodexHooks(value, command)
      const text = `${JSON.stringify(next, null, 2)}\n`
      if (JSON.stringify(next) !== JSON.stringify(value)) {
        if (raw !== null) {
          try { await writeFile(`${path}.jev-advisor.bak`, raw, { mode: 0o600, flag: 'wx' }) } catch (error) { if (error.code !== 'EEXIST') throw error }
        }
        await writeGuarded(path, raw, text)
      }
    }
    const current = mode === 'status' ? value : parseHooks(await readRaw(path))
    const installed = await configured(current, pluginRoot)
    targets.push({ home, installed })
  }
  return { ok: true, targets, installed: targets.length > 0 && targets.every(target => target.installed), trustRequired: true }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(JSON.stringify(await configureCodex(process.argv[2], resolve(process.argv[3] || '.')))) }
  catch (error) { process.stdout.write(JSON.stringify({ ok: false, reason: 'codex-setup-failed', detail: String(error.message).slice(0, 500) })) }
}
