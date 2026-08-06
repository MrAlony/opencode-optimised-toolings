import test from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { compareVersions, stagePackageUpdate } from "../packages/bootstrap/update.js"

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "alonix-update-"))
  const packageRoot = join(root, "node_modules", "opencode-optimised-toolings")
  const configDir = join(root, "config")
  mkdirSync(packageRoot, { recursive: true })
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "opencode-optimised-toolings", version: "4.0.1" }))
  return { root, packageRoot, configDir, configPath: join(configDir, "opencode.json"), tuiPath: join(configDir, "tui.json"), generations: join(root, "generations") }
}

async function installFixture(version, staging) {
  const packageRoot = join(staging, "node_modules", "opencode-optimised-toolings")
  for (const directory of ["packages/tui", "packages/cbm/dist", "config"]) mkdirSync(join(packageRoot, directory), { recursive: true })
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "opencode-optimised-toolings", version }))
  writeFileSync(join(packageRoot, "npm-shrinkwrap.json"), JSON.stringify({ name: "opencode-optimised-toolings", version, lockfileVersion: 3, requires: true, packages: { "": { name: "opencode-optimised-toolings", version } } }))
  const graph = []
  writeFileSync(join(packageRoot, "config/runtime-dependencies.json"), JSON.stringify({ schemaVersion: 1, fingerprint: createHash("sha256").update(JSON.stringify(graph)).digest("hex"), graph }))
  writeFileSync(join(packageRoot, "index.js"), "export default async () => ({ tool: {} })\n")
  writeFileSync(join(packageRoot, "packages/tui/index.tsx"), "export default { id: 'fixture' }\n")
  writeFileSync(join(packageRoot, "packages/tui/package.json"), JSON.stringify({ name: "@sparkly/toolings-tui", version: "2.0.0", private: true, type: "module", main: "index.tsx" }))
  writeFileSync(join(packageRoot, "packages/cbm/dist/index.js"), "export default async () => ({ tool: {} })\n")
}

test("semantic version comparison handles stable patch updates", () => {
  assert.equal(compareVersions("4.0.1", "4.0.0"), 1)
  assert.equal(compareVersions("4.0.1", "4.0.1"), 0)
  assert.equal(compareVersions("4.0.0", "4.0.1"), -1)
})

test("installed update provisions the complete next generation before switching both direct entries", async () => {
  const f = fixture()
  try {
    writeFileSync(f.configPath, JSON.stringify({ plugin: ["opencode-optimised-toolings@4.0.1", "personal"], provider: { private: { untouched: true } } }, null, 2))
    writeFileSync(f.tuiPath, JSON.stringify({ theme: "custom", plugin: ["old-tui", "other-tui"] }, null, 2))
    const result = await stagePackageUpdate(f.packageRoot, { configDir: f.configDir, latestVersion: "4.0.2", force: true, env: { ...process.env, OPENCODE_TOOLINGS_GENERATIONS_DIR: f.generations }, install: installFixture })
    const config = JSON.parse(readFileSync(f.configPath, "utf8"))
    const tui = JSON.parse(readFileSync(f.tuiPath, "utf8"))
    assert.equal(result.changed, true)
    assert.match(config.plugin[0], /generations\/v4\.0\.2--[a-f0-9]{16}\/opencode-optimised-toolings\/index\.js$/)
    assert.match(tui.plugin[0], /generations\/v4\.0\.2--[a-f0-9]{16}\/opencode-optimised-toolings\/packages\/tui\/index\.tsx$/)
    assert.equal(tui.plugin[0].includes("/node_modules/"), false)
    assert.equal(config.plugin[1], "personal")
    assert.equal(config.provider.private.untouched, true)
    assert.equal(tui.plugin[1], "old-tui")
    assert.equal(tui.plugin[2], "other-tui")
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test("same or older registry versions do not rewrite config", async () => {
  const f = fixture()
  try {
    const source = JSON.stringify({ plugin: ["opencode-optimised-toolings@4.0.1"] }, null, 2)
    writeFileSync(f.configPath, source)
    const same = await stagePackageUpdate(f.packageRoot, { configDir: f.configDir, latestVersion: "4.0.1", force: true })
    const older = await stagePackageUpdate(f.packageRoot, { configDir: f.configDir, latestVersion: "3.9.9", force: true })
    assert.equal(same.changed, false)
    assert.equal(older.changed, false)
    assert.equal(readFileSync(f.configPath, "utf8"), source)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test("malformed user config fails before provisioning and without partial writes", async () => {
  const f = fixture()
  let installed = false
  try {
    writeFileSync(f.configPath, "{broken")
    writeFileSync(f.tuiPath, JSON.stringify({ plugin: ["old"] }))
    await assert.rejects(() => stagePackageUpdate(f.packageRoot, { configDir: f.configDir, latestVersion: "4.0.2", force: true, install: async () => { installed = true } }), /not valid JSON/)
    assert.equal(installed, false)
    assert.equal(readFileSync(f.configPath, "utf8"), "{broken")
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test("development checkout never stages package updates", async () => {
  const root = mkdtempSync(join(tmpdir(), "alonix-update-dev-"))
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "4.0.1" }))
    const result = await stagePackageUpdate(root, { latestVersion: "4.0.2" })
    assert.equal(result.changed, false)
    assert.equal(result.skipped, "development-checkout")
  } finally { rmSync(root, { recursive: true, force: true }) }
})
