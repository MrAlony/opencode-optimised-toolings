import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applyRuntimeDefaults, migrateInstalledConfig, PACKAGE_SPEC } from "../packages/bootstrap/index.js"
import { installedPackageSpec, runtimeRootForPackage } from "../packages/shared/paths.js"
import plugin from "../index.js"

test("root aggregator preserves config hooks and registers every tool family", async () => {
  const previousMode = process.env.OPENCODE_TOOLINGS_PACKAGE_MODE
  const configDir = mkdtempSync(join(tmpdir(), "alonix-zero-touch-config-"))
  try {
    process.env.OPENCODE_TOOLINGS_PACKAGE_MODE = "development"
    process.env.OPENCODE_CONFIG_DIR = configDir
    const hooks = await plugin({})
    assert.equal(typeof hooks.config, "function")
    const config = {}
    await hooks.config(config)
    assert.equal(config.permission["alonix-read"], "allow")
    assert.equal(config.permission["alonix-background-process"], "deny")
    assert.equal(config.instructions, undefined)
    assert.ok(config.skills.paths.some((value) => /packages[\\/]cbm$/.test(value)))
    for (const tool of ["alonix-read", "alonix-shell", "alonix-index-context", "alonix-web-search", "alonix-stealth-status", "alonix-toolings"]) {
      assert.ok(hooks.tool[tool], `missing ${tool}`)
    }
    await hooks.dispose?.()
  } finally {
    if (previousMode === undefined) delete process.env.OPENCODE_TOOLINGS_PACKAGE_MODE
    else process.env.OPENCODE_TOOLINGS_PACKAGE_MODE = previousMode
    delete process.env.OPENCODE_CONFIG_DIR
    rmSync(configDir, { recursive: true, force: true })
  }
})

test("installed package specs pin their own exact version to escape sticky latest caches", () => {
  const root = mkdtempSync(join(tmpdir(), "alonix-exact-spec-"))
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "opencode-optimised-toolings", version: "4.0.1" }))
    assert.equal(installedPackageSpec(root), "opencode-optimised-toolings@4.0.1")
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("installed migration removes only Alonix checkout references", () => {
  const root = mkdtempSync(join(tmpdir(), "alonix-zero-touch-migrate-"))
  try {
    const configDir = join(root, "user-config")
    mkdirSync(configDir, { recursive: true })
    const configPath = join(configDir, "opencode.json")
    writeFileSync(configPath, JSON.stringify({
      plugin: ["personal-plugin", "file:///C:/dev/opencode-optimised-toolings/index.js", "@tarquinen/opencode-dcp@latest"],
      skills: { paths: ["C:/dev/opencode-optimised-toolings/packages/cbm", "C:/personal/skill"] },
      instructions: ["C:/dev/opencode-optimised-toolings/config/AGENTS.md", "personal.md"],
      provider: { personal: { apiKey: "untouched" } },
    }, null, 2))
    writeFileSync(join(configDir, "AGENTS.md"), "# Personal guidance\n")
    mkdirSync(join(root, "config"), { recursive: true })
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "opencode-optimised-toolings", version: "4.0.1" }))
    writeFileSync(join(root, "config", "AGENTS.md"), "# Alonix guidance\n")
    const result = migrateInstalledConfig(root, { configDir, force: true })
    assert.equal(result.changed, true)
    const config = JSON.parse(readFileSync(configPath, "utf8"))
    assert.deepEqual(config.plugin, ["opencode-optimised-toolings@4.0.1", "personal-plugin", "@tarquinen/opencode-dcp@latest"])
    assert.deepEqual(config.skills.paths, ["C:/personal/skill"])
    assert.deepEqual(config.instructions, ["personal.md"])
    assert.equal(config.provider.personal.apiKey, "untouched")
    const agents = readFileSync(join(configDir, "AGENTS.md"), "utf8")
    assert.match(agents, /# Personal guidance/)
    assert.match(agents, /ALONIX OPTIMIZED TOOL INSTRUCTIONS: START/)
    assert.match(agents, /# Alonix guidance/)
    assert.ok(result.backupPath)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("installed migration honors the persisted instructions opt-out", () => {
  const root = mkdtempSync(join(tmpdir(), "alonix-zero-touch-optout-"))
  try {
    const configDir = join(root, "user-config")
    mkdirSync(join(root, "config"), { recursive: true })
    mkdirSync(join(configDir, "alonix"), { recursive: true })
    writeFileSync(join(root, "config", "AGENTS.md"), "# Alonix guidance\n")
    writeFileSync(join(configDir, "opencode.json"), JSON.stringify({ plugin: [PACKAGE_SPEC] }))
    writeFileSync(join(configDir, "AGENTS.md"), "# Personal only\n")
    writeFileSync(join(configDir, "alonix", "instructions.disabled"), "disabled\n")
    migrateInstalledConfig(root, { configDir, force: true })
    assert.equal(readFileSync(join(configDir, "AGENTS.md"), "utf8"), "# Personal only\n")
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("installed mutable runtime never lives under node_modules", () => {
  const previousMode = process.env.OPENCODE_TOOLINGS_PACKAGE_MODE
  const previousData = process.env.OPENCODE_TOOLINGS_DATA_DIR
  try {
    process.env.OPENCODE_TOOLINGS_PACKAGE_MODE = "installed"
    process.env.OPENCODE_TOOLINGS_DATA_DIR = join(tmpdir(), "alonix-owned-runtime")
    const value = runtimeRootForPackage("C:/npm/cache/node_modules/opencode-optimised-toolings")
    assert.equal(value, process.env.OPENCODE_TOOLINGS_DATA_DIR)
    assert.doesNotMatch(value, /node_modules/i)
  } finally {
    if (previousMode === undefined) delete process.env.OPENCODE_TOOLINGS_PACKAGE_MODE
    else process.env.OPENCODE_TOOLINGS_PACKAGE_MODE = previousMode
    if (previousData === undefined) delete process.env.OPENCODE_TOOLINGS_DATA_DIR
    else process.env.OPENCODE_TOOLINGS_DATA_DIR = previousData
  }
})

test("runtime defaults never overwrite explicit user permission choices", () => {
  const config = { permission: { "alonix-read": "deny" }, instructions: ["personal.md"], skills: { paths: ["personal-skill"] } }
  applyRuntimeDefaults(config, "C:/installed/package")
  assert.equal(config.permission["alonix-read"], "deny")
  assert.ok(config.instructions.includes("personal.md"))
  assert.ok(config.skills.paths.includes("personal-skill"))
})

test("legacy many permission IDs migrate once without changing their policy", () => {
  const config = { permission: {
    "alonix-read-many": "deny",
    "alonix-edit-many": "ask",
    "alonix-web-fetch-many": "allow",
    "alonix-stealth-fetch-many": "deny",
    "alonix-stealth-search-many": "ask",
  } }
  applyRuntimeDefaults(config, "C:/installed/package")
  assert.equal(config.permission["alonix-read"], "deny")
  assert.equal(config.permission["alonix-edit"], "ask")
  assert.equal(config.permission["alonix-web-fetch"], "allow")
  assert.equal(config.permission["alonix-stealth-fetch"], "deny")
  assert.equal(config.permission["alonix-stealth-search"], "ask")
  for (const legacy of ["alonix-read-many", "alonix-edit-many", "alonix-web-fetch-many", "alonix-stealth-fetch-many", "alonix-stealth-search-many"]) assert.equal(config.permission[legacy], undefined)
})
