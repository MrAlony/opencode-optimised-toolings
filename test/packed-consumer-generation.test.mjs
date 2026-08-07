import test from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const packageName = "opencode-optimised-toolings"

function npmExecutable() {
  const candidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(dirname(process.execPath)), "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter(Boolean)
  const cli = candidates.find((file) => existsSync(file))
  if (cli) return { executable: process.execPath, prefix: [cli] }
  return { executable: process.platform === "win32" ? "npm.cmd" : "npm", prefix: [] }
}

function runNpm(args, cwd) {
  const npm = npmExecutable()
  const result = spawnSync(npm.executable, [...npm.prefix, ...args], {
    cwd,
    env: { ...process.env, NODE_AUTH_TOKEN: "", NPM_TOKEN: "", npm_config_provenance: "false" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    timeout: 90_000,
  })
  assert.ifError(result.error)
  assert.equal(result.status, 0, `${npm.executable} ${args.join(" ")} failed\n${result.stdout ?? ""}\n${result.stderr ?? ""}`)
  return result.stdout
}

test("a normal packed transport provisions the exact locked immutable generation", { timeout: 180_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "alonix-packed-generation-"))
  try {
    const packRoot = join(directory, "pack")
    const consumerRoot = join(directory, "consumer")
    const generations = join(directory, "generations")
    mkdirSync(packRoot, { recursive: true })
    mkdirSync(consumerRoot, { recursive: true })
    const packed = JSON.parse(runNpm(["pack", "--json", "--pack-destination", packRoot], root))[0]
    const tarball = join(packRoot, packed.filename)
    assert.equal(existsSync(tarball), true)
    runNpm(["init", "-y"], consumerRoot)
    runNpm(["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], consumerRoot)

    const transportRoot = join(consumerRoot, "node_modules", packageName)
    const generationModule = await import(pathToFileURL(join(transportRoot, "packages", "shared", "generation.js")).href)
    const transport = await generationModule.runtimeAttestation(transportRoot, { role: "test-transport" })
    assert.equal(transport.directDependencyMatchesExpected, true)

    const env = {
      ...process.env,
      OPENCODE_TOOLINGS_PACKAGE_MODE: "installed",
      OPENCODE_TOOLINGS_GENERATIONS_DIR: generations,
      OPENCODE_TOOLINGS_DATA_DIR: join(directory, "runtime"),
    }
    const provisioned = await generationModule.ensurePackageGeneration(transportRoot, { env })
    const validation = await generationModule.validateGeneration(provisioned.root, packed.version)
    const locked = await generationModule.runtimeAttestation(provisioned.root, { role: "test-generation" })
    assert.equal(validation.valid, true)
    assert.equal(locked.dependencyMatchesExpected, true)
    assert.equal(locked.sourceMatchesMarker, true)
    assert.equal(provisioned.root.includes("node_modules"), false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
