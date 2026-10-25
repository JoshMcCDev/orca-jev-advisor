// ---------------------------------------------------------------------------
// Invoking the `orca` CLI on the three platforms this plugin runs on.
//
// Three places shell out to `orca` (catalog derivation, board project
// resolution, the doctor's reachability probe) and all three did it the same
// way: `execFile('orca', args)`. That is correct on macOS and Linux, where the
// CLI on PATH is an executable file with a shebang and `execvp` runs it.
//
// It cannot work on Windows. There, a CLI installed on PATH is a `.cmd` (or
// `.ps1`, or `.bat`) shim, and `execFile` hands the name to CreateProcess,
// which runs `.exe` images only and resolves nothing through PATHEXT. The call
// fails with ENOENT -- and since all three call sites catch and fall back to
// an empty result, a Windows install showed an empty catalog, a board with no
// project names and a doctor reporting the CLI unreachable, with the actual
// cause visible only in the plugin log.
//
// Running the command through the platform's shell is what makes PATHEXT
// apply. It is enabled on Windows ONLY: elsewhere a shell adds a process, adds
// quoting rules, and buys nothing, because the shebang already works.
//
// On the safety of `shell: true` here, there are TWO exposures, not one, and
// the second is the one that is easy to miss:
//
//   1. Arguments are re-parsed by cmd.exe, whose quoting cannot be made
//      reliably injection-proof. Fixed CLI arguments live in
//      ORCA_CLI_ARGUMENTS. The only dynamic argument is the configuration
//      page URL, restricted by orcaLoopbackConfigTabArguments to 127.0.0.1,
//      a numeric port and a hex-only token. Nothing from a repository, a
//      branch name, a panel field or a Jev response reaches this shell path.
//   2. cmd.exe resolves a bare command name from the CURRENT DIRECTORY before
//      it consults PATH. The worker's cwd is not ours to assume, and this
//      plugin's whole job is to sit inside repositories: a checkout carrying
//      an `orca.cmd` at its root would be executed at plugin activation. That
//      is why `cwd` is required below rather than inherited -- callers pass a
//      directory this plugin controls, so the first place cmd.exe looks is a
//      place no repository can write to.
//
// Node 24 (which package.json requires) raises DEP0190 for args + shell:true.
// The warning is about exposure 1, which the fixed literals and validated
// loopback URL address; it is recorded here so the next person does not have
// to rediscover why the deprecation was accepted rather than silenced.
// ---------------------------------------------------------------------------

import type { SupportedPlatform } from "./paths.ts";

/**
 * Fixed argument lists this plugin passes to the CLI.
 *
 * Kept here as data so the fixed-command call sites stay auditable rather
 * than relying on three separately maintained argument lists.
 */
export const ORCA_CLI_ARGUMENTS = {
  worktreePs: ["worktree", "ps", "--json"],
  worktreeList: ["worktree", "list", "--json"],
  status: ["status", "--json"],
  accountList: ["account", "list", "--json"],
  repoList: ["repo", "list", "--json"],
} as const;

/**
 * The one dynamic CLI argument: the short-lived Jev configuration page URL.
 * Keep it restricted to a loopback URL and a hex-only fragment token before
 * it reaches `execFile` (which uses a shell for Windows `.cmd` shims).
 */
export function orcaLoopbackConfigTabArguments(url: string): string[] {
  const match = /^http:\/\/127\.0\.0\.1:(\d{1,5})\/#jev-config=([0-9a-f]{64})$/.exec(url);
  if (match === null) throw new Error("configuration tab URL must be a Jev loopback URL");
  const port = Number(match[1]);
  if (port < 1 || port > 65535) throw new Error("configuration tab URL port is invalid");
  return ["tab", "create", "--url", url, "--json"];
}

/**
 * Select the CLI for `platform`. An explicit Orca-provided override wins;
 * packaged Linux callers can supply Orca's registered CLI shim because
 * `orca-ide` may resolve to the AppImage launcher. The generic Linux
 * fallback stays `orca-ide` so it never accidentally launches GNOME's
 * screen reader through a bare `orca` command.
 */
export function orcaCliCommand(platform: SupportedPlatform, env: {
  readonly orcaCliCommand?: string | undefined;
  /** Packaged Linux Orca exposes its command through this shim; the AppImage launcher is not a CLI. */
  readonly linuxCliShim?: string | undefined;
}): string {
  const override = env.orcaCliCommand?.trim();
  if (override !== undefined && override.length > 0) return override;
  const linuxCliShim = env.linuxCliShim?.trim();
  if (platform === "linux" && linuxCliShim !== undefined && linuxCliShim.length > 0) return linuxCliShim;
  return platform === "linux" ? "orca-ide" : "orca";
}

/** How long any one CLI call may take before it is abandoned. */
export const ORCA_CLI_TIMEOUT_MS = 5000;

/**
 * `execFile` options for invoking the CLI on `platform`.
 *
 * `maxBuffer` is raised well above Node's 1MB default: the output is one JSON
 * document describing every worktree Orca knows, which on a working machine
 * with 65 of them is already ~130KB. The default leaves far less headroom than
 * it appears to, and exceeding it kills the child and surfaces as the same
 * empty result every other failure here produces.
 */
export function orcaCliOptions(platform: SupportedPlatform, cwd: string): {
  timeout: number;
  maxBuffer: number;
  shell: boolean;
  cwd: string;
  windowsHide: boolean;
} {
  return {
    timeout: ORCA_CLI_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    // See the module note: PATHEXT resolution for `.cmd` shims, Windows only.
    shell: platform === "win32",
    // Required, never inherited -- see exposure 2 in the module note.
    cwd,
    // Without this every call flashes a console window on Windows, three
    // times at activation alone.
    windowsHide: true,
  };
}
