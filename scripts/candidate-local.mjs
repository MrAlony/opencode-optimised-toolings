#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"
import { packageFingerprint } from "../packages/shared/generation.js"
import { runSelfPatch } from "../packages/selfpatch/lib/pipeline.js"

const root = resolve(fileURLToPath(new URL("..", import.meta.url)))
const packageName = "opencode-optimised-toolings"
const npmCli = process.env.npm_execpath

function fail(message) {
  console.error(`LOCAL CANDIDATE FAILED: ${message}`)
  process.exit(1)
}

function run(command, args, options = {}) {
  const executable = command === "npm" && npmCli ? process.execPath : command
  const commandArgs = command === "npm" && npmCli ? [npmCli, ...args] : args
  const result = spawnSync(executable, commandArgs, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    encoding: options.capture ? "utf8" : undefined,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    windowsHide: true,
    timeout: options.timeout ?? 180_000,
  })
  if (result.error) fail(`${command} could not start: ${result.error.message}`)
  if (result.status !== 0) {
    const detail = options.capture ? `\n${result.stderr || result.stdout || ""}` : ""
    fail(`${command} ${args.join(" ")} exited ${result.status}.${detail}`)
  }
  return result
}

function output(command, args, options = {}) {
  return run(command, args, { ...options, capture: true }).stdout.trim()
}

const status = run("git", ["status", "--porcelain"], { capture: true }).stdout.replace(/\r?\n$/, "")
if (!status) fail("candidate mode requires locally validated working-tree changes; the checkout is clean")
const changed = status.split(/\r?\n/).filter(Boolean)
console.log(`Preparing candidate from ${changed.length} working-tree change(s).`)

const temporary = mkdtempSync(join(tmpdir(), "alonix-local-candidate-"))
const packRoot = join(temporary, "pack")
const consumerRoot = join(temporary, "consumer")
const runtimeRoot = join(temporary, "runtime")
try {
  run(process.execPath, ["--eval", "require('fs').mkdirSync(process.argv[1], { recursive: true })", packRoot])
  run(process.execPath, ["--eval", "require('fs').mkdirSync(process.argv[1], { recursive: true })", consumerRoot])
  run("npm", ["run", "build"], { cwd: root })
  run("node", ["--test", "packages/tui/test/browse.test.mjs", "packages/tui/test/clock-contract.test.mjs"], { cwd: root })
  const packed = JSON.parse(output("npm", ["pack", "--json", "--pack-destination", packRoot], { cwd: root }))[0]
  const tarball = join(packRoot, packed.filename)
  run("npm", ["init", "-y"], { cwd: consumerRoot })
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], { cwd: consumerRoot })

  const transportRoot = join(consumerRoot, "node_modules", packageName)
  const generationModule = await import(pathToFileURL(join(transportRoot, "packages", "shared", "generation.js")).href)
  const env = {
    ...process.env,
    OPENCODE_TOOLINGS_PACKAGE_MODE: "installed",
    OPENCODE_TOOLINGS_DATA_DIR: process.env.OPENCODE_TOOLINGS_DATA_DIR,
  }
  const generation = await generationModule.ensurePackageGeneration(transportRoot, { env })
  const [checkoutFingerprint, transportFingerprint, candidateFingerprint] = await Promise.all([
    packageFingerprint(root),
    generationModule.packageFingerprint(transportRoot),
    generationModule.packageFingerprint(generation.root),
  ])
  if (checkoutFingerprint !== transportFingerprint || checkoutFingerprint !== candidateFingerprint) {
    fail(`source parity mismatch: checkout=${checkoutFingerprint} transport=${transportFingerprint} candidate=${candidateFingerprint}`)
  }
  const validation = await generationModule.validateGeneration(generation.root, packed.version)
  if (!validation.valid) fail(`candidate generation is invalid: ${validation.reason}`)
  const attestation = await generationModule.runtimeAttestation(generation.root, { role: "local-candidate" })
  if (attestation.sourceMatchesMarker !== true || attestation.dependencyMatchesExpected !== true) {
    fail("candidate attestation is not exact")
  }

  run("node", ["--test", "test/tui-runtime-parity.test.mjs"], {
    cwd: root,
    env: { ...process.env, ALONIX_GENERATION: generation.root, OPENCODE_TOOLINGS_DATA_DIR: runtimeRoot },
  })

  const deploymentModule = await import(pathToFileURL(join(transportRoot, "packages", "shared", "deployment.js")).href)
  // Candidate source/dependency parity is proven above. Host construction still
  // executes through the checkout's validated build environment because the
  // clean runtime-only transport intentionally excludes Bun/dev dependencies.
  const reconciled = await deploymentModule.reconcileDeployment(generation.root, {
    env,
    generation,
    reconcileHost: (deploymentRoot) => runSelfPatch(deploymentRoot, { toolchainRoot: root }),
  })
  const activation = reconciled.activation
  if (!reconciled.status.ok) fail(`candidate deployment control plane is inconsistent: ${JSON.stringify(reconciled.status.checks)}`)
  const summary = {
    candidate: generation.root,
    version: generation.version,
    fingerprint: candidateFingerprint,
    dependencyFingerprint: attestation.dependencyFingerprint,
    checkoutParity: true,
    interactionParity: true,
    activated: activation.changed,
    backups: activation.backups ?? [],
    changedFiles: changed.map((line) => line.slice(3)),
  }
  console.log(JSON.stringify(summary, null, 2))
  console.log("LOCAL CANDIDATE READY: fully quit and restart OpenCode to validate the immutable candidate.")
} finally {
  if (process.env.ALONIX_KEEP_CANDIDATE_TEMP !== "1") rmSync(temporary, { recursive: true, force: true })
}
