import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensureTuiCompanion, tuiCompanionSpec } from "../lib/tui-registration.js"

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
