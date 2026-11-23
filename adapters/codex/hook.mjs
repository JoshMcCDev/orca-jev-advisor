#!/usr/bin/env node
/** Native Codex hooks; the existing Node gate needs no Claude executable. */
import { execFileSync } from 'node:child_process'
import { linkSync, mkdirSync, readFileSync, renameSync, writeSync, writeFileSync, unlinkSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { codexGateOutput, codexPatchPaths } from '../../src/core/codex_hooks.ts'
import { DEFAULT_FEATURE_MODULES, parseFeatureModules } from '../../src/core/feature_modules.ts'
import { normalizePlatform, resolveCacheDir, resolveConfigDir } from '../../src/core/paths.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

// Separate record types keep execution observations out of approval analytics.
function advisoryRecord (payload, kind) {
  const id = payload.tool_use_id
  const session = payload.session_id
  if (typeof id !== 'string' || !id || typeof session !== 'string' || !session) return
  try {
    const dir = resolveCacheDir(normalizePlatform(process.platform), {
      home: homedir(), appDataDir: process.env.APPDATA,
      localAppDataDir: process.env.LOCALAPPDATA, xdgCacheHome: process.env.XDG_CACHE_HOME
    })
    const records = join(dir, 'gate-advisory-records')
    mkdirSync(records, { recursive: true, mode: 0o700 })
    const key = createHash('sha256').update(JSON.stringify([session, id])).digest('hex')
    const record = join(records, key)
    if (kind !== 'pending') {
      const existing = JSON.parse(readFileSync(record, 'utf8'))
      if (existing.state !== 'pending') return
    }
    const temporary = join(records, `.${key}.${randomUUID()}`)
    try {
      writeFileSync(temporary, JSON.stringify({ state: kind === 'pending' ? 'pending' : 'executed', at: new Date().toISOString() }), { mode: 0o600, flag: 'wx' })
      if (kind === 'pending') linkSync(temporary, record)
      else renameSync(temporary, record)
    } finally {
      try { unlinkSync(temporary) } catch {}
    }
  } catch {}
}

function gateEnabled () {
  const config = resolveConfigDir(normalizePlatform(process.platform), {
    home: homedir(), appDataDir: process.env.APPDATA, xdgConfigHome: process.env.XDG_CONFIG_HOME
  })
  let modules = DEFAULT_FEATURE_MODULES
  try { modules = parseFeatureModules(readFileSync(join(config, 'feature-modules.json'), 'utf8')) } catch {}
  return modules.gate !== 'off'
}

export async function handleCodexHook (payload, run = runExistingGate) {
  if (!payload || typeof payload !== 'object' || !gateEnabled()) return null
  const event = payload.hook_event_name
  const sessionCwd = typeof payload.cwd === 'string' ? payload.cwd : process.cwd()
  const workdir = payload.tool_input?.workdir ?? payload.tool_input?.cwd
  const cwd = typeof workdir === 'string' && workdir.length > 0 ? resolve(sessionCwd, workdir) : sessionCwd
  if (payload.tool_name === 'Bash' && ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(event)) {
    if (typeof payload.tool_input?.command !== 'string') return null
    if (event === 'PostToolUse' || event === 'PostToolUseFailure') {
      advisoryRecord(payload, 'executed')
      if (event === 'PostToolUse') await run('gate-outcome.ts', { ...payload, cwd })
      return null
    }
    const raw = await run(event === 'PreToolUse' ? 'gate-bash.ts' : 'gate-outcome.ts', { ...payload, cwd })
    if (raw.trim()) {
      const specific = JSON.parse(raw)?.hookSpecificOutput
      if (specific && specific.permissionDecision == null && typeof specific.additionalContext === 'string') advisoryRecord(payload, 'pending')
    }
    return event === 'PreToolUse' && raw.trim() ? codexGateOutput(JSON.parse(raw)) : null
  }
  if (event !== 'PreToolUse' || payload.tool_name !== 'apply_patch' || typeof payload.tool_input?.command !== 'string') return null
  const { ownFileRefusal } = await import('../claude/gate-files.ts')
  const homes = [join(homedir(), '.codex'), resolve(process.env.CODEX_HOME || join(homedir(), '.codex'))]
  for (const path of codexPatchPaths(payload.tool_input.command)) {
    const refusal = await ownFileRefusal(resolve(cwd, path), homes)
    if (refusal !== null) return codexGateOutput(JSON.parse(refusal))
  }
  return null
}

function runExistingGate (script, payload) {
  return execFileSync(process.execPath, [join(root, 'adapters', 'claude', script)], {
    input: JSON.stringify(payload), encoding: 'utf8', timeout: 12000, maxBuffer: 256 * 1024,
    env: { ...process.env, ORCA_JEV_CODEX_GATE: '1' }, stdio: ['pipe', 'pipe', 'pipe']
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const output = await handleCodexHook(JSON.parse(readFileSync(0, 'utf8')))
    if (output !== null) writeSync(1, JSON.stringify(output))
  } catch {
    // Same failure boundary as the existing command gate: normal Codex approvals apply.
  }
  process.exit(0)
}
