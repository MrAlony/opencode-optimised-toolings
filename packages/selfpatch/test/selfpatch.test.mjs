import test from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { defaultState, readState, sanitizeStoredState, sha256File, stateSummary, writeState } from "../lib/state.js"
import {
  applyManifest,
  manifestCompatible,
  manifestSha256,
  patchFileContent,
  resolvePatchProfile,
  resolveBun,
  sourceReady,
} from "../lib/pipeline.js"
import { detectBinary, isDevRuntime, resolveOnPath, versionOf } from "../lib/detect.js"
import { SelfPatchPlugin } from "../index.js"
import { manifest as patchManifest } from "../patches/1.18.13/manifest.mjs"
import { manifest as patchManifest11815 } from "../patches/1.18.15/manifest.mjs"

test("alonix-toolings tool registration exposes a callable execute", async () => {
  const previous = process.env.OPENCODE_CONFIG_DIR
  const configRoot = mkdtempSync(join(tmpdir(), "alonix-toolings-plugin-config-"))
  process.env.OPENCODE_CONFIG_DIR = configRoot
  const plugin = await SelfPatchPlugin()
  try {
    assert.equal(typeof plugin.tool["alonix-toolings"], "object")
    assert.equal(typeof plugin.tool["alonix-toolings"].execute, "function")
    assert.equal(typeof plugin.tool["alonix-toolings"].invoke, "undefined")
    assert.equal(typeof plugin.tool["alonix-toolings"].inputSchema, "object")
  } finally {
    await plugin.dispose?.()
    if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR
    else process.env.OPENCODE_CONFIG_DIR = previous
    rmSync(configRoot, { recursive: true, force: true })
  }
})

function sha256Of(text) {
  return createHash("sha256").update(text).digest("hex")
}

test("a dev host never masks a real OpenCode binary", () => {
  // process.execPath is node while these tests run, which previously made
  // detection report dev-mode and the UI claim self-patching was "not
  // applicable" even on a working installation. A real binary on PATH must win.
  const previous = process.env.OPENCODE_TOOLINGS_BIN
  try {
    delete process.env.OPENCODE_TOOLINGS_BIN
    const detected = detectBinary()
    if (detected && !detected.devMode) {
      assert.ok(!isDevRuntime(detected.path), "a non-dev result must not point at node/bun")
      assert.match(detected.version ?? "", /^\d+\.\d+\.\d+$/)
    } else if (detected) {
      // Only acceptable when no OpenCode binary exists on this machine.
      assert.equal(detected.devMode, true)
      assert.ok(isDevRuntime(detected.path))
    }

    // An explicit override still takes precedence and is reported honestly.
    process.env.OPENCODE_TOOLINGS_BIN = process.execPath
    const overridden = detectBinary()
    assert.ok(overridden, "an explicit dev override must still be reported")
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_TOOLINGS_BIN
    else process.env.OPENCODE_TOOLINGS_BIN = previous
  }
})

test("dev-runtime classification covers node, bun, and deno hosts", () => {
  for (const host of ["node", "node.exe", "bun", "bun.exe", "deno", "deno.exe"]) {
    assert.equal(isDevRuntime(`C:/tools/${host}`), true, `${host} must be a dev runtime`)
  }
  for (const real of ["opencode", "opencode.exe", "/usr/local/bin/opencode"]) {
    assert.equal(isDevRuntime(real), false, `${real} must not be a dev runtime`)
  }
})

test("stale detector errors expire instead of surviving across launches", () => {
  const stale = sanitizeStoredState({
    status: "error",
    binaryPath: null,
    lastError: "ENOENT: no such file or directory, open 'opencode'",
    updatedAt: new Date().toISOString(),
  })
  assert.equal(stale.status, "idle")
  assert.equal(stale.lastError, null)
  assert.equal(stale.binaryPath, null)
  assert.match(stale.stepLabel, /Refreshing/)
})

test("state defaults merge and atomic persistence", async () => {
  const root = mkdtempSync(join(tmpdir(), "alonix-toolings-state-"))
  try {
    const initial = await readState(root)
    assert.equal(initial.status, "idle")
    assert.equal(initial.progressPercent, 0)
    await writeState(root, { status: "building", progressPercent: 40, stepLabel: "Rebuilding" })
    const loaded = await readState(root)
    assert.equal(loaded.status, "building")
    assert.equal(loaded.progressPercent, 40)
    assert.equal(loaded.stepLabel, "Rebuilding")
    assert.ok(loaded.updatedAt)
    assert.ok(stateSummary(loaded).includes("OpenCode version: unknown"))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("sha256File streams a stable fingerprint", async () => {
  const root = mkdtempSync(join(tmpdir(), "alonix-toolings-hash-"))
  try {
    const file = join(root, "payload.bin")
    const body = `${"a".repeat(2 * 1024 * 1024)}tail`
    writeFileSync(file, body)
    assert.equal(await sha256File(file), sha256Of(body))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("patchFileContent enforces exact occurrence counts and recognizes completed steps", async () => {
  const root = mkdtempSync(join(tmpdir(), "alonix-toolings-patch-"))
  try {
    const file = join(root, "a.txt")
    writeFileSync(file, "one one two\n")
    const replacement = [{ name: "double replace", search: "one", replace: "1", count: 2 }]
    const out = await patchFileContent(file, replacement)
    assert.equal(out, "1 1 two\n")
    writeFileSync(file, out)
    assert.equal(await patchFileContent(file, replacement), out, "an already-applied step must be an exact no-op")

    // Real manifests insert declarations immediately before an anchor, so the
    // replacement body can still contain the original search text.
    writeFileSync(file, "types\nTuiDispose\n")
    const overlapping = [{ search: "TuiDispose", replace: "types\nTuiDispose" }]
    assert.equal(await patchFileContent(file, overlapping), "types\nTuiDispose\n")

    await assert.rejects(
      () => patchFileContent(file, [{ name: "bad count", search: "missing", replace: "also-missing", count: 3 }]),
      /found original=0, replacement=0/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("applyManifest validates everything before writing anything", async () => {
  const root = mkdtempSync(join(tmpdir(), "alonix-toolings-manifest-"))
  try {
    const src = join(root, "src")
    mkdirSync(src, { recursive: true })
    const existing = join(src, "existing.txt")
    writeFileSync(existing, "alpha beta\n")
    const manifest = {
      version: "test",
      create: [{ path: "new.txt", content: "created\n" }],
      files: [
        { path: "existing.txt", beforeSha256: sha256Of("alpha beta\n"), replacements: [{ name: "swap", search: "beta", replace: "gamma" }] },
      ],
    }
    await applyManifest(src, manifest)
    assert.match(readFileSync(existing, "utf8"), /alpha gamma/)
    const failing = {
      version: "test",
      create: [{ path: "other-new.txt", content: "changed\n" }],
      files: [{ path: "existing.txt", beforeSha256: sha256Of("totally different"), replacements: [{ name: "swap", search: "missing", replace: "also-missing" }] }],
    }
    await assert.rejects(() => applyManifest(src, failing), /fingerprint mismatch/)
    assert.equal(existsSync(join(src, "other-new.txt")), false)
    assert.match(readFileSync(existing, "utf8"), /alpha gamma/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("applyManifest is idempotent after marker loss or an interrupted run", async () => {
  const root = mkdtempSync(join(tmpdir(), "alonix-toolings-idempotent-"))
  try {
    const original = "before alpha beta after\n"
    const src = join(root, "src")
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, "existing.txt"), original)
    const manifest = {
      version: "test",
      create: [{ path: "created.txt", content: "registry\n" }],
      files: [{
        path: "existing.txt",
        beforeSha256: sha256Of(original),
        replacements: [
          { name: "first", search: "alpha", replace: "ALPHA" },
          { name: "second", search: "beta", replace: "BETA" },
        ],
      }],
    }

    await applyManifest(src, manifest)
    const once = readFileSync(join(src, "existing.txt"), "utf8")
    await applyManifest(src, manifest)
    assert.equal(readFileSync(join(src, "existing.txt"), "utf8"), once)
    assert.equal(readFileSync(join(src, "created.txt"), "utf8"), "registry\n")

    // A mixed file body is not a valid recovery state: file writes are staged
    // and complete, so it indicates truncation or foreign modification.
    writeFileSync(join(src, "existing.txt"), "before ALPHA beta after\n")
    await assert.rejects(() => applyManifest(src, manifest), /neither pristine nor the exact patched result/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("applyManifest rejects conflicting created or patched content", async () => {
  const root = mkdtempSync(join(tmpdir(), "alonix-toolings-conflict-"))
  try {
    const src = join(root, "src")
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, "created.txt"), "foreign\n")
    writeFileSync(join(src, "existing.txt"), "unrelated\n")
    const manifest = {
      create: [{ path: "created.txt", content: "expected\n" }],
      files: [{ path: "existing.txt", beforeSha256: sha256Of("alpha\n"), replacements: [{ search: "alpha", replace: "beta" }] }],
    }
    await assert.rejects(() => applyManifest(src, manifest), /different content/)
    assert.equal(readFileSync(join(src, "created.txt"), "utf8"), "foreign\n")
    assert.equal(readFileSync(join(src, "existing.txt"), "utf8"), "unrelated\n")

    writeFileSync(join(src, "created.txt"), "expected\n")
    await assert.rejects(() => applyManifest(src, manifest), /foreign changes are present|neither pristine nor the exact patched result/)
    assert.equal(readFileSync(join(src, "existing.txt"), "utf8"), "unrelated\n")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("manifestSha256 is deterministic", async () => {
  const manifest = { version: "x", create: [] }
  assert.equal(await manifestSha256(manifest), await manifestSha256(manifest))
  assert.notEqual(await manifestSha256(manifest), await manifestSha256({ ...manifest, version: "y" }))
})

test("source-compatible OpenCode updates reuse a verified capability profile", async () => {
  const root = mkdtempSync(join(tmpdir(), "alonix-toolings-compatible-version-"))
  try {
    const source = join(root, "source")
    const patches = join(root, "packages", "selfpatch", "patches", "1.2.3")
    mkdirSync(source, { recursive: true })
    mkdirSync(patches, { recursive: true })
    const official = "stable host boundary\n"
    writeFileSync(join(source, "host.ts"), official)
    writeFileSync(
      join(patches, "manifest.mjs"),
      `export const manifest = ${JSON.stringify({
        version: "1.2.3",
        create: [{ path: "created.ts", content: "enhancement\\n" }],
        files: [{
          path: "host.ts",
          beforeSha256: sha256Of(official),
          replacements: [{ search: "stable", replace: "enhanced" }],
        }],
      })}`,
    )

    const profile = await resolvePatchProfile(root, "1.2.4", source)
    assert.ok(profile, "a future version with identical host boundaries must remain enhanceable")
    assert.equal(profile.exact, false)
    assert.equal(profile.profileVersion, "1.2.3")
    assert.equal(profile.manifest.version, "1.2.4")
    assert.equal(profile.manifest.compatibleProfile, "1.2.3")
    assert.equal(await manifestCompatible(source, profile.manifest), true)

    await applyManifest(source, profile.manifest)
    assert.equal(
      await manifestCompatible(source, profile.manifest),
      true,
      "an exact already-applied source tree must remain compatible on restart",
    )
    const repeated = await resolvePatchProfile(root, "1.2.4", source)
    assert.equal(repeated?.profileVersion, "1.2.3")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("changed OpenCode host boundaries stay official and cannot reuse a profile", async () => {
  const root = mkdtempSync(join(tmpdir(), "alonix-toolings-incompatible-version-"))
  try {
    const source = join(root, "source")
    const patches = join(root, "packages", "selfpatch", "patches", "1.2.3")
    mkdirSync(source, { recursive: true })
    mkdirSync(patches, { recursive: true })
    writeFileSync(join(source, "host.ts"), "new incompatible host boundary\n")
    writeFileSync(
      join(patches, "manifest.mjs"),
      `export const manifest = ${JSON.stringify({
        version: "1.2.3",
        files: [{
          path: "host.ts",
          beforeSha256: sha256Of("old host boundary\\n"),
          replacements: [{ search: "old", replace: "enhanced" }],
        }],
      })}`,
    )

    assert.equal(await resolvePatchProfile(root, "2.0.0", source), null)
    assert.equal(readFileSync(join(source, "host.ts"), "utf8"), "new incompatible host boundary\n")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("an existing but partial source cache is not considered ready", async () => {
  const root = mkdtempSync(join(tmpdir(), "alonix-toolings-source-"))
  try {
    assert.equal(await sourceReady(root), false)
    for (const file of [
      "bun.lock",
      "packages/opencode/script/build.ts",
      "packages/plugin/src/tui.ts",
      "packages/tui/src/app.tsx",
      "packages/tui/src/plugin/adapters.tsx",
      "packages/tui/src/routes/session/index.tsx",
    ]) {
      const target = join(root, file)
      mkdirSync(join(target, ".."), { recursive: true })
      writeFileSync(target, "sentinel\n")
    }
    assert.equal(await sourceReady(root), true)
    rmSync(join(root, "packages/tui/src/routes/session/index.tsx"))
    assert.equal(await sourceReady(root), false, "a missing patch anchor must force re-extraction")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("v1.18.15 has a dedicated strict profile for changed upstream files", () => {
  assert.equal(patchManifest11815.version, "1.18.15")
  assert.deepEqual(
    patchManifest11815.files.map((entry) => entry.path),
    patchManifest.files.map((entry) => entry.path),
  )
  assert.deepEqual(
    patchManifest11815.files.map((entry) => entry.replacements),
    patchManifest.files.map((entry) => entry.replacements),
    "the new profile must reuse only the already-reviewed patch bodies",
  )
  const upstreamChanges = new Map(patchManifest11815.files.map((entry) => [entry.path, entry.beforeSha256]))
  assert.equal(upstreamChanges.get("packages/tui/src/routes/session/index.tsx"), "90f0471caac6eac5768cf4358d4371207dd69362affeddb4ea0f30133a7e576c")
  assert.equal(upstreamChanges.get("packages/opencode/src/session/prompt.ts"), "0ef73c460d46619cd3e75d4b790a22a3c4c999b311a43e7887b634ff7a3fa06d")
})

test("v1.18.13 patch carries tool renderers through every TUI API boundary", () => {
  const files = new Map(patchManifest.files.map((file) => [file.path, file]))
  const pluginTypes = files.get("packages/plugin/src/tui.ts")
  const hostRuntime = files.get("packages/opencode/src/plugin/tui/runtime.ts")
  const adapters = files.get("packages/tui/src/plugin/adapters.tsx")
  assert.ok(pluginTypes, "public plugin API types must be patched")
  assert.ok(hostRuntime, "scoped plugin facade must be patched")
  assert.ok(adapters, "base TUI adapter must be patched")
  assert.match(pluginTypes.replacements.map((item) => item.replace).join("\n"), /toolRenderers/)
  assert.match(hostRuntime.replacements.map((item) => item.replace).join("\n"), /scope\.track\(api\.toolRenderers\.register/)
  assert.match(adapters.replacements.map((item) => item.replace).join("\n"), /return registerPluginToolRenderer/)
})

test("v1.18.13 patch exposes a native deferred session draft without creating sessions", () => {
  const files = new Map(patchManifest.files.map((file) => [file.path, file]))
  const pluginTypes = files.get("packages/plugin/src/tui.ts")
  const hostRuntime = files.get("packages/opencode/src/plugin/tui/runtime.ts")
  const adapters = files.get("packages/tui/src/plugin/adapters.tsx")
  const destination = files.get("packages/tui/src/routes/home/session-destination.tsx")
  for (const file of [pluginTypes, hostRuntime, adapters, destination]) assert.ok(file)

  assert.match(pluginTypes.replacements.map((item) => item.replace).join("\n"), /sessionDraft/)
  assert.match(hostRuntime.replacements.map((item) => item.replace).join("\n"), /sessionDraft: api\.sessionDraft/)
  const adapterSource = adapters.replacements.map((item) => item.replace).join("\n")
  assert.match(adapterSource, /setHomeSessionDestination\(target\)/)
  assert.match(adapterSource, /routeNavigate\(input\.route, "home"\)/)
  const destinationSource = destination.replacements.map((item) => item.replace).join("\n")
  assert.match(destinationSource, /setDestination\(\{ type: "directory", directory: target, subdirectory: false \}\)/)
  assert.match(destinationSource, /onCleanup\(\(\) => setDestination\(undefined\)\)/, "leaving an untouched draft must clear its folder")
  for (const source of [adapterSource, destinationSource]) {
    assert.doesNotMatch(source, /session\.create|sdk\.client/, "draft preparation must never create a session")
  }
})

test("v1.18.13 patch is limited to renderer plumbing, deferred drafts, tool recovery, and one layout slot", () => {
  // Every host file patched here is a maintenance cost on each OpenCode
  // upgrade, so the set stays explicit and small.
  const paths = patchManifest.files.map((file) => file.path)
  assert.deepEqual(paths.sort(), [
    "packages/opencode/src/plugin/tui/runtime.ts",
    "packages/opencode/src/session/prompt.ts",
    "packages/plugin/src/tui.ts",
    // Adds the `app_left` layout column. A dock cannot push the app aside from
    // a plugin slot alone: the root is a column, so an absolutely positioned
    // panel is the only alternative and it covers the transcript instead of
    // sitting beside it.
    "packages/tui/src/app.tsx",
    "packages/tui/src/plugin/adapters.tsx",
    "packages/tui/src/routes/home/session-destination.tsx",
    "packages/tui/src/routes/session/index.tsx",
  ].sort())

  // These remain forbidden: they would move host state ownership or routing
  // into the patch, which the plugin API already covers.
  const source = JSON.stringify(patchManifest)
  for (const forbidden of [
    "TuiProject",
    "TuiWorkspace",
    "projectTransition",
    "packages/tui/src/context/sdk.tsx",
  ]) {
    assert.equal(source.includes(forbidden), false, `forbidden host behavior: ${forbidden}`)
  }
})

test("the app.tsx patch only adds a layout column and leaves routing untouched", () => {
  const app = patchManifest.files.find((file) => file.path === "packages/tui/src/app.tsx")
  assert.ok(app, "the layout patch must be present")
  const replaced = app.replacements.map((item) => item.replace).join("\n")

  // It introduces exactly one new slot and the row wrapper that hosts it.
  assert.match(replaced, /name="app_left"/, "the left column slot must be declared")
  assert.match(replaced, /flexDirection="row"/, "the root must become a row so the column sits beside the app")

  // The existing route switch and bottom slot must survive unchanged.
  assert.match(replaced, /<Switch>/, "routing must be preserved")
  assert.match(replaced, /name="app_bottom"/, "the existing bottom slot must be preserved")

  // Nothing about sessions, projects, or navigation belongs in a layout patch.
  for (const forbidden of ["session.create", "route.navigate", "sdk.client"]) {
    assert.equal(replaced.includes(forbidden), false, `layout patch must not touch ${forbidden}`)
  }
})

test("the app_left slot is declared in the public plugin types", () => {
  const types = patchManifest.files.find((file) => file.path === "packages/plugin/src/tui.ts")
  assert.ok(types, "public plugin API types must be patched")
  const replaced = types.replacements.map((item) => item.replace).join("\n")
  assert.match(replaced, /app_left: \{\}/, "plugins must be able to target the new slot in a typed way")
})

test("v1.18.13 patch leaves native transcript synchronization untouched", () => {
  const source = JSON.stringify(patchManifest)
  assert.equal(patchManifest.files.some((file) => file.path === "packages/tui/src/context/sync.tsx"), false)
  assert.doesNotMatch(source, /transcriptOnly|active transcript cross-process reconciliation|adaptive visible transcript refresh loop/)
  assert.doesNotMatch(source, /sync\.session\.sync\(sessionID, \{ force: true/)
})

test("v1.18.13 patch terminalizes only unfinished tools at a newly owned loop boundary", () => {
  const prompt = patchManifest.files.find((file) => file.path === "packages/opencode/src/session/prompt.ts")
  assert.ok(prompt, "session prompt lifecycle recovery must be patched")
  const source = prompt.replacements.map((item) => item.replace).join("\n")
  assert.match(source, /part\.state\.status !== "pending" && part\.state\.status !== "running"/)
  assert.match(source, /status: "error"/)
  assert.match(source, /interrupted: true/)
  assert.match(source, /recovered: true/)
  assert.match(source, /if \(step === 0\)/)
  assert.match(source, /sessions\.updatePart\(part\)/)
  assert.doesNotMatch(source, /setTimeout|setInterval|Date\.now\(\)\s*-/)
})

test("v1.18.13 renderer registry is reactive and disposal-safe", () => {
  const source = patchManifest.create.find((item) => item.path.endsWith("tool-renderers.ts"))?.content ?? ""
  assert.match(source, /registryVersion\(\)/)
  assert.match(source, /return \(\) =>/)
  assert.match(source, /entry\.token !== token/)
  assert.match(source, /\.at\(-1\)\?\.renderer/)
})

test("self-patch rejects a missing relative detector result before opening it", () => {
  const source = readFileSync(new URL("../lib/pipeline.js", import.meta.url), "utf8")
  assert.match(source, /detected\?\.path \? \{ \.\.\.detected, path: path\.resolve\(detected\.path\) \}/)
  assert.match(source, /!bin \|\| !\(await exists\(bin\.path\)\)/)
})

test("self-patch activation is gated by the current manifest fingerprint", () => {
  const source = readFileSync(new URL("../lib/pipeline.js", import.meta.url), "utf8")
  assert.match(source, /patchedSha === officialSha && artifactMarker\?\.manifestSha256 === manifestSha/)
  assert.match(source, /artifactMarker\?\.binarySha256 === patchedSha/)
  assert.match(source, /patchedArtifactMarkerFile\(root, bin\.version\)/)
  assert.match(source, /installPending\(freshState, Date\.now\(\)\) && artifactMarker\?\.manifestSha256 === manifestSha/)
})

test("OpenCode updates are never blocked or replaced without verified source compatibility", () => {
  const source = readFileSync(new URL("../lib/pipeline.js", import.meta.url), "utf8")
  const compatibilityCheck = source.indexOf("profile = await resolvePatchProfile(root, bin.version, sourceRootForMarker)")
  const portableReturn = source.indexOf('status: "portable"', compatibilityCheck)
  const install = source.indexOf("installPatchedBinary", portableReturn)
  assert.ok(compatibilityCheck >= 0, "unknown versions must be checked by host capabilities")
  assert.ok(portableReturn > compatibilityCheck, "a changed host must enter portable mode")
  assert.ok(install > portableReturn, "binary installation must occur only after the portable early-return gate")
  assert.match(source, /optional enhancements were safely skipped/)
  assert.match(source, /readPatchMarker\(sourceRootForMarker\)/, "changed profiles must retry compatibility against pristine source")
  assert.doesNotMatch(source, /No bundled patch manifest for OpenCode/)
})

test("resolveBun skips non-executable package wrappers on Windows", async () => {
  const resolved = await resolveBun(fileURLToPath(new URL("../../..", import.meta.url)))
  assert.ok(resolved, "a usable Bun executable must be resolved for host rebuilding")
  if (process.platform === "win32" && resolved.source === "workspace") {
    assert.doesNotMatch(resolved.command.replaceAll("\\", "/"), /node_modules\/bun\/bin\/bun\.exe$/i)
  }
})

test("source dependency hydration never runs third-party lifecycle scripts", () => {
  const source = readFileSync(new URL("../lib/pipeline.js", import.meta.url), "utf8")
  assert.match(source, /\["install", "--frozen-lockfile", "--ignore-scripts"\]/)
})

test("detectBinary prefers a real OpenCode binary over its dev host", () => {
  // This test previously asserted the opposite and encoded a real defect: the
  // plugin runs under a node host, so detection always reported dev-mode and
  // the UI claimed self-patching was "not applicable" on working installs.
  assert.ok(isDevRuntime(process.execPath), "node should be recognized as a dev runtime")
  const info = detectBinary()
  if (!info) return
  if (info.devMode) {
    // Only valid when no OpenCode binary is installed on this machine.
    assert.equal(resolveOnPath(), null, "dev-mode is only correct when no OpenCode binary exists")
    return
  }
  assert.ok(!isDevRuntime(info.path), "a patchable binary must not be node/bun")
  assert.match(info.version ?? "", /^\d+\.\d+\.\d+$/)
})

test("PATH resolution returns a directly spawnable binary, not an unusable shim", () => {
  const resolved = resolveOnPath()
  if (!resolved) return
  // Windows npm shims (.cmd/.ps1) cannot be spawned without a shell, so
  // resolution must reach the packaged executable itself.
  assert.doesNotMatch(resolved, /\.(cmd|ps1|bat)$/i)
  assert.ok(existsSync(resolved), "resolved binary must exist")
  assert.ok(versionOf(resolved), "resolved binary must report a version without a shell")
})

test("defaultState contains every field the pipeline writes", () => {
  const state = defaultState()
  for (const key of ["version", "binaryPath", "officialSha256", "patchedSha256", "patchedPath", "compatibilityProfile", "compatibilityMode", "status", "progressPercent", "stepLabel", "logTail", "lastError", "renderersActive", "updatedAt"]) {
    assert.ok(key in state, `missing field: ${key}`)
  }
})
