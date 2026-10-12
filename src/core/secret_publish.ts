// The gate's secret publish guard (odd/tasks/gate-secret-guard.md): whether
// a command stages, commits or pushes a secret path (secret_paths.ts). A
// pushed key cannot be taken back, so gate-bash.ts asks the person, naming
// the file, before any local allow, remembered authorization or cached
// verdict could let it through.
//
// Each git segment is read where it runs (command_locations.ts: after `cd`,
// in a subshell, through `git -C`). Only a segment that can stage, commit or
// push a secret costs a git read; everything else reads nothing.
//
// The result has three states: `found` (the gate asks), `clean`, and
// `unknown` when git could not answer a read that mattered. Unknown is no
// evidence of a secret, so it never asks; it only keeps the command off the
// local allows, so the ordinary path judges it.
//
// Pure: git and the filesystem are read through the caller's reader.

import { gitInvocation, locateCommandSegments } from "./command_locations.ts";
import { isSecretPath, secretPathKind } from "./secret_paths.ts";

export type SecretPublishKind = "add" | "commit" | "push";

export interface SecretPublishFinding {
  readonly kind: SecretPublishKind;
  /** The secret path, as git or the command names it. */
  readonly path: string;
}

export type SecretPublishResult = { readonly kind: "found"; readonly finding: SecretPublishFinding } | { readonly kind: "clean" } | { readonly kind: "unknown" };

export interface SecretPublishReader {
  /** The paths `git add --dry-run --force <args>` would stage in `dir`; null when git fails. */
  readonly forcedAddPaths: (dir: string, args: readonly string[]) => readonly string[] | null;
  /** The working-tree text of `path`, relative to `dir`; null when it cannot be read. */
  readonly workingContent: (dir: string, path: string) => string | null;
}

const CLEAN: SecretPublishResult = { kind: "clean" };
const UNKNOWN: SecretPublishResult = { kind: "unknown" };

/** A redirection word (`2>&1`, `>`, `>>out`), and whether its target is the next word. */
function redirection(word: string): { readonly is: boolean; readonly takesNext: boolean } {
  const match = /^\d*(?:[<>]{1,2}|>&|<&|&>{1,2})(.*)$/.exec(word);
  return match === null ? { is: false, takesNext: false } : { is: true, takesNext: (match[1] ?? "") === "" };
}

/** A git segment's own arguments, its redirections dropped. */
function withoutRedirections(args: readonly string[]): readonly string[] {
  const out: string[] = [];
  for (let at = 0; at < args.length; at += 1) {
    const { is, takesNext } = redirection(args[at] ?? "");
    if (!is) out.push(args[at] ?? "");
    else if (takesNext) at += 1;
  }
  return out;
}

interface AddShape {
  readonly forced: boolean;
  readonly dryRun: boolean;
  /** `-A`/`--all`, `-u`/`--update`: the flags that widen what a forced add stages, passed on to the dry run. */
  readonly widening: readonly string[];
  readonly pathspecs: readonly string[];
}

function addShape(args: readonly string[]): AddShape {
  let forced = false;
  let dryRun = false;
  const widening = new Set<string>();
  const pathspecs: string[] = [];
  let afterSeparator = false;
  for (const word of args) {
    if (afterSeparator) pathspecs.push(word);
    else if (word === "--") afterSeparator = true;
    else if (word.startsWith("--")) {
      forced ||= word === "--force";
      dryRun ||= word === "--dry-run";
      if (word === "--all" || word === "--no-ignore-removal") widening.add("-A");
      if (word === "--update") widening.add("-u");
    } else if (/^-[A-Za-z]+$/.test(word)) {
      forced ||= word.includes("f");
      dryRun ||= word.includes("n");
      if (word.includes("A")) widening.add("-A");
      if (word.includes("u")) widening.add("-u");
    } else pathspecs.push(word);
  }
  return { forced, dryRun, widening: [...widening], pathspecs };
}

/** A path that is a secret, read through the working tree when only its content can say. */
function secretIn(paths: readonly string[], dir: string | null, reader: SecretPublishReader): string | null {
  for (const path of paths) {
    if (secretPathKind(path) === null) continue;
    if (isSecretPath(path, () => (dir === null ? null : reader.workingContent(dir, path)))) return path;
  }
  return null;
}

function addResult(args: readonly string[], dir: string | null, reader: SecretPublishReader): SecretPublishResult {
  const shape = addShape(args);
  if (shape.dryRun) return CLEAN;
  const named = secretIn(shape.pathspecs, dir, reader);
  if (named !== null) return { kind: "found", finding: { kind: "add", path: named } };
  if (!shape.forced) return CLEAN;
  if (dir === null) return UNKNOWN;
  const staged = reader.forcedAddPaths(dir, [...shape.widening, ...(shape.pathspecs.length > 0 ? ["--", ...shape.pathspecs] : [])]);
  if (staged === null) return UNKNOWN;
  const secret = secretIn(staged, dir, reader);
  return secret === null ? CLEAN : { kind: "found", finding: { kind: "add", path: secret } };
}

/**
 * Whether `command`, run from `cwd`, stages, commits or pushes a secret
 * path. The first secret found wins; an unknown read is remembered but a
 * later segment may still find one.
 */
export function findSecretPublish(command: string, cwd: string, home: string, reader: SecretPublishReader): SecretPublishResult {
  let unknown = false;
  for (const { outer, dir } of locateCommandSegments(command, cwd, home)) {
    const git = gitInvocation(outer, dir, home);
    if (git === null) continue;
    const args = withoutRedirections(git.args);
    const result = git.subcommand === "add" ? addResult(args, git.dir, reader) : CLEAN;
    if (result.kind === "found") return result;
    unknown ||= result.kind === "unknown";
  }
  return unknown ? UNKNOWN : CLEAN;
}
