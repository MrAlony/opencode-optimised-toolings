import test from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensureTuiCompanion, tuiCompanionSpec } from "../lib/tui-registration.js"

function developmentFixture() {
  const container = mkdtempSync(join(tmpdir(), "alonix-tui-dev-"))
  const root = join(container, "opencode-optimised-toolings")
  const configDirectory = join(container, "user-config")
  for (const directory of ["packages/tui", "packages/cbm/dist", "config"]) mkdirSync(join(root, directory), { recursive: true })
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "opencode-optimised-toolings", version: "4.0.2", files: ["index.js", "packages/tui", "packages/cbm/dist", "config"] }))
  writeFileSync(join(root, "index.js"), "export default async () => ({ tool: {} })\n")
  writeFileSync(join(root, "packages/tui/index.tsx"), "export default { id: 'fixture' }\n")
  writeFileSync(join(root, "packages/tui/package.json"), JSON.stringify({ name: "@sparkly/toolings-tui", version: "2.0.0", private: true, type: "module", main: "index.tsx" }))
  writeFileSync(join(root, "packages/cbm/dist/index.js"), "export default async () => ({ tool: {} })\n")
  const graph = []
  writeFileSync(join(root, "config/runtime-dependencies.json"), JSON.stringify({ schemaVersion: 1, fingerprint: createHash("sha256").update(JSON.stringify(graph)).digest("hex"), graph }))
  return { root, container, configDirectory, configPath: join(configDirectory, "tui.json") }
}

function installedFixture(directory, name, version) {
  const installation = join(directory, name)
  const root = join(installation, "node_modules", "opencode-optimised-toolings")
  for (const path of ["packages/tui", "packages/cbm/dist", "config"]) mkdirSync(join(root, path), { recursive: true })
  writeFileSync(join(installation, "package.json"), JSON.stringify({ private: true }))
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "opencode-optimised-toolings", version }))
  writeFileSync(join(root, "npm-shrinkwrap.json"), JSON.stringify({ name: "opencode-optimised-toolings", version, lockfileVersion: 3, requires: true, packages: { "": { name: "opencode-optimised-toolings", version } } }))
  const graph = []
  writeFileSync(join(root, "config/runtime-dependencies.json"), JSON.stringify({ schemaVersion: 1, fingerprint: createHash("sha256").update(JSON.stringify(graph)).digest("hex"), graph }))
  writeFileSync(join(root, "index.js"), "export default async () => ({ tool: {} })\n")
  writeFileSync(join(root, "packages/tui/index.tsx"), "export default { id: 'fixture' }\n")
  writeFileSync(join(root, "packages/tui/package.json"), JSON.stringify({ name: "@sparkly/toolings-tui", version: "2.0.0", private: true, type: "module", main: "index.tsx" }))
  writeFileSync(join(root, "packages/cbm/dist/index.js"), "export default async () => ({ tool: {} })\n")
  return root
}

test("development checkout registration creates TUI config and is idempotent", async () => {
  const f = developmentFixture()
  try {
    const first = await ensureTuiCompanion(f.root, { configDirectory: f.configDirectory })
    const second = await ensureTuiCompanion(f.root, { configDirectory: f.configDirectory })
    const config = JSON.parse(readFileSync(f.configPath, "utf8"))
    assert.equal(first.changed, true)
    assert.equal(second.changed, false)
    assert.deepEqual(config.plugin, [tuiCompanionSpec(f.root)])
    const server = JSON.parse(readFileSync(join(f.configDirectory, "opencode.json"), "utf8"))
    const pointer = JSON.parse(readFileSync(join(f.configDirectory, ".sparkly-toolings-tui.json"), "utf8"))
    const deployment = JSON.parse(readFileSync(join(f.configDirectory, "alonix", "deployment.json"), "utf8"))
    assert.match(server.plugin[0], /index\.js$/)
    assert.equal(pointer.spec, tuiCompanionSpec(f.root))
    assert.equal(deployment.desired.mode, "development")
  } finally { rmSync(f.container, { recursive: true, force: true }) }
})

test("development registration preserves unrelated TUI settings and replaces only its managed path", async () => {
  const f = developmentFixture()
  try {
    mkdirSync(f.configDirectory, { recursive: true })
    writeFileSync(f.configPath, JSON.stringify({ theme: "custom", plugin: ["file:///old/opencode-optimised-toolings/packages/tui/index.tsx", ["unrelated", { keep: true }]] }))
    const result = await ensureTuiCompanion(f.root, { configDirectory: f.configDirectory })
    const config = JSON.parse(readFileSync(f.configPath, "utf8"))
    assert.equal(result.changed, true)
    assert.equal(config.theme, "custom")
    assert.deepEqual(config.plugin, [result.spec, ["unrelated", { keep: true }]])
  } finally { rmSync(f.container, { recursive: true, force: true }) }
})

test("unchanged development registration does not rewrite its canonical deployment on every project instance", async () => {
  const f = developmentFixture()
  try {
    const first = await ensureTuiCompanion(f.root, { configDirectory: f.configDirectory })
    const marker = join(f.configDirectory, "alonix", "deployment.json")
    const before = readFileSync(marker, "utf8")
    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = await ensureTuiCompanion(f.root, { configDirectory: f.configDirectory })
    assert.equal(first.changed, true)
    assert.equal(second.changed, false)
    assert.equal(readFileSync(marker, "utf8"), before)
  } finally { rmSync(f.container, { recursive: true, force: true }) }
})

test("installed registration provisions one generation and switches both configs to direct files", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alonix-tui-installed-"))
  const previousMode = process.env.OPENCODE_TOOLINGS_PACKAGE_MODE
  const previousGenerations = process.env.OPENCODE_TOOLINGS_GENERATIONS_DIR
  try {
    process.env.OPENCODE_TOOLINGS_PACKAGE_MODE = "installed"
    process.env.OPENCODE_TOOLINGS_GENERATIONS_DIR = join(directory, "generations")
    const root = installedFixture(directory, "source", "4.0.2")
    const configDirectory = join(directory, "config")
    mkdirSync(configDirectory, { recursive: true })
    writeFileSync(join(configDirectory, "opencode.json"), JSON.stringify({ plugin: ["opencode-optimised-toolings@4.0.1", "personal"] }, null, 2))
    writeFileSync(join(configDirectory, "tui.json"), JSON.stringify({ plugin: ["opencode-optimised-toolings@4.0.1", "other-tui"], theme: "keep" }, null, 2))
    const result = await ensureTuiCompanion(root, { configDirectory })
    const server = JSON.parse(readFileSync(join(configDirectory, "opencode.json"), "utf8"))
    const tui = JSON.parse(readFileSync(join(configDirectory, "tui.json"), "utf8"))
    assert.match(result.spec, /generations\/v4\.0\.2--[a-f0-9]{16}\/opencode-optimised-toolings\/packages\/tui\/index\.tsx$/)
    assert.match(server.plugin[0], /generations\/v4\.0\.2--[a-f0-9]{16}\/opencode-optimised-toolings\/index\.js$/)
    assert.equal(result.spec.includes("/node_modules/"), false)
    assert.equal(tui.plugin[0], result.spec)
    assert.equal(server.plugin[1], "personal")
    assert.equal(tui.plugin[1], "other-tui")
    assert.equal(tui.theme, "keep")
    const pointer = JSON.parse(readFileSync(join(configDirectory, ".sparkly-toolings-tui.json"), "utf8"))
    const deployment = JSON.parse(readFileSync(join(configDirectory, "alonix", "deployment.json"), "utf8"))
    assert.equal(pointer.spec, result.spec)
    assert.equal(deployment.desired.tuiSpec, result.spec)
    assert.equal(deployment.desired.serverSpec, server.plugin[0])
  } finally {
    if (previousMode === undefined) delete process.env.OPENCODE_TOOLINGS_PACKAGE_MODE
    else process.env.OPENCODE_TOOLINGS_PACKAGE_MODE = previousMode
    if (previousGenerations === undefined) delete process.env.OPENCODE_TOOLINGS_GENERATIONS_DIR
    else process.env.OPENCODE_TOOLINGS_GENERATIONS_DIR = previousGenerations
    rmSync(directory, { recursive: true, force: true })
  }
})

test("an older installed process cannot downgrade a newer direct generation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alonix-tui-no-downgrade-"))
  const previousMode = process.env.OPENCODE_TOOLINGS_PACKAGE_MODE
  const previousGenerations = process.env.OPENCODE_TOOLINGS_GENERATIONS_DIR
  try {
    process.env.OPENCODE_TOOLINGS_PACKAGE_MODE = "installed"
    process.env.OPENCODE_TOOLINGS_GENERATIONS_DIR = join(directory, "generations")
    const oldRoot = installedFixture(directory, "old", "4.0.1")
    const newRoot = installedFixture(directory, "new", "4.0.2")
    const configDirectory = join(directory, "config")
    mkdirSync(configDirectory, { recursive: true })
    writeFileSync(join(configDirectory, "opencode.json"), JSON.stringify({ plugin: [] }))
    writeFileSync(join(configDirectory, "tui.json"), JSON.stringify({ plugin: [] }))
    await ensureTuiCompanion(newRoot, { configDirectory })
    const before = readFileSync(join(configDirectory, "tui.json"), "utf8")
    const older = await ensureTuiCompanion(oldRoot, { configDirectory })
    assert.equal(older.changed, false)
    assert.equal(readFileSync(join(configDirectory, "tui.json"), "utf8"), before)
  } finally {
    if (previousMode === undefined) delete process.env.OPENCODE_TOOLINGS_PACKAGE_MODE
    else process.env.OPENCODE_TOOLINGS_PACKAGE_MODE = previousMode
    if (previousGenerations === undefined) delete process.env.OPENCODE_TOOLINGS_GENERATIONS_DIR
    else process.env.OPENCODE_TOOLINGS_GENERATIONS_DIR = previousGenerations
    rmSync(directory, { recursive: true, force: true })
  }
})

test("malformed installed TUI config fails closed before activation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alonix-tui-malformed-"))
  const previousMode = process.env.OPENCODE_TOOLINGS_PACKAGE_MODE
  const previousGenerations = process.env.OPENCODE_TOOLINGS_GENERATIONS_DIR
  try {
    process.env.OPENCODE_TOOLINGS_PACKAGE_MODE = "installed"
    process.env.OPENCODE_TOOLINGS_GENERATIONS_DIR = join(directory, "generations")
    const root = installedFixture(directory, "source", "4.0.2")
    const configDirectory = join(directory, "config")
    mkdirSync(configDirectory, { recursive: true })
    writeFileSync(join(configDirectory, "opencode.json"), JSON.stringify({ plugin: ["old"] }))
    writeFileSync(join(configDirectory, "tui.json"), "{broken")
    await assert.rejects(() => ensureTuiCompanion(root, { configDirectory }), /not valid JSON/)
    assert.equal(readFileSync(join(configDirectory, "tui.json"), "utf8"), "{broken")
  } finally {
    if (previousMode === undefined) delete process.env.OPENCODE_TOOLINGS_PACKAGE_MODE
    else process.env.OPENCODE_TOOLINGS_PACKAGE_MODE = previousMode
    if (previousGenerations === undefined) delete process.env.OPENCODE_TOOLINGS_GENERATIONS_DIR
    else process.env.OPENCODE_TOOLINGS_GENERATIONS_DIR = previousGenerations
    rmSync(directory, { recursive: true, force: true })
  }
})
