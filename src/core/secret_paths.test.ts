// Unit tests for the gate's one definition of a secret path. Run with:
//   node --test --experimental-strip-types src/core/secret_paths.test.ts

import assert from "node:assert/strict";
import test from "node:test";

import { contentHoldsSecret, isSecretPath, secretPathKind } from "./secret_paths.ts";

const NO_CONTENT = (): string | null => null;

test("secret paths: dotenv files, keys, certificates and credentials, at any depth", () => {
  for (const path of [
    ".env",
    "./.env",
    "config/.env",
    ".env.local",
    ".env.production",
    "apps/web/.env.development.local",
    "server.pem",
    "certs/api.key",
    "id_rsa",
    ".ssh/id_rsa",
    "id_ed25519",
    "id_ecdsa",
    "keys/id_dsa",
    "client.p12",
    "client.pfx",
    "release.jks",
    "android/app/upload.keystore",
    "credentials.json",
    "gcp/credentials-prod.json",
    ".netrc",
    ".git-credentials",
    ".ENV",
  ]) {
    assert.equal(secretPathKind(path), "secret", path);
    assert.equal(isSecretPath(path, NO_CONTENT), true, path);
  }
});

test("secret paths: templates and public halves are never secret", () => {
  for (const path of [
    ".env.example",
    ".env.sample",
    ".env.template",
    "config/.env.local.example",
    ".env.example.local",
    "id_rsa.pub",
    ".ssh/id_ed25519.pub",
    "environment.ts",
    "src/env.ts",
    ".envrc.md",
    "README.md",
    "keys.ts",
    "credentials.ts",
    "docs/credentials.md",
    "package.json",
  ]) {
    assert.equal(secretPathKind(path), null, path);
    assert.equal(isSecretPath(path, NO_CONTENT), false, path);
  }
});

test("secret paths: .npmrc and .pypirc are secret only when they hold a credential", () => {
  assert.equal(secretPathKind(".npmrc"), "by-content");
  assert.equal(secretPathKind("packages/a/.npmrc"), "by-content");
  assert.equal(secretPathKind(".pypirc"), "by-content");

  assert.equal(contentHoldsSecret(".npmrc", "//registry.npmjs.org/:_authToken=npm_abcdef0123456789\n"), true);
  assert.equal(contentHoldsSecret(".npmrc", "_auth = dXNlcjpwYXNz\n"), true);
  assert.equal(contentHoldsSecret(".npmrc", "//npm.pkg.github.com/:_password=c2VjcmV0\n"), true);
  assert.equal(contentHoldsSecret(".npmrc", "registry=https://registry.npmjs.org/\nsave-exact=true\n"), false, "a registry-only .npmrc is commonly committed");
  assert.equal(contentHoldsSecret(".npmrc", "//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n"), false, "a token read from the environment is not a secret in the file");
  assert.equal(contentHoldsSecret(".npmrc", "//registry.npmjs.org/:_authToken=$NPM_TOKEN\n"), false);
  assert.equal(contentHoldsSecret(".pypirc", "[pypi]\nusername = __token__\npassword = pypi-AgEIcHlwaS5vcmc\n"), true);
  assert.equal(contentHoldsSecret(".pypirc", "[distutils]\nindex-servers = pypi\n"), false);

  assert.equal(isSecretPath(".npmrc", () => "//registry.npmjs.org/:_authToken=npm_abcdef0123456789\n"), true);
  assert.equal(isSecretPath(".npmrc", () => "registry=https://registry.npmjs.org/\n"), false);
  assert.equal(isSecretPath(".npmrc", NO_CONTENT), false, "content that cannot be read is no evidence of a secret");
});
