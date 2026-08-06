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
  return { home, paths, options }
}

test("settings round-trip preserves unrelated config and owns only explicit values", async () => {
  const { paths, options } = await fixture()
  const before = readManagedSettings(options)
  assert.equal(before.tools.bash, "ask")
  const result = applyManagedSettings({
    ...before,
    tools: { ...before.tools, bash: "deny", "alonix-read-many": "allow" },
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
  assert.match(config, /"alonix-read-many": "allow"/)
  assert.match(config, /"personal.md"/)
  assert.match(config, /"alonix\/AGENTS.md"/)
  assert.match(config, /@tarquinen\/opencode-dcp@latest/)
  const dcp = await readFile(paths.dcpPath, "utf8")
  assert.match(dcp, /"pruneNotification": "detailed"/)
  assert.match(dcp, /"turnProtection": \{[\s\S]*?"enabled": false[\s\S]*?"turns": 4/)
  assert.doesNotMatch(dcp, /"notifications"/, "Settings must never emit unsupported DCP keys")
  assert.equal(await readFile(paths.instructionPath, "utf8"), "# Managed instructions\n")
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
  await assert.rejects(readFile(paths.instructionPath, "utf8"), /ENOENT/)
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
