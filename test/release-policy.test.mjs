import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
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

test("candidate promotion is built from the exact validated working tree before any release", () => {
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
  const candidate = readFileSync(join(root, "scripts", "candidate-local.mjs"), "utf8")
  assert.equal(packageJson.scripts["candidate:local"], "node scripts/candidate-local.mjs")
  assert.match(candidate, /npm", \["pack", "--json"/)
  assert.match(candidate, /checkoutFingerprint !== transportFingerprint/)
  assert.match(candidate, /test\/tui-runtime-parity\.test\.mjs/)
  assert.match(candidate, /activatePackageGeneration\(generation/)
  assert.ok(candidate.indexOf("tui-runtime-parity.test.mjs") < candidate.indexOf("activatePackageGeneration(generation"), "candidate parity must pass before live activation")
  assert.doesNotMatch(candidate, /git tag|git push|npm publish/)
})

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
