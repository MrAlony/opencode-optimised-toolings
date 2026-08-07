import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, stat, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applyManagedSettings, readManagedSettings, settingsPaths } from "../lib/settings.js"

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "alonix-settings-"))
  const options = { home, instructionSource: join(home, "packaged-AGENTS.md") }
  const paths = settingsPaths(options)
  await mkdir(paths.configDir, { recursive: true })
  await writeFile(paths.configPath, `{
  // personal provider data must survive byte-for-byte as a subtree
  "provider": { "personal": { "apiKey": "keep-me" } },
  "plugin": ["personal-plugin", "file:///dev/opencode-optimised-toolings/index.js"],
  "permission": { "bash": "ask", "custom-tool": { "*": "deny" } },
  "instructions": ["personal.md"]
}\n`)
  await writeFile(paths.instructionSource, "# Managed instructions\n")
  await writeFile(paths.agentsPath, "# Personal instructions\n\nKeep this exact text.\n")
  return { home, paths, options }
}

test("settings round-trip preserves unrelated config and owns only explicit values", async () => {
  const { paths, options } = await fixture()
  const before = readManagedSettings(options)
  assert.equal(before.tools.bash, "ask")
  const result = applyManagedSettings({
    ...before,
    tools: { ...before.tools, bash: "deny", "alonix-read": "allow" },
    instructions: { enabled: true },
    dcp: { ...before.dcp, installed: true, minContextLimit: 60000, maxContextLimit: 120000 },
    web: { serper_api_key: "secret-value" },
  }, options)
  assert.equal(result.restartRequired, true)
  const config = await readFile(paths.configPath, "utf8")
  assert.match(config, /personal provider data must survive/)
  assert.match(config, /"apiKey": "keep-me"/)
  assert.match(config, /"custom-tool"\s*:\s*\{[\s\S]*?"\*"\s*:\s*"deny"[\s\S]*?\}/)
  assert.match(config, /"bash": "deny"/)
  assert.match(config, /"alonix-read": "allow"/)
  assert.match(config, /"personal.md"/)
  assert.doesNotMatch(config, /"alonix\/AGENTS.md"/, "the superseded instruction reference must be removed")
  assert.match(config, /@tarquinen\/opencode-dcp@latest/)
  const dcp = await readFile(paths.dcpPath, "utf8")
  assert.match(dcp, /"pruneNotification": "detailed"/)
  assert.match(dcp, /"turnProtection": \{[\s\S]*?"enabled": false[\s\S]*?"turns": 4/)
  assert.doesNotMatch(dcp, /"notifications"/, "Settings must never emit unsupported DCP keys")
  const agents = await readFile(paths.agentsPath, "utf8")
  assert.match(agents, /^# Personal instructions\n\nKeep this exact text\./)
  assert.match(agents, /<!-- ALONIX OPTIMIZED TOOL INSTRUCTIONS: START -->\n# Managed instructions\n<!-- ALONIX OPTIMIZED TOOL INSTRUCTIONS: END -->/)
  await assert.rejects(readFile(paths.instructionPath, "utf8"), /ENOENT/)
  const secrets = JSON.parse(await readFile(paths.secretsPath, "utf8"))
  assert.equal(secrets["alonix-web-search"].serper_api_key, "secret-value")
  assert.ok(result.backups.length >= 1)
  const repeated = applyManagedSettings({
    ...readManagedSettings(options),
    web: {},
  }, options)
  assert.equal(repeated.changed, false, "an identical duplicate save must be a strict no-op")
  assert.equal(repeated.restartRequired, false)
  assert.deepEqual(repeated.backups, [])
})

test("settings migrates legacy many permission IDs without changing their values", async () => {
  const { paths, options } = await fixture()
  await writeFile(paths.configPath, JSON.stringify({ permission: {
    "alonix-read-many": "deny",
    "alonix-edit-many": "ask",
    "alonix-web-fetch-many": "allow",
    "alonix-stealth-fetch-many": "deny",
    "alonix-stealth-search-many": "ask",
  } }, null, 2))
  const before = readManagedSettings(options)
  assert.equal(before.tools["alonix-read"], "deny")
  assert.equal(before.tools["alonix-edit"], "ask")
  applyManagedSettings({ ...before, web: {} }, options)
  const config = JSON.parse(await readFile(paths.configPath, "utf8"))
  assert.equal(config.permission["alonix-read"], "deny")
  assert.equal(config.permission["alonix-edit"], "ask")
  assert.equal(config.permission["alonix-web-fetch"], "allow")
  assert.equal(config.permission["alonix-stealth-fetch"], "deny")
  assert.equal(config.permission["alonix-stealth-search"], "ask")
  for (const legacy of ["alonix-read-many", "alonix-edit-many", "alonix-web-fetch-many", "alonix-stealth-fetch-many", "alonix-stealth-search-many"]) assert.equal(config.permission[legacy], undefined)
})

test("disabling owned integrations removes only owned artifacts", async () => {
  const { paths, options } = await fixture()
  let current = readManagedSettings(options)
  applyManagedSettings({ ...current, instructions: { enabled: true }, dcp: { ...current.dcp, installed: true }, web: {} }, options)
  current = readManagedSettings(options)
  applyManagedSettings({ ...current, instructions: { enabled: false }, dcp: { ...current.dcp, installed: false }, web: {} }, options)
  const config = await readFile(paths.configPath, "utf8")
  assert.match(config, /personal-plugin/)
  assert.match(config, /personal\.md/)
  assert.doesNotMatch(config, /alonix\/AGENTS\.md/)
  assert.doesNotMatch(config, /@tarquinen\/opencode-dcp/)
  assert.equal(await readFile(paths.agentsPath, "utf8"), "# Personal instructions\n\nKeep this exact text.\n")
  await assert.rejects(readFile(paths.instructionPath, "utf8"), /ENOENT/)
})

test("an existing full Alonix AGENTS file migrates to one removable block without duplication", async () => {
  const { paths, options } = await fixture()
  const managed = await readFile(paths.instructionSource, "utf8")
  await writeFile(paths.agentsPath, managed)
  const current = readManagedSettings(options)
  applyManagedSettings({ ...current, instructions: { enabled: true }, web: {} }, options)
  const enabled = await readFile(paths.agentsPath, "utf8")
  assert.equal(enabled.match(/ALONIX OPTIMIZED TOOL INSTRUCTIONS: START/g)?.length, 1)
  assert.equal(enabled.match(/# Managed instructions/g)?.length, 1)
  applyManagedSettings({ ...readManagedSettings(options), instructions: { enabled: false }, web: {} }, options)
  assert.equal(await readFile(paths.agentsPath, "utf8"), "", "disabling the migrated all-Alonix profile removes only its owned block")
})

test("DCP percentage thresholds and unrelated settings round-trip without conversion", async () => {
  const { paths, options } = await fixture()
  await writeFile(paths.dcpPath, `{
  "compress": { "minContextLimit": "50%", "maxContextLimit": "60%", "nudgeFrequency": 5 },
  "turnProtection": { "enabled": false, "turns": 4 },
  "customUnmanaged": { "keep": true }
}\n`)
  const before = readManagedSettings(options)
  assert.equal(before.dcp.minContextLimit, "50%")
  assert.equal(before.dcp.maxContextLimit, "60%")
  applyManagedSettings({ ...before, web: {} }, options)
  const text = await readFile(paths.dcpPath, "utf8")
  assert.match(text, /"minContextLimit": "50%"/)
  assert.match(text, /"maxContextLimit": "60%"/)
  assert.match(text, /"nudgeFrequency": 5/)
  assert.match(text, /"customUnmanaged"[\s\S]*?"keep": true/)
  assert.match(text, /"enabled": false/)
  assert.match(text, /"turns": 4/)
})

test("incomplete or duplicate AGENTS ownership markers fail closed", async () => {
  const { paths, options } = await fixture()
  await writeFile(paths.agentsPath, "personal\n<!-- ALONIX OPTIMIZED TOOL INSTRUCTIONS: START -->\nbroken\n")
  assert.throws(() => readManagedSettings(options), /incomplete or duplicate/)
  assert.match(await readFile(paths.agentsPath, "utf8"), /broken/)
})

test("disabling instructions does not create a missing AGENTS file", async () => {
  const { paths, options } = await fixture()
  const { rm } = await import("node:fs/promises")
  await rm(paths.agentsPath)
  const current = readManagedSettings(options)
  applyManagedSettings({ ...current, instructions: { enabled: false }, web: {} }, options)
  await assert.rejects(readFile(paths.agentsPath, "utf8"), /ENOENT/)
})

test("secrets are reported as presence only and never returned", async () => {
  const { paths, options } = await fixture()
  await mkdir(paths.alonixDir, { recursive: true })
  await writeFile(paths.secretsPath, JSON.stringify({ "alonix-web-search": { exa_api_key: "top-secret" } }))
  const state = readManagedSettings(options)
  assert.equal(state.web.exa_api_key, true)
  assert.doesNotMatch(JSON.stringify(state), /top-secret/)
})

test("malformed user JSONC fails closed before writing", async () => {
  const { paths, options } = await fixture()
  await writeFile(paths.configPath, "{ broken")
  assert.throws(() => applyManagedSettings({ tools: {} }, options), /not valid JSON\/JSONC/)
  assert.equal(await readFile(paths.configPath, "utf8"), "{ broken")
})

test("private secret file receives restrictive POSIX mode where supported", async () => {
  const { paths, options } = await fixture()
  const current = readManagedSettings(options)
  applyManagedSettings({ ...current, web: { tavily_api_key: "value" } }, options)
  if (process.platform !== "win32") assert.equal((await stat(paths.secretsPath)).mode & 0o777, 0o600)
})
