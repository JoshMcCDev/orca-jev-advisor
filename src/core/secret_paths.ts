// The gate's one definition of a secret path: a file that, once it reaches a
// remote, cannot be taken back (odd/tasks/gate-secret-guard.md). Read by the
// own-tree reading of `git add` (contained_effect.ts) and by the publish guard
// (secret_publish.ts) for staged names and outgoing commits alike.
//
// Matched on the file name only, case-insensitively, at any depth. A name
// that is a template (`.env.example`, `.env.sample`, `.env.template`) or a
// public key half (`id_rsa.pub`) is never secret. `.npmrc` and `.pypirc` are
// committed on purpose when they only name a registry, so they are secret
// only when their content holds a credential that is not read from the
// environment.
//
// The discard protection keeps its own, wider list
// (git_recoverability.ts's SECRET_PATTERN): losing a `.env.example` is a loss
// worth naming, publishing one is not a leak.
//
// Pure: content is read through the caller's reader.

/** `secret`: by name alone. `by-content`: only when contentHoldsSecret says so. */
export type SecretPathKind = "secret" | "by-content";

/** A file's text, or null when it cannot be read. */
export type SecretContentReader = () => string | null;

/** Name parts that make a dotenv file a template rather than a secret. */
const TEMPLATE_PARTS: ReadonlySet<string> = new Set(["example", "sample", "template"]);

/** Extensions of key stores, private keys and certificates. */
const SECRET_EXTENSIONS: readonly string[] = [".pem", ".key", ".p12", ".pfx", ".jks", ".keystore"];

/** Names that hold credentials whatever their content. */
const SECRET_NAMES: ReadonlySet<string> = new Set([".netrc", ".git-credentials"]);

/** SSH private keys: `id_rsa`, `id_ed25519`, ... and their copies (`id_rsa_work`), never the `.pub` half. */
const SSH_PRIVATE_KEY = /^id_(?:rsa|dsa|ecdsa|ed25519)(?:[._-].*)?$/;

/** `credentials.json`, `credentials-prod.json`, ... */
const CREDENTIALS_JSON = /^credentials.*\.json$/;

/** Names whose secrecy depends on their content. */
const BY_CONTENT_NAMES: ReadonlySet<string> = new Set([".npmrc", ".pypirc"]);

/**
 * Every name above as a git glob, for git to list only candidate files (a
 * first push of a large tree otherwise lists more than a mebibyte of names).
 * Wider than secretPathKind on purpose -- templates and `.pub` halves match
 * here and are dropped by it. Plain globs: the caller adds git's
 * `:(top,glob,icase)` magic.
 */
export const SECRET_PATH_GLOBS: readonly string[] = [
  "**/.env",
  "**/.env.*",
  ...SECRET_EXTENSIONS.map((extension) => `**/*${extension}`),
  ...[...SECRET_NAMES].map((name) => `**/${name}`),
  "**/id_rsa*",
  "**/id_dsa*",
  "**/id_ecdsa*",
  "**/id_ed25519*",
  "**/credentials*.json",
  ...[...BY_CONTENT_NAMES].map((name) => `**/${name}`),
];

/** The file name of `path`, lower case. */
function fileName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1).toLowerCase();
}

/** Whether `path` names a secret by its name, may be one by its content, or neither (null). */
export function secretPathKind(path: string): SecretPathKind | null {
  const name = fileName(path);
  if (name.endsWith(".pub")) return null;
  if (name === ".env") return "secret";
  if (name.startsWith(".env.")) return name.slice(".env.".length).split(".").some((part) => TEMPLATE_PARTS.has(part)) ? null : "secret";
  if (SECRET_NAMES.has(name) || SSH_PRIVATE_KEY.test(name) || CREDENTIALS_JSON.test(name)) return "secret";
  if (SECRET_EXTENSIONS.some((extension) => name.endsWith(extension) && name.length > extension.length)) return "secret";
  return BY_CONTENT_NAMES.has(name) ? "by-content" : null;
}

/** A value that only names an environment variable (`${NPM_TOKEN}`, `$NPM_TOKEN`) is not a credential in the file. */
function isEnvironmentReference(value: string): boolean {
  return /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(value);
}

/** Every `key = value` line of an ini-style file, key lower case. */
function assignments(content: string): readonly { readonly key: string; readonly value: string }[] {
  const out: { key: string; value: string }[] = [];
  for (const line of content.split(/\r?\n/)) {
    const at = line.indexOf("=");
    if (at === -1 || /^\s*[#;]/.test(line)) continue;
    out.push({ key: line.slice(0, at).trim().toLowerCase(), value: line.slice(at + 1).trim() });
  }
  return out;
}

/** Whether a by-content file's text holds a credential that is not read from the environment. */
export function contentHoldsSecret(path: string, content: string): boolean {
  const name = fileName(path);
  const keys = name === ".pypirc" ? ["password"] : ["_authtoken", "_auth", "_password"];
  return assignments(content).some(({ key, value }) => {
    // `.npmrc` scopes a credential to a registry: `//host/:_authToken=...`.
    const bare = key.slice(key.lastIndexOf(":") + 1);
    return keys.includes(bare) && value.length > 0 && !isEnvironmentReference(value);
  });
}

/** Whether `path` is a secret: by its name, or by the content `readContent` returns (unreadable content is no evidence). */
export function isSecretPath(path: string, readContent: SecretContentReader): boolean {
  const kind = secretPathKind(path);
  if (kind !== "by-content") return kind === "secret";
  const content = readContent();
  return content !== null && contentHoldsSecret(path, content);
}
