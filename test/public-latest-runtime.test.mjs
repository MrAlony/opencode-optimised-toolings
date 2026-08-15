import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const candidate = process.env.ALONIX_PUBLIC_LATEST_CANDIDATE
const hostBinary = process.env.ALONIX_PUBLIC_LATEST_HOST
const hostSource = process.env.ALONIX_PUBLIC_LATEST_HOST_SOURCE
const bun = process.env.ALONIX_PUBLIC_LATEST_BUN

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: options.timeout ?? 60_000,
    cwd: options.cwd,
    env: options.env,
  })
  assert.equal(result.error, undefined, result.error?.message)
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`)
  return result
}

function lifecycleRecords(runtime, prefix) {
  return readdirSync(runtime)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(path.join(runtime, name), "utf8")))
    .sort((left, right) => Date.parse(right.at) - Date.parse(left.at))
}

test("literal public @latest bypasses a poisoned mutable-tag cache for server and TUI", {
  skip: !candidate || !hostBinary || !hostSource || !bun,
  timeout: 90_000,
}, () => {
  const root = mkdtempSync(path.join(tmpdir(), "alonix-public-latest-e2e-"))
  const config = path.join(root, "config")
  const runtime = path.join(root, "runtime")
  const home = path.join(root, "home")
  const cache = path.join(root, "cache", "opencode")
  const probe = path.join(hostSource, "packages", "opencode", ".alonix-public-latest-probe.ts")
  try {
    mkdirSync(config, { recursive: true })
    mkdirSync(runtime, { recursive: true })
    mkdirSync(path.join(home, ".config", "opencode"), { recursive: true })
    const marker = JSON.parse(readFileSync(path.join(path.dirname(candidate), ".alonix-generation.json"), "utf8"))
    const pkg = JSON.parse(readFileSync(path.join(candidate, "package.json"), "utf8"))
    const empty = { $schema: "https://opencode.ai/config.json", plugin: [] }
    writeFileSync(path.join(home, ".config", "opencode", "opencode.json"), JSON.stringify(empty, null, 2))
    writeFileSync(path.join(home, ".config", "opencode", "tui.json"), JSON.stringify({ plugin: [] }, null, 2))
    writeFileSync(path.join(config, "opencode.json"), JSON.stringify({ $schema: "https://opencode.ai/config.json", plugin: ["opencode-optimised-toolings@latest"] }, null, 2))
    writeFileSync(path.join(config, "tui.json"), JSON.stringify({ plugin: [] }, null, 2))
    mkdirSync(path.join(config, "alonix"), { recursive: true })
    writeFileSync(path.join(config, "alonix", "deployment.json"), JSON.stringify({
      schemaVersion: 1,
      authority: "opencode-optimised-toolings-control-plane",
      desired: {
        mode: "immutable-generation",
        package: "opencode-optimised-toolings",
        version: pkg.version,
        root: path.resolve(candidate),
        fingerprint: marker.fingerprint,
        serverSpec: "opencode-optimised-toolings@latest",
        tuiSpec: "opencode-optimised-toolings@latest",
        tuiConfigSpec: null,
        host: { policy: "exact-compatible-profile", manifestSha256: "e2e-proof" },
      },
    }, null, 2))

    const stale = path.join(cache, "packages", "opencode-optimised-toolings@latest")
    const stalePackage = path.join(stale, "node_modules", "opencode-optimised-toolings")
    mkdirSync(path.join(stalePackage, "packages", "tui"), { recursive: true })
    writeFileSync(path.join(stale, "package.json"), JSON.stringify({ dependencies: { "opencode-optimised-toolings": "4.0.0" } }))
    writeFileSync(path.join(stalePackage, "package.json"), JSON.stringify({ name: "opencode-optimised-toolings", version: "4.0.0", exports: { "./server": "./index.js", "./tui": "./packages/tui/index.tsx" } }))
    writeFileSync(path.join(stalePackage, "index.js"), "throw new Error('STALE_4_0_0_SERVER_EXECUTED')\n")
    writeFileSync(path.join(stalePackage, "packages", "tui", "index.tsx"), "throw new Error('STALE_4_0_0_TUI_EXECUTED')\n")

    const env = {
      ...process.env,
      USERPROFILE: home,
      HOME: home,
      OPENCODE_CONFIG_DIR: config,
      OPENCODE_TOOLINGS_DATA_DIR: runtime,
      OPENCODE_CACHE: cache,
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      ALONIX_PROOF_CANDIDATE: path.resolve(candidate),
    }
    run(hostBinary, ["debug", "config"], { env, timeout: 60_000 })
    const server = lifecycleRecords(runtime, "server-activation-")[0]
    assert.ok(server, "server lifecycle receipt missing")
    assert.equal(path.resolve(server.root), path.resolve(candidate))
    assert.equal(server.sourceFingerprint, marker.fingerprint)
    assert.equal(server.sourceMatchesMarker, true)
    assert.equal(server.stage, "complete")

    writeFileSync(probe, `import path from "path"\nimport { TuiConfig } from "./src/config/tui"\nimport { PluginLoader } from "./src/plugin/loader"\nconst candidate = path.resolve(process.env.ALONIX_PROOF_CANDIDATE ?? "")\nconst origins = await TuiConfig.pluginOrigins()\nconst origin = origins.find((item) => (Array.isArray(item.spec) ? item.spec[0] : item.spec) === "opencode-optimised-toolings@latest")\nif (!origin) throw new Error(\`literal @latest origin missing: \${JSON.stringify(origins)}\`)\nconst result = await PluginLoader.resolve({ spec: "opencode-optimised-toolings@latest", options: undefined, deprecated: false }, "tui")\nif (!result.ok) throw new Error(\`TUI resolution failed: \${JSON.stringify(result)}\`)\nif (path.resolve(result.value.target) !== candidate) throw new Error(\`TUI target \${result.value.target} != \${candidate}\`)\nif (!result.value.entry.replaceAll("\\\\", "/").endsWith("/packages/tui/bootstrap.js")) throw new Error(\`unexpected TUI export \${result.value.entry}\`)\nconsole.log(JSON.stringify({ target: result.value.target, entry: result.value.entry }))\nprocess.exit(0)\n`)
    run(bun, ["run", path.basename(probe)], { cwd: path.dirname(probe), env, timeout: 30_000 })

    const serverConfig = JSON.parse(readFileSync(path.join(config, "opencode.json"), "utf8"))
    const tuiConfig = JSON.parse(readFileSync(path.join(config, "tui.json"), "utf8"))
    assert.deepEqual(serverConfig.plugin, ["opencode-optimised-toolings@latest"])
    assert.deepEqual(tuiConfig.plugin, [])
  } finally {
    rmSync(probe, { force: true })
    rmSync(root, { recursive: true, force: true })
  }
})
