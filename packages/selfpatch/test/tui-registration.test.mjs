import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensureTuiCompanion, tuiCompanionSpec } from "../lib/tui-registration.js"
import { PACKAGE_SPEC } from "../../shared/paths.js"

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "alonix-toolings-tui-registration-"))
  const configDirectory = join(root, "config")
  return { root, configDirectory, configPath: join(configDirectory, "tui.json") }
}

test("root plugin registration creates the TUI config and is idempotent", async () => {
  const f = fixture()
  try {
    const first = await ensureTuiCompanion(f.root, { configDirectory: f.configDirectory })
    const second = await ensureTuiCompanion(f.root, { configDirectory: f.configDirectory })
    const config = JSON.parse(readFileSync(f.configPath, "utf8"))
    assert.equal(first.changed, true)
    assert.equal(first.restartRequired, true)
    assert.equal(second.changed, false)
    assert.deepEqual(config.plugin, [tuiCompanionSpec(f.root)])
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test("registration canonicalizes equivalent companion file URLs without duplicate activation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "toolings-tui-canonical-"))
  try {
    const root = join(directory, "repo")
    const configDirectory = join(directory, "config")
    const configPath = join(configDirectory, "tui.json")
    await import("node:fs/promises").then(({ mkdir }) => mkdir(configDirectory, { recursive: true }))
    const canonical = tuiCompanionSpec(root)
    const alternate = canonical.replace("file:///", "file://")
    writeFileSync(
      configPath,
      JSON.stringify({ $schema: "https://opencode.ai/tui.json", plugin: [alternate, canonical, "unrelated"] }),
      "utf8"
    )

    const result = await ensureTuiCompanion(root, { configDirectory })
    const config = JSON.parse(readFileSync(configPath, "utf8"))
    assert.equal(result.changed, true)
    assert.deepEqual(config.plugin, [canonical, "unrelated"])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("registration preserves unrelated TUI settings and tuple plugins", async () => {
  const f = fixture()
  try {
    await import("node:fs/promises").then(({ mkdir }) => mkdir(f.configDirectory, { recursive: true }))
    writeFileSync(f.configPath, JSON.stringify({ theme: "custom", scroll_speed: 7, plugin: [["unrelated", { enabled: true }]] }))
    await ensureTuiCompanion(f.root, { configDirectory: f.configDirectory })
    const config = JSON.parse(readFileSync(f.configPath, "utf8"))
    assert.equal(config.theme, "custom")
    assert.equal(config.scroll_speed, 7)
    assert.deepEqual(config.plugin[0], ["unrelated", { enabled: true }])
    assert.equal(config.plugin[1], tuiCompanionSpec(f.root))
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test("installed package registration uses the npm identity and removes checkout URLs", async () => {
  const f = fixture()
  const previousMode = process.env.OPENCODE_TOOLINGS_PACKAGE_MODE
  try {
    process.env.OPENCODE_TOOLINGS_PACKAGE_MODE = "installed"
    await import("node:fs/promises").then(({ mkdir }) => mkdir(f.configDirectory, { recursive: true }))
    writeFileSync(join(f.root, "package.json"), JSON.stringify({ name: "opencode-optimised-toolings", version: "4.0.1" }))
    const checkout = "file:///C:/dev/opencode-optimised-toolings/packages/tui/index.tsx"
    writeFileSync(f.configPath, JSON.stringify({ plugin: [checkout, "unrelated"] }))
    const result = await ensureTuiCompanion(f.root, { configDirectory: f.configDirectory })
    const config = JSON.parse(readFileSync(f.configPath, "utf8"))
    assert.equal(result.spec, "opencode-optimised-toolings@4.0.1")
    assert.deepEqual(config.plugin, ["unrelated", "opencode-optimised-toolings@4.0.1"])
  } finally {
    if (previousMode === undefined) delete process.env.OPENCODE_TOOLINGS_PACKAGE_MODE
    else process.env.OPENCODE_TOOLINGS_PACKAGE_MODE = previousMode
    rmSync(f.root, { recursive: true, force: true })
  }
})

test("registration replaces only its previously managed URL after the repository moves", async () => {
  const f = fixture()
  try {
    const firstRoot = join(f.root, "first")
    const movedRoot = join(f.root, "moved")
    await ensureTuiCompanion(firstRoot, { configDirectory: f.configDirectory })
    const moved = await ensureTuiCompanion(movedRoot, { configDirectory: f.configDirectory })
    const config = JSON.parse(readFileSync(f.configPath, "utf8"))
    assert.equal(moved.changed, true)
    assert.equal(moved.replaced, tuiCompanionSpec(firstRoot))
    assert.deepEqual(config.plugin, [tuiCompanionSpec(movedRoot)])
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test("registration refuses malformed or structurally unsafe TUI config", async () => {
  const f = fixture()
  try {
    await import("node:fs/promises").then(({ mkdir }) => mkdir(f.configDirectory, { recursive: true }))
    writeFileSync(f.configPath, "{broken")
    await assert.rejects(() => ensureTuiCompanion(f.root, { configDirectory: f.configDirectory }), /is invalid/)
    assert.equal(readFileSync(f.configPath, "utf8"), "{broken")
    writeFileSync(f.configPath, JSON.stringify({ plugin: "not-an-array" }))
    await assert.rejects(() => ensureTuiCompanion(f.root, { configDirectory: f.configDirectory }), /non-array plugin field/)
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})
