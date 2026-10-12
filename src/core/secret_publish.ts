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
  /** A push only: the outgoing commit that added or changed it. */
  readonly commit?: string;
}

export type SecretPublishResult = { readonly kind: "found"; readonly finding: SecretPublishFinding } | { readonly kind: "clean" } | { readonly kind: "unknown" };

export interface SecretPublishReader {
  /** The paths `git add --dry-run --force <args>` would stage in `dir`; null when git fails. */
  readonly forcedAddPaths: (dir: string, args: readonly string[]) => readonly string[] | null;
  /** The working-tree text of `path`, relative to `dir`; null when it cannot be read. */
  readonly workingContent: (dir: string, path: string) => string | null;
  /** The staged paths of the repository at `dir` (deletions left out), relative to its root; null when git fails. */
  readonly stagedPaths: (dir: string) => readonly string[] | null;
  /** Its tracked paths modified in the working tree (deletions left out), relative to its root; null when git fails. */
  readonly modifiedTrackedPaths: (dir: string) => readonly string[] | null;
  /** The staged text of `path`, relative to the root; null when it cannot be read. */
  readonly indexContent: (dir: string, path: string) => string | null;
  /** The working-tree text of `path`, relative to the root; null when it cannot be read. */
  readonly treeContent: (dir: string, path: string) => string | null;
  /**
   * `git log --format='commit %h' --name-status --no-renames <sources> --not
   * --remotes[=<remote>]`: every commit `sources` would send that no
   * remote-tracking branch of `remote` (of any remote, when null) already
   * has, with the paths each one touched; null when git fails.
   */
  readonly outgoingLog: (dir: string, sources: readonly string[], remote: string | null) => string | null;
  /** The text of `path` (relative to the root) in `commit`; null when it cannot be read. */
  readonly commitContent: (dir: string, commit: string, path: string) => string | null;
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

/** The first path that is a secret, its content read through `read` only when only its content can say. */
function firstSecret(paths: readonly string[], read: (path: string) => string | null): string | null {
  for (const path of paths) {
    if (secretPathKind(path) !== null && isSecretPath(path, () => read(path))) return path;
  }
  return null;
}

/** A path that is a secret, read through the working tree (relative to `dir`) when only its content can say. */
function secretIn(paths: readonly string[], dir: string | null, reader: SecretPublishReader): string | null {
  return firstSecret(paths, (path) => (dir === null ? null : reader.workingContent(dir, path)));
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

/** `git commit` short options that take a value, attached or as the next word. */
const COMMIT_SHORT_WITH_VALUE = "mFCct";
/** `git commit` long options that take the next word as their value when no `=` is attached. */
const COMMIT_LONG_WITH_VALUE: ReadonlySet<string> = new Set(["--message", "--file", "--reuse-message", "--reedit-message", "--template", "--author", "--date", "--cleanup", "--fixup", "--squash", "--trailer", "--pathspec-from-file"]);

interface CommitShape {
  readonly all: boolean;
  readonly include: boolean;
  readonly dryRun: boolean;
  readonly pathspecs: readonly string[];
}

function commitShape(args: readonly string[]): CommitShape {
  let all = false;
  let include = false;
  let dryRun = false;
  const pathspecs: string[] = [];
  let afterSeparator = false;
  for (let at = 0; at < args.length; at += 1) {
    const word = args[at] ?? "";
    if (afterSeparator) pathspecs.push(word);
    else if (word === "--") afterSeparator = true;
    else if (word.startsWith("--")) {
      all ||= word === "--all";
      include ||= word === "--include";
      dryRun ||= word === "--dry-run";
      if (COMMIT_LONG_WITH_VALUE.has(word)) at += 1;
    } else if (/^-[A-Za-z]/.test(word)) {
      // A cluster reads flag by flag until one takes a value: the rest of the
      // word is that value, or the next word when nothing is attached.
      for (let index = 1; index < word.length; index += 1) {
        const flag = word[index] ?? "";
        if (COMMIT_SHORT_WITH_VALUE.includes(flag)) {
          if (index === word.length - 1) at += 1;
          break;
        }
        all ||= flag === "a";
        include ||= flag === "i";
      }
    } else pathspecs.push(word);
  }
  return { all, include, dryRun, pathspecs };
}

function commitResult(args: readonly string[], dir: string | null, reader: SecretPublishReader): SecretPublishResult {
  const shape = commitShape(args);
  if (shape.dryRun) return CLEAN;
  const named = secretIn(shape.pathspecs, dir, reader);
  if (named !== null) return { kind: "found", finding: { kind: "commit", path: named } };
  // A pathspec commits only what it names, unless --include keeps the index.
  if (shape.pathspecs.length > 0 && !shape.include) return CLEAN;
  if (dir === null) return UNKNOWN;
  const staged = reader.stagedPaths(dir);
  if (staged === null) return UNKNOWN;
  const fromIndex = firstSecret(staged, (path) => reader.indexContent(dir, path));
  if (fromIndex !== null) return { kind: "found", finding: { kind: "commit", path: fromIndex } };
  if (!shape.all) return CLEAN;
  const modified = reader.modifiedTrackedPaths(dir);
  if (modified === null) return UNKNOWN;
  const fromTree = firstSecret(modified, (path) => reader.treeContent(dir, path));
  return fromTree === null ? CLEAN : { kind: "found", finding: { kind: "commit", path: fromTree } };
}

/** `git push` options that take the next word as their value when no `=` is attached. */
const PUSH_LONG_WITH_VALUE: ReadonlySet<string> = new Set(["--repo", "--push-option", "--receive-pack", "--exec"]);

interface PushShape {
  /** What git log reads as the commits sent: refspec sources, `HEAD`, or `--branches`/`--all`/`--tags`. */
  readonly sources: readonly string[];
  /** The remote by name, or null for git's default or a URL (then every remote-tracking branch counts as already there). */
  readonly remote: string | null;
  /** A source that is not a plain revision: never handed to git. */
  readonly unreadable: boolean;
}

/** A refspec source git log may read as a revision, never as an option. */
const PLAIN_REVISION = /^[A-Za-z0-9_@][A-Za-z0-9_./@{}^~-]*$/;
const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function pushShape(args: readonly string[]): PushShape | null {
  let deletes = false;
  let dryRun = false;
  let everyBranch = false;
  let mirror = false;
  let tags = false;
  let repo: string | null = null;
  const positionals: string[] = [];
  let afterSeparator = false;
  for (let at = 0; at < args.length; at += 1) {
    const word = args[at] ?? "";
    if (afterSeparator) positionals.push(word);
    else if (word === "--") afterSeparator = true;
    else if (word.startsWith("--")) {
      const name = word.includes("=") ? word.slice(0, word.indexOf("=")) : word;
      const value = word.includes("=") ? word.slice(word.indexOf("=") + 1) : PUSH_LONG_WITH_VALUE.has(name) ? (args[(at += 1)] ?? "") : null;
      if (name === "--repo") repo = value;
      deletes ||= name === "--delete";
      dryRun ||= name === "--dry-run";
      everyBranch ||= name === "--all" || name === "--branches";
      mirror ||= name === "--mirror";
      tags ||= name === "--tags";
    } else if (/^-[A-Za-z]+$/.test(word)) {
      deletes ||= word.includes("d");
      dryRun ||= word.includes("n");
      if (word.endsWith("o")) at += 1;
    } else positionals.push(word);
  }
  if (deletes || dryRun) return null;
  const named = positionals[0] ?? repo;
  const remote = named !== null && REMOTE_NAME.test(named) ? named : null;
  const refSources = positionals.slice(1).flatMap((refspec) => {
    const spec = refspec.startsWith("+") ? refspec.slice(1) : refspec;
    const source = spec.includes(":") ? spec.slice(0, spec.indexOf(":")) : spec;
    return source.length === 0 ? [] : [source];
  });
  const unreadable = refSources.some((source) => !PLAIN_REVISION.test(source));
  if (mirror) return { sources: ["--all"], remote, unreadable };
  if (everyBranch) return { sources: ["--branches"], remote, unreadable };
  if (tags) return { sources: ["--tags", ...refSources], remote, unreadable };
  // A refspec list made only of deletions (`:feat/x`) sends nothing.
  if (positionals.length > 1 && refSources.length === 0) return null;
  return { sources: refSources.length > 0 ? refSources : ["HEAD"], remote, unreadable };
}

/** A path as git prints it: a name with unusual characters comes quoted. */
function unquoted(path: string): string {
  return path.startsWith('"') && path.endsWith('"') ? path.slice(1, -1).replace(/\\(["\\])/g, "$1") : path;
}

/** Every path an outgoing commit added or changed (a deletion publishes nothing), newest commit first. */
function outgoingChanges(log: string): readonly { readonly commit: string; readonly path: string }[] {
  const out: { commit: string; path: string }[] = [];
  let commit = "";
  for (const line of log.split("\n")) {
    if (line.startsWith("commit ")) commit = line.slice("commit ".length).trim();
    const change = /^([ACMTUXB])\d*\t(.+)$/.exec(line);
    if (change !== null && commit.length > 0) out.push({ commit, path: unquoted(change[2] ?? "") });
  }
  return out;
}

function pushResult(args: readonly string[], dir: string | null, reader: SecretPublishReader): SecretPublishResult {
  const shape = pushShape(args);
  if (shape === null) return CLEAN;
  if (dir === null || shape.unreadable) return UNKNOWN;
  const log = reader.outgoingLog(dir, shape.sources, shape.remote);
  if (log === null) return UNKNOWN;
  for (const { commit, path } of outgoingChanges(log)) {
    if (secretPathKind(path) !== null && isSecretPath(path, () => reader.commitContent(dir, commit, path))) return { kind: "found", finding: { kind: "push", path, commit } };
  }
  return CLEAN;
}

/** What one git segment stages, commits or pushes. */
function segmentResult(subcommand: string | null, args: readonly string[], dir: string | null, reader: SecretPublishReader): SecretPublishResult {
  switch (subcommand) {
    case "add":
      return addResult(args, dir, reader);
    case "commit":
      return commitResult(args, dir, reader);
    case "push":
      return pushResult(args, dir, reader);
    default:
      return CLEAN;
  }
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
    const result = segmentResult(git.subcommand, args, git.dir, reader);
    if (result.kind === "found") return result;
    unknown ||= result.kind === "unknown";
  }
  return unknown ? UNKNOWN : CLEAN;
}
