#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageName = "opencode-optimised-toolings";
const expectedTools = 17;
const npmCli = process.env.npm_execpath;
const forbiddenEntry = /(^|\/)(test|runtime|\.venv|venv|backups?)(\/|$)|secrets\.local|worker\.py|requirements\.txt/i;

function fail(message) {
  console.error(`LOCAL RELEASE FAILED: ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const executable = command === "npm" && npmCli ? process.execPath : command;
  const executableArgs = command === "npm" && npmCli ? [npmCli, ...args] : args;
  const result = spawnSync(executable, executableArgs, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    encoding: options.capture ? "utf8" : undefined,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    windowsHide: true,
  });
  if (result.error) fail(`${command} could not start: ${result.error.message}`);
  if (result.status !== 0 && !options.allowFailure) {
    const detail = options.capture ? `\n${result.stderr || result.stdout || ""}` : "";
    fail(`${command} ${args.join(" ")} exited ${result.status}.${detail}`);
  }
  return result;
}

function output(command, args, options = {}) {
  return run(command, args, { ...options, capture: true }).stdout.trim();
}

function parseArgs(argv) {
  const result = { publish: false, tests: true, tag: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--publish") result.publish = true;
    else if (value === "--verify-only") result.publish = false;
    else if (value === "--skip-tests") result.tests = false;
    else if (value === "--tag") result.tag = argv[++index] ?? "";
    else if (value.startsWith("--tag=")) result.tag = value.slice(6);
    else fail(`unknown argument ${value}`);
  }
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(result.tag)) {
    fail("pass an exact semantic version tag with --tag vX.Y.Z");
  }
  if (result.publish && !result.tests) fail("publishing may not skip the test matrix");
  return result;
}

function registryVersion(version) {
  const lookup = run("npm", ["view", `${packageName}@${version}`, "version", "--json"], {
    capture: true,
    allowFailure: true,
  });
  if (lookup.status === 0) return lookup.stdout.trim().replace(/^"|"$/g, "");
  const diagnostic = `${lookup.stdout}\n${lookup.stderr}`;
  if (/E404|is not in this registry/i.test(diagnostic)) return "";
  fail(`registry lookup failed unexpectedly: ${diagnostic.trim()}`);
}

const args = parseArgs(process.argv.slice(2));
const version = args.tag.slice(1);
const head = output("git", ["rev-parse", "HEAD"]);
const origin = output("git", ["rev-parse", "origin/main"]);
const tagType = output("git", ["cat-file", "-t", args.tag]);
const tagCommit = output("git", ["rev-list", "-n", "1", args.tag]);
const status = output("git", ["status", "--porcelain"]);
if (status) fail("the working tree must be clean");
if (tagType !== "tag") fail(`${args.tag} must be an annotated tag`);
if (run("git", ["merge-base", "--is-ancestor", tagCommit, origin], { capture: true, allowFailure: true }).status !== 0) {
  fail(`${args.tag} is not contained in origin/main`);
}
const tagPackage = JSON.parse(output("git", ["show", `${args.tag}:package.json`]));
if (tagPackage.name !== packageName || tagPackage.version !== version) {
  fail(`tag ${args.tag} does not match package ${packageName}@${version}`);
}
if (registryVersion(version)) fail(`${packageName}@${version} already exists and cannot be republished`);

const releaseRoot = mkdtempSync(join(tmpdir(), `${packageName}-${version}-`));
const sourceTar = join(releaseRoot, "source.tar");
const consumerRoot = join(releaseRoot, "consumer");
try {
  run("git", ["archive", "--format=tar", `--output=${sourceTar}`, args.tag]);
  run("tar", ["-xf", sourceTar, "-C", releaseRoot]);
  // git archive extracts directly into releaseRoot; move build operations there.
  const buildRoot = releaseRoot;
  run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: buildRoot });
  if (args.tests) run("npm", ["test"], { cwd: buildRoot });
  run("npm", ["run", "build"], { cwd: buildRoot });
  const packed = JSON.parse(output("npm", ["pack", "--json"], { cwd: buildRoot }))[0];
  const tarball = join(buildRoot, packed.filename);
  if (!existsSync(tarball)) fail("npm pack did not create the expected tarball");
  const forbidden = packed.files.map((entry) => entry.path).filter((path) => forbiddenEntry.test(path));
  if (forbidden.length) fail(`forbidden package entries: ${forbidden.join(", ")}`);
  const sha512 = createHash("sha512").update(readFileSync(tarball)).digest("hex");
  writeFileSync(`${tarball}.sha512`, `${sha512}  ${basename(tarball)}\n`, "utf8");

  run(process.execPath, ["--eval", "require('fs').mkdirSync(process.argv[1], { recursive: true })", consumerRoot]);
  run("npm", ["init", "-y"], { cwd: consumerRoot });
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], { cwd: consumerRoot });
  const generationDataRoot = join(releaseRoot, "consumer-generation-data");
  const probe = `
    import { pathToFileURL } from "node:url";
    import { join } from "node:path";
    const transportRoot = ${JSON.stringify(join(consumerRoot, "node_modules", packageName))};
    const generationModule = await import(${JSON.stringify(pathToFileURL(join(consumerRoot, "node_modules", packageName, "packages", "shared", "generation.js")).href)});
    const transport = await generationModule.runtimeAttestation(transportRoot, { role: "release-transport" });
    if (transport.directDependencyMatchesExpected !== true) {
      throw new Error("packed transport direct dependencies do not match package.json: " + JSON.stringify(transport.directDependencyMismatches));
    }
    const provisioned = await generationModule.ensurePackageGeneration(transportRoot, {
      env: { ...process.env, OPENCODE_TOOLINGS_PACKAGE_MODE: "installed", OPENCODE_TOOLINGS_GENERATIONS_DIR: ${JSON.stringify(join(generationDataRoot, "generations"))}, OPENCODE_TOOLINGS_DATA_DIR: ${JSON.stringify(generationDataRoot)} },
    });
    const validation = await generationModule.validateGeneration(provisioned.root, ${JSON.stringify(version)});
    if (!validation.valid) throw new Error("packed transport did not provision a valid immutable generation: " + validation.reason);
    const attestation = await generationModule.runtimeAttestation(provisioned.root, { role: "release-generation" });
    if (attestation.dependencyMatchesExpected !== true) throw new Error("provisioned generation dependency graph does not match the packaged attestation");
    if (attestation.sourceMatchesMarker !== true) throw new Error("provisioned generation source does not match its immutable marker");
    process.env.OPENCODE_TOOLINGS_MODE = "development";
    process.env.OPENCODE_TOOLINGS_DATA_DIR = ${JSON.stringify(join(generationDataRoot, "runtime"))};
    const module = await import(pathToFileURL(join(provisioned.root, "index.js")).href);
    const hooks = await module.default({});
    const names = Object.keys(hooks.tool ?? {}).sort();
    if (names.length !== ${expectedTools}) throw new Error("expected ${expectedTools} tools, got " + names.length);
    if (names.some((name) => name.includes("many"))) throw new Error("legacy tool ID in package: " + names.join(","));
    console.log(JSON.stringify({ tools: names.length, names, generationRoot: provisioned.root, transportDependencyExact: transport.dependencyMatchesExpected, generationDependencyExact: attestation.dependencyMatchesExpected }));
    await hooks.dispose?.();
  `;
  const probeResult = run("node", ["--input-type=module", "--eval", probe], { cwd: consumerRoot, capture: true });
  const probeData = JSON.parse(probeResult.stdout.trim().split(/\r?\n/).at(-1));
  run("node", ["--test", "test/tui-runtime-parity.test.mjs"], {
    cwd: buildRoot,
    env: { ...process.env, ALONIX_GENERATION: probeData.generationRoot, OPENCODE_TOOLINGS_DATA_DIR: join(releaseRoot, "tui-parity-runtime") },
  });

  console.log(JSON.stringify({
    mode: args.publish ? "publish" : "verify-only",
    package: `${packageName}@${version}`,
    tag: args.tag,
    tagCommit,
    currentHead: head,
    origin,
    tarball,
    sha512,
    npmIntegrity: packed.integrity,
    npmShasum: packed.shasum,
    files: packed.entryCount,
    packedBytes: packed.size,
    unpackedBytes: packed.unpackedSize,
  }, null, 2));

  if (!args.publish) {
    console.log("LOCAL RELEASE VERIFIED: no registry mutation was performed.");
    process.exit(0);
  }

  const publishEnv = { ...process.env, NPM_CONFIG_PROVENANCE: "false" };
  delete publishEnv.NODE_AUTH_TOKEN;
  delete publishEnv.NPM_TOKEN;
  delete publishEnv.NPM_CONFIG_OTP;
  console.log("npm will now request your configured passkey/security key through its native authentication flow.");
  run("npm", ["publish", tarball, "--access", "public", "--provenance=false"], { cwd: buildRoot, env: publishEnv });

  let published = "";
  for (let attempt = 0; attempt < 12 && !published; attempt += 1) {
    if (attempt) await new Promise((resolveDelay) => setTimeout(resolveDelay, 5000));
    published = registryVersion(version);
  }
  if (published !== version) fail(`registry did not expose ${packageName}@${version} after publication`);
  const registry = JSON.parse(output("npm", ["view", `${packageName}@${version}`, "dist", "--json"]));
  if (registry.integrity !== packed.integrity || registry.shasum !== packed.shasum) {
    fail("registry integrity does not match the locally verified tarball");
  }

  // Publication and live activation use the same control plane as development,
  // candidates, and background updates. No temporary consumer path or @latest
  // pointer is allowed to become an independent deployment authority.
  const generationModule = await import(pathToFileURL(join(buildRoot, "packages", "shared", "generation.js")).href);
  const deploymentModule = await import(pathToFileURL(join(buildRoot, "packages", "shared", "deployment.js")).href);
  const selfpatchModule = await import(pathToFileURL(join(buildRoot, "packages", "selfpatch", "lib", "pipeline.js")).href);
  const publishedGeneration = await generationModule.ensurePackageGeneration(buildRoot, { version, source: "registry", force: true });
  const reconciled = await deploymentModule.reconcileDeployment(publishedGeneration.root, {
    generation: publishedGeneration,
    reconcileHost: (deploymentRoot) => selfpatchModule.runSelfPatch(deploymentRoot, { toolchainRoot: buildRoot }),
  });
  if (!reconciled.status.ok) fail(`published deployment did not reconcile exactly: ${JSON.stringify(reconciled.status.checks)}`);
  console.log(`LOCAL RELEASE SUCCESS: ${packageName}@${version} is registry-verified and reconciled through ${reconciled.status.files.deployment}.`);
} finally {
  if (process.env.ALONIX_KEEP_RELEASE_TEMP !== "1") rmSync(releaseRoot, { recursive: true, force: true });
}
