import test from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultState, readState, sha256File, stateSummary, writeState } from "../lib/state.js"
import { applyManifest, manifestSha256, patchFileContent } from "../lib/pipeline.js"
import { detectBinary, isDevRuntime } from "../lib/detect.js"
import { SelfPatchPlugin } from "../index.js"
import { manifest as patchManifest } from "../patches/1.18.13/manifest.mjs"

test("toolings tool registration exposes a callable execute", async () => {
  const plugin = await SelfPatchPlugin()
  try {
    assert.equal(typeof plugin.tool.toolings, "object")
    assert.equal(typeof plugin.tool.toolings.execute, "function")
    assert.equal(typeof plugin.tool.toolings.invoke, "undefined")
    assert.equal(typeof plugin.tool.toolings.inputSchema, "object")
  } finally {
    await plugin.dispose?.()
  }
})

function sha256Of(text) {
  return createHash("sha256").update(text).digest("hex")
}

test("state defaults merge and atomic persistence", async () => {
  const root = mkdtempSync(join(tmpdir(), "toolings-state-"))
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
  const root = mkdtempSync(join(tmpdir(), "toolings-hash-"))
  try {
    const file = join(root, "payload.bin")
    const body = `${"a".repeat(2 * 1024 * 1024)}tail`
    writeFileSync(file, body)
    assert.equal(await sha256File(file), sha256Of(body))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("patchFileContent enforces exact occurrence counts", async () => {
  const root = mkdtempSync(join(tmpdir(), "toolings-patch-"))
  try {
    const file = join(root, "a.txt")
    writeFileSync(file, "one one two\n")
    const out = await patchFileContent(file, [{ name: "double replace", search: "one", replace: "1", count: 2 }])
    assert.equal(out, "1 1 two\n")
    await assert.rejects(() => patchFileContent(file, [{ name: "bad count", search: "one", replace: "1", count: 3 }]), /expected 3 occurrence\(s\), found 2/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("applyManifest validates everything before writing anything", async () => {
  const root = mkdtempSync(join(tmpdir(), "toolings-manifest-"))
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
      files: [{ path: "existing.txt", beforeSha256: sha256Of("totally different"), replacements: [{ name: "swap", search: "beta", replace: "gamma" }] }],
    }
    await assert.rejects(() => applyManifest(src, failing), /fingerprint mismatch/)
    assert.equal(existsSync(join(src, "other-new.txt")), false)
    assert.match(readFileSync(existing, "utf8"), /alpha gamma/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("manifestSha256 is deterministic", async () => {
  const manifest = { version: "x", create: [] }
  assert.equal(await manifestSha256(manifest), await manifestSha256(manifest))
  assert.notEqual(await manifestSha256(manifest), await manifestSha256({ ...manifest, version: "y" }))
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

test("v1.18.13 renderer registry is reactive and disposal-safe", () => {
  const source = patchManifest.create.find((item) => item.path.endsWith("tool-renderers.ts"))?.content ?? ""
  assert.match(source, /registryVersion\(\)/)
  assert.match(source, /return \(\) =>/)
  assert.match(source, /entry\.token !== token/)
  assert.match(source, /\.at\(-1\)\?\.renderer/)
})

test("self-patch activation is gated by the current manifest fingerprint", () => {
  const source = readFileSync(new URL("../lib/pipeline.js", import.meta.url), "utf8")
  assert.match(source, /patchedSha === officialSha && artifactMarker\?\.manifestSha256 === manifestSha/)
  assert.match(source, /artifactMarker\?\.binarySha256 === patchedSha/)
  assert.match(source, /patchedArtifactMarkerFile\(root, bin\.version\)/)
  assert.match(source, /installPending\(freshState, Date\.now\(\)\) && artifactMarker\?\.manifestSha256 === manifestSha/)
})

test("source dependency hydration never runs third-party lifecycle scripts", () => {
  const source = readFileSync(new URL("../lib/pipeline.js", import.meta.url), "utf8")
  assert.match(source, /\["install", "--frozen-lockfile", "--ignore-scripts"\]/)
})

test("detectBinary recognizes the dev runtime", () => {
  assert.ok(isDevRuntime(process.execPath), "node should be recognized as a dev runtime")
  const info = detectBinary()
  if (info) assert.equal(info.devMode, true)
})

test("defaultState contains every field the pipeline writes", () => {
  const state = defaultState()
  for (const key of ["version", "binaryPath", "officialSha256", "patchedSha256", "patchedPath", "status", "progressPercent", "stepLabel", "logTail", "lastError", "renderersActive", "updatedAt"]) {
    assert.ok(key in state, `missing field: ${key}`)
  }
})
