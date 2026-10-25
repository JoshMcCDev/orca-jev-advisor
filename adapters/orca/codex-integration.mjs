import { execFile } from 'node:child_process'
import { join, resolve } from 'node:path'
import { managedNodeRoots } from '../../src/core/node_runtime.ts'

/** Worker-side transport; the sidecar owns hook files and never trusts them for Codex. */
export function createCodexIntegration ({ root, userData, home, env, storage, log }) {
  const run = mode => new Promise(resolveResult => {
    const homes = [join(home, '.codex'), resolve(env.CODEX_HOME || join(home, '.codex')), join(userData, 'codex-accounts')]
    const grants = ['--permission', `--allow-fs-read=${root}`]
    for (const path of homes) {
      grants.push(`--allow-fs-read=${path}`, `--allow-fs-read=${path}/*`)
      if (mode !== 'status') grants.push(`--allow-fs-write=${path}`, `--allow-fs-write=${path}/*`)
    }
    if (mode === 'install') {
      for (const { root: nodeRoot } of managedNodeRoots(process.platform, home)) grants.push(`--allow-fs-read=${nodeRoot}`, `--allow-fs-read=${nodeRoot}/*`)
      grants.push('--allow-child-process')
    }
    execFile(process.execPath, [...grants, join(root, 'adapters/orca/install-codex-integration.mjs'), mode, root], {
      env, timeout: 20000, maxBuffer: 256 * 1024
    }, (error, stdout) => {
      try {
        const result = JSON.parse(stdout)
        if (typeof result.ok === 'boolean') { resolveResult(result); return }
      } catch {}
      resolveResult({ ok: false, reason: 'codex-setup-failed', detail: String(error?.message || 'The sidecar returned no result').slice(0, 300) })
    })
  })
  const publish = async () => {
    const status = await run('status')
    await storage.set('codexIntegrationStatus', { ...status, checkedAt: new Date().toISOString() })
    return status
  }
  const configure = async mode => {
    const result = await run(mode)
    if (result.ok && mode === 'install') await storage.set('agentIntegration', 'codex')
    await publish()
    return result
  }
  const attend = async () => {
    const request = await storage.get('codexIntegrationRequest')
    if (!request || typeof request.id !== 'string' || typeof request.at !== 'string') return
    await storage.delete('codexIntegrationRequest')
    const age = Date.now() - Date.parse(request.at)
    const result = !(age >= 0 && age <= 60000) ? { ok: false, detail: 'Setup request expired' }
      : !['install', 'uninstall'].includes(request.intent) ? { ok: false, detail: 'Unknown Codex setup request' }
      : await configure(request.intent)
    if (!result.ok) log(`Codex integration: ${result.detail || result.reason}`)
    await storage.set('codexIntegrationResult', { ...result, id: request.id })
  }
  return { run, publish, configure, attend }
}
