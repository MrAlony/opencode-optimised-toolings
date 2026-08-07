import { promises as fs } from "node:fs"
import { spawn, spawnSync } from "node:child_process"
import path from "node:path"
import os from "node:os"
import { createHash } from "node:crypto"
import { pathToFileURL } from "node:url"
import { patchedBinaryPath, readState, runtimeDir, sha256File, writeState } from "./state.js"
import { detectBinary } from "./detect.js"
import { installPatchedBinary } from "./restart.js"
import { bunCacheEntries, looksLikeBrokenInstall, packagesFromBuildLog, verifyPackages } from "./integrity.js"

export const OPENCODE_VERSION = "1.18.13"
export const BUN_VERSION = "1.3.14"

export function UPSTREAM_ARCHIVE(version) {
  return `https://github.com/anomalyco/opencode/archive/refs/tags/v${version}.tar.gz`
}

export function manifestFileFor(root, version) {
  return path.join(root, "packages", "selfpatch", "patches", version, "manifest.mjs")
}

export function patchProfilesDir(root) {
  return path.join(root, "packages", "selfpatch", "patches")
}

export function sourceDir(root, version) {
  return path.join(runtimeDir(root), "src", `opencode-${version}`)
}

export function cacheTarball(root, version) {
  return path.join(runtimeDir(root), "cache", `opencode-v${version}.tar.gz`)
}

export function lockFile(root) {
  return path.join(runtimeDir(root), "pipeline.lock")
}

export function patchMarkerFile(sourceRoot) {
  return path.join(sourceRoot, ".alonix-toolings-patch-marker.json")
}

export function patchedArtifactMarkerFile(root, version) {
  return `${patchedBinaryPath(root, version)}.manifest.json`
}

function tarExecutable() {
  return process.platform === "win32" ? "C:\\Windows\\System32\\tar.exe" : "tar"
}

async function exists(file) {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

export async function patchFileContent(file, replacements) {
  const before = await fs.readFile(file, "utf8")
  let current = before
  for (const item of replacements) {
    const count = item.count ?? 1
    const replacementOccurrences = current.split(item.replace).length - 1
    // Replacement bodies can intentionally contain their original anchor, so
    // exact replacement presence must be checked before counting the anchor.
    if (replacementOccurrences === count) continue

    const occurrences = current.split(item.search).length - 1
    if (occurrences !== count) {
      throw new Error(
        `patch step ${JSON.stringify(item.name ?? item.search.slice(0, 60))} expected ${count} original or already-applied replacement occurrence(s), ` +
          `found original=${occurrences}, replacement=${replacementOccurrences}`
      )
    }
    current = current.split(item.search).join(item.replace)
  }
  return current
}

/**
 * Validation-first manifest application: every create and patch target is
 * verified and fully computed in memory before any file is written. A failure
 * therefore leaves the extracted source untouched so a later run can retry
 * cleanly.
 */
export async function applyManifest(sourceRoot, manifest) {
  const staged = []
  for (const entry of manifest.create ?? []) {
    const file = path.join(sourceRoot, entry.path)
    if (await exists(file)) {
      const current = await fs.readFile(file, "utf8")
      if (current === entry.content) continue
      const sha = await sha256File(file)
      throw new Error(`create target ${entry.path} already exists with different content: sha ${sha}`)
    }
    staged.push({ file, content: entry.content })
  }
  for (const entry of manifest.files ?? []) {
    const file = path.join(sourceRoot, entry.path)
    const before = await fs.readFile(file, "utf8")
    const sha = createHash("sha256").update(before).digest("hex")
    if (sha === entry.beforeSha256) {
      staged.push({ file, content: await patchFileContent(file, entry.replacements) })
      continue
    }

    // Files are written as complete staged bodies, so marker-loss recovery has
    // exactly one valid non-pristine state: every replacement is fully applied.
    // Reverse those replacements and require the official release fingerprint;
    // this rejects mixed, truncated, or externally modified content.
    let restored = before
    try {
      for (const item of [...entry.replacements].reverse()) {
        const count = item.count ?? 1
        const replacementOccurrences = restored.split(item.replace).length - 1
        if (replacementOccurrences !== count) {
          throw new Error(
            `step ${JSON.stringify(item.name ?? item.search.slice(0, 60))} is not fully applied ` +
              `(replacement=${replacementOccurrences})`
          )
        }
        restored = restored.split(item.replace).join(item.search)
      }
    } catch (error) {
      throw new Error(
        `patch target ${entry.path} fingerprint mismatch: expected ${entry.beforeSha256}, got ${sha}; ` +
          `the file is neither pristine nor the exact patched result. ${error.message}`
      )
    }
    const restoredSha = createHash("sha256").update(restored).digest("hex")
    if (restoredSha !== entry.beforeSha256) {
      throw new Error(
        `patch target ${entry.path} fingerprint mismatch: expected ${entry.beforeSha256}, got ${sha}; ` +
          `reversing the manifest produced ${restoredSha}, so foreign changes are present.`
      )
    }
  }
  for (const item of staged) {
    await fs.mkdir(path.dirname(item.file), { recursive: true })
    await fs.writeFile(item.file, item.content, "utf8")
  }
}

async function readJsonMarker(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"))
  } catch {
    return null
  }
}

async function readPatchMarker(sourceRoot) {
  return readJsonMarker(patchMarkerFile(sourceRoot))
}

async function readPatchedArtifactMarker(root, version) {
  return readJsonMarker(patchedArtifactMarkerFile(root, version))
}

export async function manifestSha256(manifest) {
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex")
}

function versionParts(value) {
  return String(value ?? "")
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0)
}

function compareVersionsDesc(left, right) {
  const a = versionParts(left)
  const b = versionParts(right)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (b[index] ?? 0) - (a[index] ?? 0)
    if (difference) return difference
  }
  return String(right).localeCompare(String(left))
}

/**
 * Prove that a pristine upstream source tree has the exact file-level
 * capabilities expected by a patch profile. Fingerprints are intentionally
 * stronger than a semver range: a future OpenCode release can reuse a profile
 * only when every touched host file is byte-for-byte compatible.
 */
export async function manifestCompatible(sourceRoot, manifest) {
  for (const entry of manifest.create ?? []) {
    const file = path.join(sourceRoot, entry.path)
    if (await exists(file)) {
      const current = await fs.readFile(file, "utf8").catch(() => null)
      if (current !== entry.content) return false
    }
  }
  for (const entry of manifest.files ?? []) {
    const file = path.join(sourceRoot, entry.path)
    if (!(await exists(file))) return false
    const current = await fs.readFile(file, "utf8")
    const sha = createHash("sha256").update(current).digest("hex")
    if (sha === entry.beforeSha256) continue

    // An interrupted/restarted controller commonly sees the exact source body
    // it patched on the previous run. Reverse every complete replacement and
    // require the official fingerprint, exactly like applyManifest's strict
    // marker-loss recovery. Partial or foreign edits cannot pass this proof.
    let restored = current
    try {
      for (const item of [...entry.replacements].reverse()) {
        const count = item.count ?? 1
        if (restored.split(item.replace).length - 1 !== count) return false
        restored = restored.split(item.replace).join(item.search)
      }
    } catch {
      return false
    }
    const restoredSha = createHash("sha256").update(restored).digest("hex")
    if (restoredSha !== entry.beforeSha256) return false
  }
  return true
}

async function loadManifest(file) {
  const module = await import(`${pathToFileURL(file).href}?profile=${encodeURIComponent(file)}`)
  return module.manifest
}

/**
 * Resolve the enhancement profile for an installed OpenCode release.
 *
 * Exact profiles win. Otherwise all bundled profiles are treated as capability
 * descriptions and the newest byte-compatible one is reused for the installed
 * version. This lets patch-compatible OpenCode updates continue automatically
 * without unsafe broad version ranges or copied manifests.
 */
export async function resolvePatchProfile(root, version, sourceRoot) {
  const exactFile = manifestFileFor(root, version)
  if (await exists(exactFile)) {
    return { manifest: await loadManifest(exactFile), profileVersion: version, exact: true }
  }
  if (!sourceRoot) return null

  let entries = []
  try {
    entries = await fs.readdir(patchProfilesDir(root), { withFileTypes: true })
  } catch {
    return null
  }
  const versions = entries
    .filter((entry) => entry.isDirectory() && entry.name !== version)
    .map((entry) => entry.name)
    .sort(compareVersionsDesc)

  for (const profileVersion of versions) {
    const file = manifestFileFor(root, profileVersion)
    if (!(await exists(file))) continue
    const manifest = await loadManifest(file)
    if (!(await manifestCompatible(sourceRoot, manifest))) continue
    return {
      manifest: { ...manifest, version, compatibleProfile: profileVersion },
      profileVersion,
      exact: false,
    }
  }
  return null
}

const SOURCE_SENTINELS = [
  "bun.lock",
  "packages/opencode/script/build.ts",
  "packages/plugin/src/tui.ts",
  "packages/tui/src/app.tsx",
  "packages/tui/src/plugin/adapters.tsx",
  "packages/tui/src/routes/session/index.tsx",
]

export async function sourceReady(dir) {
  if (!(await exists(dir))) return false
  for (const relative of SOURCE_SENTINELS) {
    if (!(await exists(path.join(dir, relative)))) return false
  }
  return true
}

export async function ensureSource(root, version) {
  const dir = sourceDir(root, version)
  if (await sourceReady(dir)) return dir
  // A killed extraction can leave the directory present but unusable. Treat it
  // as a cache miss so the already-downloaded archive self-heals on retry.
  if (await exists(dir)) await fs.rm(dir, { recursive: true, force: true })
  const tar = cacheTarball(root, version)
  await fs.mkdir(path.dirname(tar), { recursive: true })
  if (!(await exists(tar))) {
    const url = UPSTREAM_ARCHIVE(version)
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(180_000) })
    if (!res.ok) throw new Error(`download failed: ${url} -> HTTP ${res.status}`)
    await fs.writeFile(tar, Buffer.from(await res.arrayBuffer()))
  }
  const extractDir = path.dirname(tar)
  // Reset any stale partial extraction of this version before extracting.
  const existingEntries = await fs.readdir(extractDir)
  for (const name of existingEntries) {
    if (name.startsWith("opencode-") && !name.endsWith(".tar.gz")) {
      await fs.rm(path.join(extractDir, name), { recursive: true, force: true }).catch(() => {})
    }
  }
  // Pure-JS extraction is portable and avoids Windows bsdtar path quirks;
  // the system tar is kept as a fallback when the dependency is missing.
  let tarLib = null
  try {
    tarLib = await import("tar")
  } catch {
    tarLib = null
  }
  if (tarLib?.x) {
    await tarLib.x({ file: tar, cwd: extractDir })
  } else {
    const result = spawnSync(tarExecutable(), ["-xzf", tar, "-C", extractDir], {
      encoding: "utf8",
      timeout: 240_000,
      windowsHide: true,
    })
    if (result.error || result.status !== 0) {
      throw new Error(`tar extraction failed: ${(result.stderr ?? result.error?.message ?? "unknown").toString().slice(-500)}`)
    }
  }
  const entries = await fs.readdir(extractDir)
  const expected = `opencode-${version}`
  const match =
    entries.find((name) => name === expected) ??
    entries.find((name) => name.startsWith("opencode-") && !name.endsWith(".tar.gz"))
  if (!match) throw new Error("extracted source root not found")
  const extracted = path.join(extractDir, match)
  if (path.resolve(extracted) !== path.resolve(dir)) {
    await fs.mkdir(path.dirname(dir), { recursive: true })
    await fs.rename(extracted, dir)
  }
  if (!(await sourceReady(dir))) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    throw new Error("extracted source is incomplete; required OpenCode files are missing")
  }
  return dir
}

async function walk(dir, onFile) {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) await walk(full, onFile)
    else onFile(full)
  }
}

async function findBuiltBinary(sourceRoot) {
  const distRoot = path.join(sourceRoot, "packages", "opencode", "dist")
  if (!(await exists(distRoot))) return null
  const found = []
  await walk(distRoot, (file) => {
    const base = path.basename(file)
    if (base.startsWith("opencode")) found.push(file)
  })
  if (process.platform === "win32") {
    const exe = found.find((file) => file.endsWith(".exe"))
    if (exe) return exe
  }
  return found.sort((a, b) => a.length - b.length)[0] ?? null
}

function bunCandidates(root) {
  const base = path.join(root, "node_modules")
  return [
    ["bun", "bin", "bun.exe"],
    ["bun", "bin", "bun"],
    ["@oven", "bun-windows-x64", "bin", "bun.exe"],
    ["@oven", "bun-windows-x64-baseline", "bin", "bun.exe"],
    ["@oven", "bun-linux-x64", "bin", "bun"],
    ["@oven", "bun-darwin-arm64", "bin", "bun"],
    ["@oven", "bun-darwin-x64", "bin", "bun"],
    ["@oven", "bun-linux-arm64", "bin", "bun"],
  ].map((parts) => path.join(base, ...parts))
}

export async function resolveBun(root) {
  if (process.env.OPENCODE_TOOLINGS_BUN) {
    return { command: process.env.OPENCODE_TOOLINGS_BUN, prefixArgs: [], source: "env" }
  }
  for (const candidate of bunCandidates(root)) {
    if (!(await exists(candidate))) continue
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf8", timeout: 10_000, windowsHide: true })
    if (!probe.error && probe.status === 0) return { command: candidate, prefixArgs: [], source: "workspace" }
  }
  const probe = spawnSync("bun", ["--version"], { encoding: "utf8", timeout: 10_000, windowsHide: true })
  if (!probe.error && probe.status === 0) return { command: "bun", prefixArgs: [], source: "path" }
  const npxProbe = spawnSync("npx", ["--yes", `bun@${BUN_VERSION}`, "--version"], {
    encoding: "utf8",
    timeout: 120_000,
    windowsHide: true,
  })
  if (!npxProbe.error && npxProbe.status === 0) return { command: "npx", prefixArgs: ["--yes", `bun@${BUN_VERSION}`], source: "npx" }
  return null
}

/**
 * One-time dependency install for the extracted monorepo. The upstream build
 * runs `bun install` before `script/build.ts --skip-install`, so a freshly
 * extracted source tree has no node_modules and the workspace links
 * (@opencode-ai/script, @opencode-ai/server, ...) cannot resolve. The success
 * sentinel means a completed install is never repeated; if the patch set
 * changes and the source is re-extracted, the sentinel disappears and the
 * install runs again against the pristine tree.
 */
export async function installSourceDeps(sourceRoot, root, onLog, options = {}) {
  const okMarker = path.join(sourceRoot, "node_modules", ".alonix-toolings-install-ok")
  // `force` re-runs a previously "successful" install. A completed install can
  // still leave a truncated package on disk, and the sentinel alone would make
  // that state permanent.
  if (!options.force && (await exists(okMarker))) return
  if (options.force) await fs.rm(okMarker, { force: true }).catch(() => {})
  const bun = await resolveBun(root)
  if (!bun) {
    throw new Error(
      "bun is required to install OpenCode build dependencies and none was found on PATH, in this workspace, or via npx. " +
        "Run `npm install` once in the tooling root (bun is a devDependency), then retry."
    )
  }
  // The CLI build only needs the dependency graph and workspace links. Running
  // third-party lifecycle scripts here needlessly compiles optional native
  // grammars (for example tree-sitter-powershell) and makes patching depend on
  // a host C++ toolchain. The upstream Bun build resolves its target-specific
  // artifacts without those install hooks.
  const args = ["install", "--frozen-lockfile", "--ignore-scripts"]
  if (options.force) args.push("--force")
  onLog(`installing OpenCode dependencies with ${bun.command} ${[...bun.prefixArgs, ...args].join(" ")} (${bun.source})`)
  const child = spawn(bun.command, [...bun.prefixArgs, ...args], {
    cwd: sourceRoot,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, HUSKY: "0", OPENCODE_TOOLINGS_INSTALL: "1" },
  })
  let tail = ""
  const collect = (chunk) => {
    tail = (tail + chunk.toString()).slice(-4000)
    onLog(tail)
  }
  child.stdout.on("data", collect)
  child.stderr.on("data", collect)
  const code = await new Promise((resolve) => child.on("close", resolve))
  if (code !== 0) {
    throw new Error(`dependency install failed with exit code ${code}\n${tail.slice(-1500)}`)
  }
  await fs.writeFile(okMarker, JSON.stringify({ installedAt: new Date().toISOString() }), "utf8")
}

/**
 * Repair packages that a failed build proved to be incomplete.
 *
 * A truncated install survives a plain reinstall because the installer sees the
 * directory as present and the corrupt copy is usually cached, so every retry
 * restores the same broken files. Repair therefore removes the installed
 * package *and* its Bun cache entries before reinstalling, then verifies the
 * entry points really exist rather than trusting the exit code.
 *
 * Returns the packages it repaired, or an empty array when the log does not
 * show this failure mode.
 */
export async function repairBrokenDependencies(sourceRoot, root, buildLog, onLog) {
  const suspects = packagesFromBuildLog(buildLog)
  if (suspects.length === 0) return []

  const cacheDir = process.env.BUN_INSTALL_CACHE_DIR || path.join(os.homedir(), ".bun", "install", "cache")
  const repaired = []
  for (const suspect of suspects) {
    onLog?.(`repairing incomplete package ${suspect.name} (missing ${suspect.missing.slice(0, 3).join(", ")})`)
    await fs.rm(suspect.dir, { recursive: true, force: true }).catch(() => {})
    // The cached copy is the likely source of the truncation; leaving it would
    // reinstall exactly the same broken files.
    for (const entry of await bunCacheEntries(cacheDir, suspect.name)) {
      await fs.rm(entry, { recursive: true, force: true }).catch(() => {})
    }
    repaired.push(suspect)
  }

  await installSourceDeps(sourceRoot, root, (tail) => onLog?.(tail), { force: true })

  const verified = await verifyPackages(repaired.map((item) => item.dir))
  if (!verified.ok) {
    const detail = verified.broken
      .map((item) => `${item.name ?? item.dir}: missing ${item.missing.slice(0, 3).join(", ")}`)
      .join("; ")
    throw new Error(
      `dependency repair could not restore a complete install (${detail}). ` +
        "This usually means the download was truncated by a proxy or antivirus, or the disk is full. " +
        "Delete runtime/src and the Bun cache, then retry."
    )
  }
  return repaired
}

export async function buildPatched(sourceRoot, root, version, onLog) {
  const pkgDir = path.join(sourceRoot, "packages", "opencode")
  const bun = await resolveBun(root)
  if (!bun) {
    throw new Error(
      "bun is required to rebuild OpenCode and none was found on PATH, in this workspace, or via npx. " +
        "Run `npm install` once in the tooling root (bun is a devDependency), then retry."
    )
  }
  const args = ["run", "script/build.ts", "--single", "--skip-install", "--skip-embed-web-ui"]
  onLog(`building with ${bun.command} ${[...bun.prefixArgs, ...args].join(" ")} (${bun.source})`)
  const child = spawn(bun.command, [...bun.prefixArgs, ...args], {
    cwd: pkgDir,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    /* The extracted tree is not a git checkout, so Script.version would fall
       back to 0.0.0-main-{timestamp}; binding OPENCODE_VERSION makes the built
       binary report the real release version (matches detectBinary + manifest). */
    env: { ...process.env, OPENCODE_VERSION: version },
  })
  let tail = ""
  const collect = (chunk) => {
    tail = (tail + chunk.toString()).slice(-4000)
    onLog(tail)
  }
  child.stdout.on("data", collect)
  child.stderr.on("data", collect)
  const code = await new Promise((resolve) => child.on("close", resolve))
  if (code !== 0) {
    const error = new Error(`build failed with exit code ${code}\n${tail.slice(-1500)}`)
    // Preserve the full log so the caller can classify the failure; the message
    // is truncated for display.
    error.buildLog = tail
    error.brokenInstall = looksLikeBrokenInstall(tail)
    throw error
  }
  const binary = await findBuiltBinary(sourceRoot)
  if (!binary) throw new Error("build completed but no binary was found under packages/opencode/dist")
  return binary
}

/**
 * Build, and if the failure is a provably incomplete dependency install,
 * repair it and build once more.
 *
 * Only this specific, self-diagnosable failure is retried. A genuine compile
 * error must surface immediately instead of paying for a second slow build.
 */
export async function buildPatchedWithRepair(sourceRoot, root, version, onLog, onRepair) {
  try {
    return await buildPatched(sourceRoot, root, version, onLog)
  } catch (error) {
    if (!error?.brokenInstall) throw error
    onRepair?.("Repairing an incomplete dependency install")
    const repaired = await repairBrokenDependencies(sourceRoot, root, error.buildLog, onLog)
    if (repaired.length === 0) throw error
    onRepair?.(`Rebuilding after repairing ${repaired.map((item) => item.name).join(", ")}`)
    return await buildPatched(sourceRoot, root, version, onLog)
  }
}

function pidAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code !== "ESRCH"
  }
}

async function acquireLock(lock) {
  await fs.mkdir(path.dirname(lock), { recursive: true })
  // A live instance finishes a build in seconds; wait for it instead of
  // immediately reporting an error state that a concurrent launch would read.
  const deadline = Date.now() + 300_000
  for (;;) {
    let owner = null
    try {
      owner = JSON.parse(await fs.readFile(lock, "utf8"))
    } catch {
      owner = null
    }
    const held = owner?.pid && pidAlive(owner.pid)
    if (!held) break
    if (Date.now() > deadline) throw new Error(`self-patch lock still held by pid ${owner.pid} after 5 minutes`)
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  await fs.writeFile(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }))
}

// A freshly completed in-place install ("built") must not be re-triggered by a
// concurrent launch. Once the record goes stale the next launch retries, so a
// failed install self-heals instead of wedging forever.
const INSTALL_PENDING_STALE_MS = 120_000

export function installPending(state, now = Date.now()) {
  if (!state) return false
  if (state.status !== "built") return false
  const value = state.updatedAt
  const ts = typeof value === "number" ? value : Date.parse(String(value ?? ""))
  if (!Number.isFinite(ts)) return true
  return now - ts <= INSTALL_PENDING_STALE_MS
}

export async function runSelfPatch(root) {
  const lock = lockFile(root)
  await acquireLock(lock)
  const state = await readState(root)
  try {
    const detected = detectBinary()
    const bin = detected?.path ? { ...detected, path: path.resolve(detected.path) } : detected
    if (!bin || !(await exists(bin.path))) {
      await writeState(root, { ...state, status: "no-opencode", stepLabel: "No OpenCode binary found; self-patching skipped" })
      return null
    }
    if (bin.devMode) {
      await writeState(root, {
        ...state,
        status: "dev-mode",
        stepLabel: "Running under a dev runtime (node/bun); self-patching is disabled",
        version: bin.version,
        binaryPath: bin.path,
        renderersActive: false,
      })
      return null
    }
    const officialSha = await sha256File(bin.path)
    if (!bin.version) {
      await writeState(root, {
        ...state,
        status: "unsupported-version",
        binaryPath: bin.path,
        officialSha256: officialSha,
        stepLabel: "Could not determine the OpenCode version; running unchanged",
      })
      return null
    }
    const patchedPath = patchedBinaryPath(root, bin.version)
    let sourceRootForMarker = sourceDir(root, bin.version)
    let profile = await resolvePatchProfile(root, bin.version)
    if (!profile) {
      await writeState(root, {
        status: "detecting",
        version: bin.version,
        binaryPath: bin.path,
        officialSha256: officialSha,
        progressPercent: 5,
        stepLabel: `Checking OpenCode v${bin.version} host capabilities`,
      })
      try {
        sourceRootForMarker = await ensureSource(root, bin.version)
        profile = await resolvePatchProfile(root, bin.version, sourceRootForMarker)
        if (!profile && (await readPatchMarker(sourceRootForMarker))) {
          // A capability profile may have gained new strict patches since this
          // generated source cache was last prepared. Re-check against pristine
          // upstream source rather than misclassifying the installed release.
          await fs.rm(sourceRootForMarker, { recursive: true, force: true })
          sourceRootForMarker = await ensureSource(root, bin.version)
          profile = await resolvePatchProfile(root, bin.version, sourceRootForMarker)
        }
      } catch (error) {
        await writeState(root, {
          status: "portable",
          version: bin.version,
          binaryPath: bin.path,
          officialSha256: officialSha,
          renderersActive: false,
          progressPercent: 0,
          stepLabel: "Plugin active in portable mode; optional host enhancement check will retry later",
          lastError: error?.message ?? String(error),
        })
        return null
      }
    }
    if (!profile) {
      await writeState(root, {
        status: "portable",
        version: bin.version,
        binaryPath: bin.path,
        officialSha256: officialSha,
        renderersActive: false,
        progressPercent: 0,
        stepLabel: `Plugin active on OpenCode v${bin.version}; host changed, so optional enhancements were safely skipped`,
        lastError: null,
      })
      return null
    }
    const manifest = profile.manifest
    const manifestSha = await manifestSha256(manifest)
    const sourceMarker = await readPatchMarker(sourceRootForMarker)
    const artifactMarker = await readPatchedArtifactMarker(root, bin.version)
    if (await exists(patchedPath)) {
      const patchedSha = await sha256File(patchedPath)
      if (patchedSha === officialSha && artifactMarker?.manifestSha256 === manifestSha && artifactMarker?.binarySha256 === patchedSha) {
        await writeState(root, {
          status: "installed",
          version: bin.version,
          binaryPath: bin.path,
          officialSha256: officialSha,
          patchedSha256: patchedSha,
          patchedPath,
          renderersActive: false,
          compatibilityProfile: profile.profileVersion,
          compatibilityMode: profile.exact ? "exact" : "verified-source",
          stepLabel: profile.exact
            ? "Optional host enhancements installed with an exact profile; current-process activation is verified by the TUI"
            : `Optional host enhancements installed via verified profile v${profile.profileVersion}; current-process activation is verified by the TUI`,
        })
        return null
      }
    }
    const freshState = await readState(root)
    if (installPending(freshState, Date.now()) && artifactMarker?.manifestSha256 === manifestSha) return null

    // A previously built patched binary that still matches the current
    // manifest can be installed directly: skip download/patch/build entirely
    // and replace the official binary in place (no process interaction).
    if (await exists(patchedPath)) {
      if (artifactMarker?.manifestSha256 === manifestSha) {
        await writeState(root, {
          status: "installing",
          progressPercent: 85,
          stepLabel: "Installing the patched binary over the official one",
        })
        const patchedSha = await sha256File(patchedPath)
        const installed = await installPatchedBinary({ officialPath: bin.path, patchedPath })
        await writeState(root, {
          status: installed.installed ? "built" : "installed",
          progressPercent: 100,
          stepLabel: installed.installed
            ? "Patched binary installed — restart OpenCode to activate"
            : "Patched binary already installed; current-process activation is verified by the TUI",
          version: bin.version,
          binaryPath: bin.path,
          officialSha256: installed.officialSha,
          patchedSha256: patchedSha,
          patchedPath,
          renderersActive: false,
          compatibilityProfile: profile.profileVersion,
          compatibilityMode: profile.exact ? "exact" : "verified-source",
        })
        return { officialPath: bin.path, patchedPath, officialSha, patchedSha, installed }
      }
    }

    await writeState(root, {
      status: "detecting",
      version: bin.version,
      binaryPath: bin.path,
      officialSha256: officialSha,
      patchedPath,
      compatibilityProfile: profile.profileVersion,
      compatibilityMode: profile.exact ? "exact" : "verified-source",
      progressPercent: 5,
      stepLabel: profile.exact
        ? "Preparing source for the installed OpenCode version"
        : `OpenCode v${bin.version} verified compatible with enhancement profile v${profile.profileVersion}`,
    })
    let sourceRoot = await ensureSource(root, bin.version)

    const marker = sourceRoot === sourceRootForMarker ? sourceMarker : await readPatchMarker(sourceRoot)
    if (!marker || marker.manifestSha256 !== manifestSha) {
      if (marker) {
        // The patch set changed for this version: reset to pristine source and re-extract.
        await fs.rm(sourceRoot, { recursive: true, force: true })
        sourceRoot = await ensureSource(root, bin.version)
      }
      await writeState(root, { status: "patching", progressPercent: 25, stepLabel: "Applying anchor patches" })
      await applyManifest(sourceRoot, manifest)
      await fs.writeFile(
        patchMarkerFile(sourceRoot),
        JSON.stringify({ version: bin.version, profileVersion: profile.profileVersion, manifestSha256: manifestSha }, null, 2),
        "utf8"
      )
    }

    await writeState(root, { status: "installing", progressPercent: 35, stepLabel: "Installing OpenCode build dependencies (first run only; takes a few minutes)" })
    await installSourceDeps(sourceRoot, root, (tail) => {
      void writeState(root, { status: "installing", progressPercent: 38, stepLabel: "Installing OpenCode build dependencies", logTail: tail }).catch(() => {})
    })
    await writeState(root, { status: "building", progressPercent: 40, stepLabel: "Rebuilding OpenCode (first run takes a few minutes)" })
    const binary = await buildPatchedWithRepair(
      sourceRoot,
      root,
      bin.version,
      (tail) => {
        void writeState(root, { status: "building", progressPercent: 45, stepLabel: "Rebuilding OpenCode", logTail: tail }).catch(() => {})
      },
      (stepLabel) => {
        void writeState(root, { status: "installing", progressPercent: 42, stepLabel }).catch(() => {})
      }
    )
    const patchedSha = await sha256File(binary)
    await fs.mkdir(path.dirname(patchedPath), { recursive: true })
    await fs.copyFile(binary, patchedPath)
    await fs.writeFile(
      patchedArtifactMarkerFile(root, bin.version),
      JSON.stringify({ version: bin.version, profileVersion: profile.profileVersion, manifestSha256: manifestSha, binarySha256: patchedSha }, null, 2),
      "utf8"
    )
    await writeState(root, {
      status: "installing",
      progressPercent: 90,
      stepLabel: "Installing the patched binary over the official one",
      patchedSha256: patchedSha,
      patchedPath,
      logTail: "",
    })
    const installed = await installPatchedBinary({ officialPath: bin.path, patchedPath })
    await writeState(root, {
      status: installed.installed ? "built" : "installed",
      progressPercent: 100,
      stepLabel: installed.installed
        ? "Patched binary installed — restart OpenCode to activate"
        : "Patched binary already installed; current-process activation is verified by the TUI",
      version: bin.version,
      binaryPath: bin.path,
      officialSha256: installed.officialSha,
      patchedSha256: patchedSha,
      patchedPath,
      renderersActive: false,
      compatibilityProfile: profile.profileVersion,
      compatibilityMode: profile.exact ? "exact" : "verified-source",
      logTail: "",
    })
    return { officialPath: bin.path, patchedPath, officialSha, patchedSha, installed }
  } finally {
    await fs.rm(lock, { force: true }).catch(() => {})
  }
}
