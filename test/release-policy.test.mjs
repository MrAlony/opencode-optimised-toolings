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
  assert.match(candidate, /candidatePackageSpecs\(generation\.root\)/)
  assert.match(candidate, /configSpecs,/)
  assert.match(candidate, /reconcileDeployment\(generation\.root/)
  assert.match(candidate, /runSelfPatch\(deploymentRoot, \{ toolchainRoot: root \}\)/)
  assert.match(candidate, /runtime-only transport intentionally excludes Bun\/dev dependencies/)
  assert.match(candidate, /stdout\.replace\(\/\\r\?\\n\$\/, ""\)/, "candidate audit paths must preserve Git porcelain's leading status columns")
  assert.ok(candidate.indexOf("tui-runtime-parity.test.mjs") < candidate.indexOf("reconcileDeployment(generation.root"), "candidate parity must pass before unified deployment reconciliation")
  assert.match(candidate, /tuiConfigEntry: null/)
  assert.doesNotMatch(candidate, /generation\.specs\.server|generation\.specs\.tui/)
  assert.doesNotMatch(candidate, /git tag|git push|npm publish/)
})

test("installed package exposes one public declaration and bridges its TUI export internally", () => {
  const packageJson = JSON.parse(read("package.json"))
  const bootstrap = read("packages/tui/bootstrap.js")
  const manifest = read("packages/selfpatch/patches/1.18.13/manifest.mjs")
  assert.equal(packageJson.exports["."], "./index.js")
  assert.equal(packageJson.exports["./server"], "./index.js")
  assert.equal(packageJson.exports["./tui"], "./packages/tui/bootstrap.js")
  assert.ok(packageJson.files.includes("packages/tui/bootstrap.js"))
  assert.match(bootstrap, /reconcileDeployment\(transportRoot, \{ publicPackage: true \}\)/)
  assert.match(bootstrap, /packages", "tui", "index\.tsx"/)
  assert.match(manifest, /server package bridge loader/)
  assert.match(manifest, /parsePluginSpecifier\(spec\)\.pkg === "opencode-optimised-toolings"/)
  assert.match(manifest, /normalized\.endsWith\("\/opencode-optimised-toolings"\)/)
  assert.match(manifest, /ConfigPaths\.fileInDirectory\(Global\.Path\.config, "opencode"\)/)
})

test("one discoverable control plane owns deployment state and derived outputs", () => {
  const packageJson = JSON.parse(read("package.json"))
  const agents = read("AGENTS.md")
  const control = read("packages/shared/deployment.js")
  assert.equal(packageJson.scripts.toolings, "node scripts/toolings.mjs")
  assert.equal(packageJson.scripts.doctor, "node scripts/toolings.mjs doctor")
  assert.match(agents, /only supported deployment-management interface/)
  assert.match(control, /deploymentRecordPath/)
  assert.match(control, /coordination pointer derived/)
  assert.match(control, /host runtime reconciled/)
  const legacyInstall = read("scripts/install.mjs")
  assert.match(legacyInstall, /developmentDeployment/)
  assert.doesNotMatch(legacyInstall, /writeJsonAtomic|ensureTuiCompanion/)
})

test("shareability validation requires the native stealth runtime and rejects retired Python workers", () => {
  const source = read("scripts/verify-shareable.mjs");
  assert.match(source, /packages\/stealth\/index\.js/);
  assert.match(source, /packages\/stealth\/lib\/worker-client\.js/);
  assert.match(source, /packages\/stealth\/lib\/tor\.js/);
  assert.match(source, /forbiddenLegacyFiles/);
  assert.match(source, /packages\/stealth\/worker\.py/);
  assert.match(source, /packages\/stealth\/requirements\.txt/);
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
  assert.match(source, /reconcileDeployment\(publishedGeneration\.root/);
  assert.match(source, /runSelfPatch\(deploymentRoot, \{ toolchainRoot: buildRoot \}\)/);
  assert.match(source, /published deployment did not reconcile exactly/);
  assert.match(source, /expectedTools = 17/);
  assert.match(source, /npmCli = process\.env\.npm_execpath/);
  assert.match(source, /process\.execPath/);
  assert.doesNotMatch(source, /actions\/checkout|runs-on|workflow_dispatch/);
});
