#!/usr/bin/env node
// Network end-to-end check: downloads the exact OpenCode release source into
// the shared runtime cache (the same one the real pipeline reuses), extracts
// it, applies the bundled v1.18.13 anchor manifest, and verifies every anchor
// landed. Run via `npm run test:patch:e2e`. Requires network on first run.
import { existsSync } from "node:fs"
import { readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { applyManifest, ensureSource, manifestSha256, patchMarkerFile } from "../../lib/pipeline.js"

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, "..", "..", "..", "..")
const VERSION = "1.18.13"
// Pipeline functions append runtime/ themselves, so the root is the repo
// root. The real pipeline later reuses the downloaded archive and the
// patched source, so this test never deletes runtime/.
const root = repoRoot
let ok = false

async function readMarker(sourceRoot) {
  try {
    return JSON.parse(await readFile(patchMarkerFile(sourceRoot), "utf8"))
  } catch {
    return null
  }
}

try {
  const manifestFile = join(repoRoot, "packages", "selfpatch", "patches", VERSION, "manifest.mjs")
  if (!existsSync(manifestFile)) throw new Error(`manifest missing: ${manifestFile}`)
  const { manifest } = await import(pathToFileURL(manifestFile).href)

  let sourceRoot = await ensureSource(root, VERSION)
  const marker = await readMarker(sourceRoot)
  const manifestSha = await manifestSha256(manifest)
  if (marker && marker.manifestSha256 === manifestSha) {
    // Already patched from a prior run; verify the anchors are still present.
  } else {
    if (marker) {
      // Patch set changed: reset to pristine source and re-extract.
      await rm(sourceRoot, { recursive: true, force: true })
      sourceRoot = await ensureSource(root, VERSION)
    }
    await applyManifest(sourceRoot, manifest)
    await writeFile(patchMarkerFile(sourceRoot), JSON.stringify({ version: VERSION, manifestSha256: manifestSha }, null, 2), "utf8")
  }

  const sessionIndex = join(sourceRoot, "packages", "tui", "src", "routes", "session", "index.tsx")
  const adapters = join(sourceRoot, "packages", "tui", "src", "plugin", "adapters.tsx")
  const registryFile = join(sourceRoot, "packages", "tui", "src", "plugin", "tool-renderers.ts")
  const pluginTypesFile = join(sourceRoot, "packages", "plugin", "src", "tui.ts")
  const scopedRuntimeFile = join(sourceRoot, "packages", "opencode", "src", "plugin", "tui", "runtime.ts")
  const session = await readFile(sessionIndex, "utf8")
  const adap = await readFile(adapters, "utf8")
  const registry = await readFile(registryFile, "utf8")
  const pluginTypes = await readFile(pluginTypesFile, "utf8")
  const scopedRuntime = await readFile(scopedRuntimeFile, "utf8")
  const checks = {
    "registry file created": existsSync(registryFile),
    "session imports registry": session.includes('from "../../plugin/tool-renderers"'),
    "plugin display branch": session.includes('display() === "plugin"') && session.includes("<PluginTool"),
    "PluginTool component": session.includes("function PluginTool"),
    "adapters registers api surface": adap.includes("toolRenderers:"),
    "adapters returns registration disposer": adap.includes("return registerPluginToolRenderer"),
    "public plugin API declares renderer capability": pluginTypes.includes("toolRenderers: TuiToolRenderers"),
    "scoped plugin API forwards renderer capability": scopedRuntime.includes("scope.track(api.toolRenderers.register"),
    "registry supports disposal": registry.includes("entry.token !== token") && registry.includes("return () =>"),
  }
  const failed = Object.entries(checks).filter(([, value]) => !value)
  if (failed.length) throw new Error(`anchor verification failed: ${failed.map(([name]) => name).join(", ")}`)

  const markerAfter = await readMarker(sourceRoot)
  if (!markerAfter || markerAfter.version !== VERSION) throw new Error("patch marker version mismatch")
  if (markerAfter.manifestSha256 !== manifestSha) throw new Error("patch marker sha mismatch")

  // Idempotency: a second direct apply must be rejected cleanly because the
  // files are already patched (the pipeline skips via the marker instead).
  let secondRejected = false
  try {
    await applyManifest(sourceRoot, manifest)
  } catch {
    secondRejected = true
  }
  if (!secondRejected) throw new Error("second apply should have been rejected (files already patched)")

  console.log(`PATCH E2E: SUCCESS (v${VERSION}; registry, session branch, public + scoped API forwarding, disposal, marker, idempotent rejection)`)
  ok = true
} catch (error) {
  console.error(`PATCH E2E: FAILED — ${error.message}`)
  if (!process.env.CI) console.error("If this failed at download/extract, network access to github.com is required.")
}

if (!ok) process.exitCode = 1
