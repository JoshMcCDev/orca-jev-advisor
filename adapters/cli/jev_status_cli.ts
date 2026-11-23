import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// The installer is shared with the Orca adapter.
// @ts-expect-error JavaScript installer has no declarations.
import { configureCodex } from '../orca/install-codex-integration.mjs';
import { normalizePlatform, resolveConfigDir } from '../../src/core/paths.ts';
import { parseProviderSettings } from '../../src/core/provider_settings.ts';
import { resolveApiKey, resolveClefCredentials } from '../../src/core/secrets.ts';
import { createJevProvider } from '../../src/core/decision_provider.ts';
import { createClefProvider, clefFailureOf } from '../../src/core/clef.ts';
import { jevFailureOf } from '../../src/core/jev.ts';
import type { DecisionProvider } from '../../src/core/decision_provider.ts';

export async function probe(provider: DecisionProvider | null, check: boolean) {
  if (!provider) return { credential: 'missing', status: check ? 'missing' : 'not-checked' };
  if (!check) return { credential: 'present', status: 'not-checked' };
  try {
    await provider.ask({}, { ready: { type: 'noul', instructions: 'Is this a status check?' } }, { budgetMs: 3000 });
    return { credential: 'present', status: 'accepted' };
  } catch (error) {
    const failure = clefFailureOf(error) ?? jevFailureOf(error);
    const status = failure?.kind === 'auth' || (failure?.kind === 'http4xx' && (failure.status === 401 || failure.status === 403)) ? 'rejected'
      : failure?.kind === 'timeout' || failure?.kind === 'network' ? 'unreachable' : 'provider-error';
    return { credential: 'present', status };
  }
}

export async function status(root: string, check: boolean, homes?: string[]) {
  const hooks = await configureCodex('status', root, homes ? { homes } : {});
  const config = resolveConfigDir(normalizePlatform(process.platform), { home: homedir(), appDataDir: process.env.APPDATA, xdgConfigHome: process.env.XDG_CONFIG_HOME });
  let raw: string | null;
  try { raw = await readFile(join(config, 'decision-provider.json'), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { homes: hooks.targets, discoveryErrors: hooks.discoveryErrors, mode: 'unknown', providers: {}, trust: 'unverified', execution: 'unverified' };
    raw = null;
  }
  const settings = parseProviderSettings(raw);
  const providers: Record<string, Awaited<ReturnType<typeof probe>>> = {};
  if (settings.mode !== 'clef') {
    const key = await resolveApiKey();
    providers.jev = await probe(key ? createJevProvider(key) : null, check);
  }
  if (settings.mode !== 'jev') {
    const credentials = await resolveClefCredentials();
    providers.clef = await probe(credentials ? createClefProvider({ ...credentials, model: settings.clefModel }) : null, check);
  }
  return { homes: hooks.targets, discoveryErrors: hooks.discoveryErrors, mode: settings.mode, providers, trust: 'unverified', execution: 'unverified' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--json', '--check-provider'].includes(arg))) {
    process.stderr.write('Usage: jev-status [--json] [--check-provider]\n'); process.exitCode = 2;
  } else {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    try { process.stdout.write(JSON.stringify(await status(root, args.includes('--check-provider')), null, 2) + '\n'); }
    catch { process.stderr.write('Status unavailable.\n'); process.exitCode = 1; }
  }
}
