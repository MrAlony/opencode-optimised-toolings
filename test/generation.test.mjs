import test from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { activatePackageGeneration, candidatePackageSpecs, deploymentRecordPath, directDependencyAttestation, ensurePackageGeneration, generationPackageRoot, liveRuntimeProcesses, publicPackageSpecs, resolveNpmCommand, runtimeAttestation, runtimeHealth, tuiCoordinationPath, validateGeneration, writeServerLifecycle, writeTuiLifecycle } from "../packages/shared/generation.js"
import { deploymentStatus, discoverConfiguredDeployment, reconcileDeployment } from "../packages/shared/deployment.js"

function createInstallation(root, version) {
  const packageRoot = join(root, "node_modules", "opencode-optimised-toolings")
  for (const directory of ["packages/tui", "packages/cbm/dist", "config"]) mkdirSync(join(packageRoot, directory), { recursive: true })
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "opencode-optimised-toolings", version }))
  writeFileSync(join(packageRoot, "npm-shrinkwrap.json"), JSON.stringify({ name: "opencode-optimised-toolings", version, lockfileVersion: 3, requires: true, packages: { "": { name: "opencode-optimised-toolings", version } } }))
  const graph = []
  writeFileSync(join(packageRoot, "config/runtime-dependencies.json"), JSON.stringify({ schemaVersion: 1, fingerprint: createHash("sha256").update(JSON.stringify(graph)).digest("hex"), graph }))
  writeFileSync(join(packageRoot, "index.js"), "export default async () => ({ tool: {} })\n")
  writeFileSync(join(packageRoot, "packages/tui/index.tsx"), "export default { id: 'fixture' }\n")
  writeFileSync(join(packageRoot, "packages/tui/package.json"), JSON.stringify({ name: "@sparkly/toolings-tui", version: "2.0.0", private: true, type: "module", main: "index.tsx" }))
  writeFileSync(join(packageRoot, "packages/cbm/dist/index.js"), "export default async () => ({ tool: {} })\n")
  writeFileSync(join(root, "package.json"), JSON.stringify({ private: true }))
  return packageRoot
}

test("a loaded npm installation becomes an immutable user-owned generation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alonix-generation-copy-"))
  try {
    const sourceInstall = join(directory, "source")
    const packageRoot = createInstallation(sourceInstall, "4.0.2")
    const env = { ...process.env, OPENCODE_TOOLINGS_PACKAGE_MODE: "installed", OPENCODE_TOOLINGS_GENERATIONS_DIR: join(directory, "generations") }
    const first = await ensurePackageGeneration(packageRoot, { env })
    const second = await ensurePackageGeneration(packageRoot, { env })
    assert.equal(first.created, true)
    assert.equal(second.created, false)
    assert.equal(first.root, generationPackageRoot("4.0.2", env, first.fingerprint))
    assert.equal((await validateGeneration(first.root, "4.0.2")).valid, true)
    assert.match(first.specs.server, /\/index\.js$/)
    assert.match(first.specs.tui, /\/packages\/tui\/index\.tsx$/)
    assert.equal(first.specs.tui.includes("/node_modules/"), false)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test("npm discovery uses a real Node executable when the host runtime is opencode.exe", () => {
  if (process.platform !== "win32") return
  const directory = mkdtempSync(join(tmpdir(), "alonix-generation-npm-runtime-"))
  try {
    const nodeRoot = join(directory, "nodejs")
    const npmCli = join(nodeRoot, "node_modules", "npm", "bin", "npm-cli.js")
    mkdirSync(join(nodeRoot, "node_modules", "npm", "bin"), { recursive: true })
    writeFileSync(join(nodeRoot, "node.exe"), "fixture")
    writeFileSync(npmCli, "fixture")
    const command = resolveNpmCommand({ PATH: nodeRoot, ProgramFiles: directory })
    assert.equal(command.executable, join(nodeRoot, "node.exe"))
    assert.equal(command.npmCli, npmCli)
    assert.deepEqual(command.args, [npmCli])
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test("concurrent generation requests share one provisioning flight", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alonix-generation-flight-"))
  try {
    const packageRoot = createInstallation(join(directory, "source"), "4.0.2")
    const env = { ...process.env, OPENCODE_TOOLINGS_PACKAGE_MODE: "installed", OPENCODE_TOOLINGS_GENERATIONS_DIR: join(directory, "generations") }
    let installs = 0
    const installDependencies = async () => { installs += 1; await new Promise((resolve) => setTimeout(resolve, 25)) }
    const [first, second, third] = await Promise.all([
      ensurePackageGeneration(packageRoot, { env, installDependencies }),
      ensurePackageGeneration(packageRoot, { env, installDependencies }),
      ensurePackageGeneration(packageRoot, { env, installDependencies }),
    ])
    assert.equal(installs, 1)
    assert.equal(first.root, second.root)
    assert.equal(second.root, third.root)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test("transport direct dependencies stay exact even when an unrelated transitive package floats", () => {
  const directory = mkdtempSync(join(tmpdir(), "alonix-generation-transport-"))
  try {
    const packageRoot = createInstallation(directory, "4.0.2")
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"))
    manifest.dependencies = { direct: "1.0.0" }
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify(manifest))
    const directRoot = join(directory, "node_modules", "direct")
    const transitiveRoot = join(directRoot, "node_modules", "floating")
    mkdirSync(transitiveRoot, { recursive: true })
    writeFileSync(join(directRoot, "package.json"), JSON.stringify({ name: "direct", version: "1.0.0", dependencies: { floating: "^1.0.0" } }))
    writeFileSync(join(transitiveRoot, "package.json"), JSON.stringify({ name: "floating", version: "1.9.0" }))
    const contract = directDependencyAttestation(packageRoot)
    assert.equal(contract.matchesExpected, true)
    assert.deepEqual(contract.mismatches, [])
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test("generation provisioning safely excludes a destination nested under the source installation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alonix-generation-nested-"))
  try {
    const packageRoot = createInstallation(directory, "4.0.2")
    const env = { ...process.env, OPENCODE_TOOLINGS_PACKAGE_MODE: "installed", OPENCODE_TOOLINGS_GENERATIONS_DIR: join(directory, "data") }
    const generation = await ensurePackageGeneration(packageRoot, { env })
    assert.equal(generation.valid, true)
    assert.equal(generation.created, true)
    assert.match(generation.root, /data[\\/]v4\.0\.2--[a-f0-9]{16}[\\/]opencode-optimised-toolings$/)
    assert.equal(generation.root.includes(`${join("node_modules", "opencode-optimised-toolings")}`), false)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test("custom dependency installers are still subject to the full locked graph attestation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alonix-generation-custom-install-"))
  try {
    const packageRoot = createInstallation(join(directory, "source"), "4.0.2")
    const env = { ...process.env, OPENCODE_TOOLINGS_PACKAGE_MODE: "installed", OPENCODE_TOOLINGS_GENERATIONS_DIR: join(directory, "generations") }
    await assert.rejects(
      () => ensurePackageGeneration(packageRoot, {
        env,
        installDependencies: async (stagedRoot) => {
          const graph = ["unexpected@1.0.0"]
          writeFileSync(join(stagedRoot, "config/runtime-dependencies.json"), JSON.stringify({ schemaVersion: 1, fingerprint: createHash("sha256").update(JSON.stringify(graph)).digest("hex"), graph }))
        },
      }),
      /dependency graph does not match/,
    )
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test("same semantic version with different package bytes receives a distinct generation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alonix-generation-fingerprint-"))
  try {
    const firstRoot = createInstallation(join(directory, "first"), "4.0.2")
    const secondRoot = createInstallation(join(directory, "second"), "4.0.2")
    writeFileSync(join(secondRoot, "index.js"), "export default async () => ({ tool: { changed: true } })\n")
    const env = { ...process.env, OPENCODE_TOOLINGS_PACKAGE_MODE: "installed", OPENCODE_TOOLINGS_GENERATIONS_DIR: join(directory, "generations") }
    const first = await ensurePackageGeneration(firstRoot, { env })
    const second = await ensurePackageGeneration(secondRoot, { env })
    assert.notEqual(first.fingerprint, second.fingerprint)
    assert.notEqual(first.root, second.root)
    assert.equal(first.version, second.version)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test("runtime attestations prove exact server and TUI generation parity", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alonix-runtime-attestation-"))
  try {
    const packageRoot = createInstallation(join(directory, "source"), "4.0.2")
    const env = { ...process.env, OPENCODE_TOOLINGS_PACKAGE_MODE: "installed", OPENCODE_TOOLINGS_GENERATIONS_DIR: join(directory, "generations"), OPENCODE_TOOLINGS_DATA_DIR: join(directory, "runtime") }
    const generation = await ensurePackageGeneration(packageRoot, { env })
    const server = await runtimeAttestation(generation.root, { role: "server" })
    const tui = await runtimeAttestation(generation.root, { role: "tui" })
    writeServerLifecycle(generation.root, "active", { ...server, stage: "complete" }, { env })
    writeTuiLifecycle(generation.root, "active", { ...tui, stage: "complete" }, { env })
    const unrelatedRoot = createInstallation(join(directory, "unrelated"), "9.9.9")
    const unrelated = await runtimeAttestation(unrelatedRoot, { role: "server" })
    writeServerLifecycle(unrelatedRoot, "active", { ...unrelated, stage: "complete" }, { env, file: join(env.OPENCODE_TOOLINGS_DATA_DIR, "server-activation-unrelated.json") })
    const health = runtimeHealth(env, generation.root)
    assert.equal(health.exact, true)
    assert.equal(health.reason, "exact-runtime-parity")
    assert.equal(health.server.sourceFingerprint, health.tui.sourceFingerprint)
    assert.equal(health.server.dependencyFingerprint, health.tui.dependencyFingerprint)
    assert.equal(health.server.root, generation.root)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test("activation switches server and TUI together and preserves unrelated config", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alonix-generation-activate-"))
  try {
    const install = join(directory, "source")
    const packageRoot = createInstallation(install, "4.0.2")
    const configDir = join(directory, "config")
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, "opencode.json"), JSON.stringify({ plugin: ["opencode-optimised-toolings@4.0.1", "personal"], provider: { keep: true } }, null, 2))
    writeFileSync(join(configDir, "tui.json"), JSON.stringify({ plugin: ["file:///old/packages/tui/index.tsx", "other-tui"], theme: "keep" }, null, 2))
    const env = { ...process.env, OPENCODE_TOOLINGS_PACKAGE_MODE: "installed", OPENCODE_TOOLINGS_GENERATIONS_DIR: join(directory, "generations") }
    const generation = await ensurePackageGeneration(packageRoot, { env })
    const result = await activatePackageGeneration(generation, { configDir })
    const server = JSON.parse(readFileSync(join(configDir, "opencode.json"), "utf8"))
    const tui = JSON.parse(readFileSync(join(configDir, "tui.json"), "utf8"))
    assert.equal(result.changed, true)
    assert.equal(server.plugin[0], generation.specs.server)
    assert.equal(tui.plugin[0], generation.specs.tui)
    assert.equal(server.plugin[1], "personal")
    assert.equal(server.provider.keep, true)
    assert.equal(tui.plugin[1], "file:///old/packages/tui/index.tsx")
    assert.equal(tui.plugin[2], "other-tui")
    assert.equal(tui.theme, "keep")
    assert.equal(result.backups.length, 4)
    const pointer = JSON.parse(readFileSync(tuiCoordinationPath(configDir), "utf8"))
    const deployment = JSON.parse(readFileSync(deploymentRecordPath(configDir), "utf8"))
    assert.equal(pointer.spec, generation.specs.tui)
    assert.equal(pointer.generation, generation.root)
    assert.equal(deployment.desired.root, generation.root)
    assert.equal(deployment.desired.serverSpec, generation.specs.server)
    assert.equal(deployment.desired.tuiSpec, generation.specs.tui)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test("candidate activation uses one immutable package-root declaration and no TUI entry", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alonix-generation-candidate-spec-"))
  try {
    const packageRoot = createInstallation(join(directory, "source"), "4.0.2")
    const configDir = join(directory, "config")
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, "opencode.json"), JSON.stringify({ plugin: ["opencode-optimised-toolings@4.0.1", "personal"] }, null, 2))
    writeFileSync(join(configDir, "tui.json"), JSON.stringify({ plugin: [
      "file:///old/opencode-optimised-toolings/packages/tui/index.tsx",
      "file:///C:/Users/test/AppData/Local/Temp/opencode-optimised-toolings-6.4.0-old123/packages/tui/index.tsx",
      "other",
    ] }, null, 2))
    const env = { ...process.env, OPENCODE_TOOLINGS_PACKAGE_MODE: "installed", OPENCODE_TOOLINGS_GENERATIONS_DIR: join(directory, "generations") }
    const generation = await ensurePackageGeneration(packageRoot, { env })
    const configSpecs = candidatePackageSpecs(generation.root)
    await activatePackageGeneration(generation, { configDir, configSpecs })
    const server = JSON.parse(readFileSync(join(configDir, "opencode.json"), "utf8"))
    const tui = JSON.parse(readFileSync(join(configDir, "tui.json"), "utf8"))
    const pointer = JSON.parse(readFileSync(tuiCoordinationPath(configDir), "utf8"))
    const deployment = JSON.parse(readFileSync(deploymentRecordPath(configDir), "utf8"))
    assert.equal(server.plugin[0], configSpecs.server)
    assert.match(server.plugin[0], /opencode-optimised-toolings$/)
    assert.equal(server.plugin[0].endsWith("/index.js"), false)
    assert.deepEqual(tui.plugin, ["other"])
    assert.equal(tui.plugin.some((entry) => String(entry).includes("opencode-optimised-toolings-6.4.0-old123")), false)
    assert.equal(pointer.spec, configSpecs.server)
    assert.equal(pointer.generation, generation.root)
    assert.equal(deployment.desired.serverSpec, configSpecs.server)
    assert.equal(deployment.desired.tuiSpec, configSpecs.server)
    assert.equal(deployment.desired.tuiConfigSpec, null)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test("installed activation keeps one public @latest declaration while internal identity remains immutable", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alonix-generation-public-spec-"))
  try {
    const packageRoot = createInstallation(join(directory, "source"), "4.0.2")
    const configDir = join(directory, "config")
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, "opencode.json"), JSON.stringify({ plugin: ["file:///old/generation/opencode-optimised-toolings/index.js", "personal"] }, null, 2))
    writeFileSync(join(configDir, "tui.json"), JSON.stringify({ plugin: ["file:///old/generation/opencode-optimised-toolings/packages/tui/index.tsx", "other"] }, null, 2))
    const env = { ...process.env, OPENCODE_TOOLINGS_PACKAGE_MODE: "installed", OPENCODE_TOOLINGS_GENERATIONS_DIR: join(directory, "generations") }
    const generation = await ensurePackageGeneration(packageRoot, { env })
    const configSpecs = publicPackageSpecs()
    await activatePackageGeneration(generation, { configDir, configSpecs })
    const server = JSON.parse(readFileSync(join(configDir, "opencode.json"), "utf8"))
    const tui = JSON.parse(readFileSync(join(configDir, "tui.json"), "utf8"))
    const pointer = JSON.parse(readFileSync(tuiCoordinationPath(configDir), "utf8"))
    const deployment = JSON.parse(readFileSync(deploymentRecordPath(configDir), "utf8"))
    assert.equal(server.plugin[0], "opencode-optimised-toolings@latest")
    assert.equal(tui.plugin.includes("opencode-optimised-toolings@latest"), false)
    assert.equal(tui.plugin.includes("file:///old/generation/opencode-optimised-toolings/packages/tui/index.tsx"), false)
    assert.equal(pointer.spec, "opencode-optimised-toolings@latest")
    assert.equal(pointer.generation, generation.root)
    assert.equal(deployment.desired.serverSpec, "opencode-optimised-toolings@latest")
    assert.equal(deployment.desired.tuiSpec, "opencode-optimised-toolings@latest")
    assert.equal(deployment.desired.tuiConfigSpec, null)
    assert.equal(deployment.desired.root, generation.root)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test("first-run adoption requires matching validated server and TUI roots", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alonix-deployment-adopt-"))
  try {
    const packageRoot = createInstallation(join(directory, "source"), "4.0.2")
    const configDir = join(directory, "config")
    mkdirSync(configDir, { recursive: true })
    const env = { ...process.env, OPENCODE_TOOLINGS_PACKAGE_MODE: "installed", OPENCODE_TOOLINGS_GENERATIONS_DIR: join(directory, "generations") }
    const generation = await ensurePackageGeneration(packageRoot, { env })
    writeFileSync(join(configDir, "opencode.json"), JSON.stringify({ plugin: [generation.specs.server] }, null, 2))
    writeFileSync(join(configDir, "tui.json"), JSON.stringify({ plugin: [generation.specs.tui] }, null, 2))
    const adopted = await discoverConfiguredDeployment({ configDir, env })
    assert.equal(adopted.valid, true)
    assert.equal(adopted.root, generation.root)
    writeFileSync(join(configDir, "tui.json"), JSON.stringify({ plugin: ["file:///different/opencode-optimised-toolings/packages/tui/index.tsx"] }, null, 2))
    const rejected = await discoverConfiguredDeployment({ configDir, env })
    assert.equal(rejected.valid, false)
    assert.equal(rejected.reason, "configured-server-tui-roots-do-not-match")
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test("host deployment identity includes the verified artifact manifest without artifact archaeology", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alonix-deployment-host-"))
  try {
    const packageRoot = createInstallation(join(directory, "source"), "4.0.2")
    const configDir = join(directory, "config")
    const runtime = join(directory, "runtime")
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, "opencode.json"), JSON.stringify({ plugin: [] }))
    writeFileSync(join(configDir, "tui.json"), JSON.stringify({ plugin: [] }))
    const env = { ...process.env, OPENCODE_TOOLINGS_PACKAGE_MODE: "installed", OPENCODE_TOOLINGS_GENERATIONS_DIR: join(directory, "generations"), OPENCODE_TOOLINGS_DATA_DIR: runtime }
    const generation = await ensurePackageGeneration(packageRoot, { env })
    await reconcileDeployment(generation.root, { configDir, env, generation })
    const patchedPath = join(runtime, "patched", "opencode-1.2.3.exe")
    mkdirSync(join(runtime, "patched"), { recursive: true })
    writeFileSync(`${patchedPath}.manifest.json`, JSON.stringify({ profileVersion: "1.2.3", manifestSha256: "manifest-sha", binarySha256: "binary-sha" }))
    const { writeHostDeployment } = await import("../packages/shared/deployment.js")
    await writeHostDeployment(generation.root, { version: "1.2.3", patchedPath, patchedSha256: "binary-sha", binaryPath: join(runtime, "opencode.exe") }, { configDir, env })
    const deployment = JSON.parse(readFileSync(deploymentRecordPath(configDir), "utf8"))
    assert.equal(deployment.desired.host.profile, "1.2.3")
    assert.equal(deployment.desired.host.manifestSha256, "manifest-sha")
    assert.equal(deployment.desired.host.expectedSha256, "binary-sha")
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test("live runtime diagnostics ignore dead receipts and report only alive stale plugin roots", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alonix-live-runtime-status-"))
  try {
    const packageRoot = createInstallation(join(directory, "source"), "4.0.2")
    const configDir = join(directory, "config")
    const runtime = join(directory, "runtime")
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, "opencode.json"), JSON.stringify({ plugin: [] }))
    writeFileSync(join(configDir, "tui.json"), JSON.stringify({ plugin: [] }))
    const env = { ...process.env, OPENCODE_TOOLINGS_PACKAGE_MODE: "installed", OPENCODE_TOOLINGS_GENERATIONS_DIR: join(directory, "generations"), OPENCODE_TOOLINGS_DATA_DIR: runtime }
    const generation = await ensurePackageGeneration(packageRoot, { env })
    await reconcileDeployment(generation.root, { configDir, env, generation, configSpecs: candidatePackageSpecs(generation.root) })
    const staleRoot = join(directory, "stale-generation", "opencode-optimised-toolings")
    const currentPid = process.pid
    const deadPid = 900719
    const processStartedAt = new Date(Date.now() - 1000).toISOString()
    writeServerLifecycle(staleRoot, "active", { processStartedAt, version: generation.version, sourceFingerprint: "stale" }, { env, file: join(runtime, `server-activation-${currentPid}.json`) })
    writeTuiLifecycle(staleRoot, "active", { processStartedAt, version: generation.version, sourceFingerprint: "stale", stage: "complete" }, { env, file: join(runtime, `tui-activation-${currentPid}.json`) })
    writeServerLifecycle(staleRoot, "active", { pid: deadPid, version: generation.version, sourceFingerprint: "dead-stale" }, { env, file: join(runtime, `server-activation-${deadPid}.json`) })

    const live = liveRuntimeProcesses(env, { pidAlive: (pid) => pid === currentPid })
    assert.equal(live.length, 1)
    assert.equal(live[0].pid, currentPid)
    const status = await deploymentStatus({ configDir, env, pidAlive: (pid) => pid === currentPid })
    const check = status.checks.find((item) => item.name === "live plugin generation")
    assert.equal(check?.ok, false)
    assert.match(check?.detail ?? "", new RegExp(`pid ${currentPid} loaded`))
    assert.doesNotMatch(check?.detail ?? "", new RegExp(String(deadPid)))
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test("deployment status validates public specs against hidden immutable identity", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alonix-deployment-public-status-"))
  try {
    const packageRoot = createInstallation(join(directory, "source"), "4.0.2")
    const configDir = join(directory, "config")
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, "opencode.json"), JSON.stringify({ plugin: [] }))
    writeFileSync(join(configDir, "tui.json"), JSON.stringify({ plugin: [] }))
    const env = { ...process.env, OPENCODE_TOOLINGS_PACKAGE_MODE: "installed", OPENCODE_TOOLINGS_GENERATIONS_DIR: join(directory, "generations"), OPENCODE_TOOLINGS_DATA_DIR: join(directory, "runtime") }
    const generation = await ensurePackageGeneration(packageRoot, { env })
    const reconcileHost = async () => {
      mkdirSync(env.OPENCODE_TOOLINGS_DATA_DIR, { recursive: true })
      writeFileSync(join(env.OPENCODE_TOOLINGS_DATA_DIR, "selfpatch-state.json"), JSON.stringify({
        status: "portable",
        version: "1.2.3",
        manifestSha256: "canonical-resolver-manifest",
      }))
    }
    const reconciled = await reconcileDeployment(generation.root, { configDir, env, generation, publicPackage: true, reconcileHost })
    assert.equal(reconciled.status.ok, true)
    assert.equal(reconciled.status.desired.root, generation.root)
    assert.equal(reconciled.status.desired.serverSpec, "opencode-optimised-toolings@latest")
    assert.equal(reconciled.status.desired.tuiSpec, "opencode-optimised-toolings@latest")
    assert.equal(reconciled.status.desired.tuiConfigSpec, null)
    assert.equal(reconciled.status.checks.find((check) => check.name === "runtime package authority")?.ok, true)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test("deployment status detects and unified reconcile repairs every derived pointer", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alonix-deployment-reconcile-"))
  try {
    const packageRoot = createInstallation(join(directory, "source"), "4.0.2")
    const configDir = join(directory, "config")
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, "opencode.json"), JSON.stringify({ plugin: ["wrong-server"] }, null, 2))
    writeFileSync(join(configDir, "tui.json"), JSON.stringify({ plugin: ["wrong-tui"] }, null, 2))
    writeFileSync(tuiCoordinationPath(configDir), JSON.stringify({ spec: "wrong-pointer" }, null, 2))
    const env = { ...process.env, OPENCODE_TOOLINGS_PACKAGE_MODE: "installed", OPENCODE_TOOLINGS_GENERATIONS_DIR: join(directory, "generations"), OPENCODE_TOOLINGS_DATA_DIR: join(directory, "runtime") }
    const generation = await ensurePackageGeneration(packageRoot, { env })
    const reconciled = await reconcileDeployment(generation.root, { configDir, env, generation })
    assert.equal(reconciled.status.checks.find((item) => item.name === "server config derived")?.ok, true)
    assert.equal(reconciled.status.checks.find((item) => item.name === "TUI config derived")?.ok, true)
    assert.equal(reconciled.status.checks.find((item) => item.name === "coordination pointer derived")?.ok, true)
    const status = await deploymentStatus({ configDir, env })
    assert.equal(status.desired.root, generation.root)
    assert.equal(status.checks.filter((item) => item.name !== "host runtime reconciled").every((item) => item.ok), true)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test("concurrent activation is serialized and converges on one server/TUI generation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alonix-generation-concurrent-activation-"))
  try {
    const packageRoot = createInstallation(join(directory, "source"), "4.0.2")
    const configDir = join(directory, "config")
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, "opencode.json"), JSON.stringify({ plugin: ["old-server"] }, null, 2))
    writeFileSync(join(configDir, "tui.json"), JSON.stringify({ plugin: ["old-tui"] }, null, 2))
    const env = { ...process.env, OPENCODE_TOOLINGS_PACKAGE_MODE: "installed", OPENCODE_TOOLINGS_GENERATIONS_DIR: join(directory, "generations") }
    const generation = await ensurePackageGeneration(packageRoot, { env })
    const results = await Promise.all(Array.from({ length: 8 }, () => activatePackageGeneration(generation, { configDir })))
    assert.equal(results.filter((item) => item.changed).length, 1)
    const server = JSON.parse(readFileSync(join(configDir, "opencode.json"), "utf8"))
    const tui = JSON.parse(readFileSync(join(configDir, "tui.json"), "utf8"))
    assert.equal(server.plugin[0], generation.specs.server)
    assert.equal(tui.plugin[0], generation.specs.tui)
    assert.equal(existsSync(join(configDir, "alonix", ".generation-activation.json")), false)
    assert.equal(existsSync(join(configDir, "alonix", ".generation-activation.lock")), false)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test("an interrupted split activation is rolled back before the next transaction", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alonix-generation-recover-"))
  try {
    const packageRoot = createInstallation(join(directory, "source"), "4.0.2")
    const configDir = join(directory, "config")
    const alonixDir = join(configDir, "alonix")
    const backupDir = join(alonixDir, "backups")
    mkdirSync(backupDir, { recursive: true })
    const serverFile = join(configDir, "opencode.json")
    const tuiFile = join(configDir, "tui.json")
    const serverBefore = JSON.stringify({ plugin: ["old-server"] }, null, 2)
    const tuiBefore = JSON.stringify({ plugin: ["old-tui"] }, null, 2)
    writeFileSync(serverFile, serverBefore)
    writeFileSync(tuiFile, JSON.stringify({ plugin: ["file:///partial/new-tui.tsx"] }, null, 2))
    const serverBackup = join(backupDir, "server.json")
    const tuiBackup = join(backupDir, "tui.json")
    writeFileSync(serverBackup, serverBefore)
    writeFileSync(tuiBackup, tuiBefore)
    writeFileSync(join(alonixDir, ".generation-activation.json"), JSON.stringify({
      version: 1,
      files: [
        { file: serverFile, backup: serverBackup, afterHash: "not-committed" },
        { file: tuiFile, backup: tuiBackup, afterHash: "not-committed" },
      ],
    }))
    const env = { ...process.env, OPENCODE_TOOLINGS_PACKAGE_MODE: "installed", OPENCODE_TOOLINGS_GENERATIONS_DIR: join(directory, "generations") }
    const generation = await ensurePackageGeneration(packageRoot, { env })
    await activatePackageGeneration(generation, { configDir })
    const server = JSON.parse(readFileSync(serverFile, "utf8"))
    const tui = JSON.parse(readFileSync(tuiFile, "utf8"))
    assert.equal(server.plugin[0], generation.specs.server)
    assert.equal(tui.plugin[0], generation.specs.tui)
    assert.equal(existsSync(join(alonixDir, ".generation-activation.json")), false)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test("an older process cannot downgrade a newer configured generation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alonix-generation-no-downgrade-"))
  try {
    const oldInstall = join(directory, "old-source")
    const newInstall = join(directory, "new-source")
    const oldRoot = createInstallation(oldInstall, "4.0.1")
    const newRoot = createInstallation(newInstall, "4.0.2")
    const configDir = join(directory, "config")
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, "opencode.json"), JSON.stringify({ plugin: [] }, null, 2))
    writeFileSync(join(configDir, "tui.json"), JSON.stringify({ plugin: [] }, null, 2))
    const env = { ...process.env, OPENCODE_TOOLINGS_PACKAGE_MODE: "installed", OPENCODE_TOOLINGS_GENERATIONS_DIR: join(directory, "generations") }
    const newer = await ensurePackageGeneration(newRoot, { env })
    const older = await ensurePackageGeneration(oldRoot, { env })
    await activatePackageGeneration(newer, { configDir })
    const beforeServer = readFileSync(join(configDir, "opencode.json"), "utf8")
    const beforeTui = readFileSync(join(configDir, "tui.json"), "utf8")
    const result = await activatePackageGeneration(older, { configDir })
    assert.equal(result.changed, false)
    assert.equal(result.skipped, "newer-generation-configured")
    assert.equal(result.configuredVersion, "4.0.2")
    assert.equal(readFileSync(join(configDir, "opencode.json"), "utf8"), beforeServer)
    assert.equal(readFileSync(join(configDir, "tui.json"), "utf8"), beforeTui)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test("BOM-prefixed JSON config is accepted and preserves its encoding marker", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alonix-generation-bom-"))
  try {
    const packageRoot = createInstallation(join(directory, "source"), "4.0.2")
    const configDir = join(directory, "config")
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, "opencode.json"), `\uFEFF${JSON.stringify({ plugin: ["old"] }, null, 2)}`)
    writeFileSync(join(configDir, "tui.json"), `\uFEFF${JSON.stringify({ plugin: ["old-tui"] }, null, 2)}`)
    const env = { ...process.env, OPENCODE_TOOLINGS_PACKAGE_MODE: "installed", OPENCODE_TOOLINGS_GENERATIONS_DIR: join(directory, "generations") }
    const generation = await ensurePackageGeneration(packageRoot, { env })
    await activatePackageGeneration(generation, { configDir })
    assert.equal(readFileSync(join(configDir, "opencode.json"), "utf8").startsWith("\uFEFF"), true)
    assert.equal(readFileSync(join(configDir, "tui.json"), "utf8").startsWith("\uFEFF"), true)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test("malformed companion config prevents activation without changing either file", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alonix-generation-malformed-"))
  try {
    const install = join(directory, "source")
    const packageRoot = createInstallation(install, "4.0.2")
    const configDir = join(directory, "config")
    mkdirSync(configDir, { recursive: true })
    const serverBefore = JSON.stringify({ plugin: ["old"] }, null, 2)
    writeFileSync(join(configDir, "opencode.json"), serverBefore)
    writeFileSync(join(configDir, "tui.json"), "{broken")
    const env = { ...process.env, OPENCODE_TOOLINGS_PACKAGE_MODE: "installed", OPENCODE_TOOLINGS_GENERATIONS_DIR: join(directory, "generations") }
    const generation = await ensurePackageGeneration(packageRoot, { env })
    await assert.rejects(() => activatePackageGeneration(generation, { configDir }), /not valid JSON/)
    assert.equal(readFileSync(join(configDir, "opencode.json"), "utf8"), serverBefore)
    assert.equal(readFileSync(join(configDir, "tui.json"), "utf8"), "{broken")
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
