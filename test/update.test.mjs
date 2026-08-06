import test from "node:test"
import assert from "node:assert/strict"
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
  return { root, packageRoot, configDir, configPath: join(configDir, "opencode.json"), tuiPath: join(configDir, "tui.json") }
}

test("semantic version comparison handles stable patch updates", () => {
  assert.equal(compareVersions("4.0.1", "4.0.0"), 1)
  assert.equal(compareVersions("4.0.1", "4.0.1"), 0)
  assert.equal(compareVersions("4.0.0", "4.0.1"), -1)
  assert.equal(compareVersions("4.0.1", "4.0.1-beta.1"), 1)
})

test("installed update stages exact server and TUI specs for the next restart", async () => {
  const f = fixture()
  try {
    writeFileSync(f.configPath, JSON.stringify({ plugin: ["opencode-optimised-toolings@latest", ["personal", { keep: true }]], provider: { private: { untouched: true } } }, null, 2))
    writeFileSync(f.tuiPath, JSON.stringify({ theme: "custom", plugin: [["opencode-optimised-toolings@4.0.1", { motion: false }], "other-tui"] }, null, 2))
    const result = await stagePackageUpdate(f.packageRoot, { configDir: f.configDir, latestVersion: "4.0.2" })
    assert.equal(result.changed, true)
    assert.equal(result.restartRequired, true)
    assert.equal(result.targetSpec, "opencode-optimised-toolings@4.0.2")
    const config = JSON.parse(readFileSync(f.configPath, "utf8"))
    const tui = JSON.parse(readFileSync(f.tuiPath, "utf8"))
    assert.equal(config.plugin[0], "opencode-optimised-toolings@4.0.2")
    assert.deepEqual(config.plugin[1], ["personal", { keep: true }])
    assert.equal(config.provider.private.untouched, true)
    assert.deepEqual(tui.plugin[0], ["opencode-optimised-toolings@4.0.2", { motion: false }])
    assert.equal(tui.plugin[1], "other-tui")
    assert.equal(tui.theme, "custom")
    assert.equal(result.files.length, 2)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test("same or older registry versions do not rewrite config", async () => {
  const f = fixture()
  try {
    const source = JSON.stringify({ plugin: ["opencode-optimised-toolings@4.0.1"] }, null, 2)
    writeFileSync(f.configPath, source)
    const same = await stagePackageUpdate(f.packageRoot, { configDir: f.configDir, latestVersion: "4.0.1" })
    const older = await stagePackageUpdate(f.packageRoot, { configDir: f.configDir, latestVersion: "3.9.9" })
    assert.equal(same.changed, false)
    assert.equal(older.changed, false)
    assert.equal(readFileSync(f.configPath, "utf8"), source)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test("malformed user config fails closed without partial writes", async () => {
  const f = fixture()
  try {
    writeFileSync(f.configPath, "{broken")
    writeFileSync(f.tuiPath, JSON.stringify({ plugin: ["opencode-optimised-toolings@4.0.1"] }))
    await assert.rejects(() => stagePackageUpdate(f.packageRoot, { configDir: f.configDir, latestVersion: "4.0.2" }), /not valid JSON/)
    assert.equal(readFileSync(f.configPath, "utf8"), "{broken")
    assert.match(readFileSync(f.tuiPath, "utf8"), /4\.0\.1/)
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
