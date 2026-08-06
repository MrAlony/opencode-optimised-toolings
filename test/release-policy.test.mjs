import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");

test("publishing is local-only and runner workflows are absent", () => {
  assert.equal(existsSync(resolve(root, ".github/workflows/publish.yml")), false);
  const agents = read("AGENTS.md");
  const release = read("docs/RELEASE_RECOVERY.md");
  const packageJson = JSON.parse(read("package.json"));
  assert.match(agents, /Never create, restore, enable, dispatch, or rely on a publishing workflow/);
  assert.match(release, /does not use GitHub Actions|GitHub Actions.*not part/s);
  assert.equal(packageJson.scripts["release:local"], "node scripts/release-local.mjs");
  assert.equal(packageJson.publishConfig.provenance, false);
});

test("local release enforces immutable tags, complete tests, native passkey auth, and registry integrity", () => {
  const source = read("scripts/release-local.mjs");
  assert.match(source, /cat-file/);
  assert.match(source, /merge-base/);
  assert.match(source, /git.*archive/s);
  assert.match(source, /\["test"\]/);
  assert.doesNotMatch(source, /readOtp|setRawMode|NPM_CONFIG_OTP:\s*otp/);
  assert.match(source, /delete publishEnv\.NPM_CONFIG_OTP/);
  assert.match(source, /native authentication flow/);
  assert.match(source, /--provenance=false/);
  assert.match(source, /registry\.integrity !== packed\.integrity/);
  assert.match(source, /expectedTools = 17/);
  assert.match(source, /npmCli = process\.env\.npm_execpath/);
  assert.match(source, /process\.execPath/);
  assert.doesNotMatch(source, /actions\/checkout|runs-on|workflow_dispatch/);
});
