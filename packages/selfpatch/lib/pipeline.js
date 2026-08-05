import { promises as fs } from "node:fs"
import { spawn, spawnSync } from "node:child_process"
import path from "node:path"
import { createHash } from "node:crypto"
import { pathToFileURL } from "node:url"
import { patchedBinaryPath, readState, sha256File, writeState } from "./state.js"
import { detectBinary } from "./detect.js"
import { installPatchedBinary } from "./restart.js"

export const OPENCODE_VERSION = "1.18.13"
export const BUN_VERSION = "1.3.14"

export function UPSTREAM_ARCHIVE(version) {
  return `https://github.com/anomalyco/opencode/archive/refs/tags/v${version}.tar.gz`
}

export function manifestFileFor(root, version) {
  return path.join(root, "packages", "selfpatch", "patches", version, "manifest.mjs")
}

export function sourceDir(root, version) {
  return path.join(root, "runtime", "src", `opencode-${version}`)
}

export function cacheTarball(root, version) {
  return path.join(root, "runtime", "cache", `opencode-v${version}.tar.gz`)
}

export function lockFile(root) {
  return path.join(root, "runtime", "pipeline.lock")
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
    const occurrences = current.split(item.search).length - 1
    if (occurrences !== count) {
      throw new Error(
        `patch step ${JSON.stringify(item.name ?? item.search.slice(0, 60))} expected ${count} occurrence(s), found ${occurrences}`
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
      if (entry.beforeSha256) {
        const sha = await sha256File(file)
        if (sha !== entry.beforeSha256) {
          throw new Error(`create target ${entry.path} unexpected: sha ${sha}`)
        }
      } else {
        throw new Error(`create target ${entry.path} already exists; refusing to overwrite`)
      }
    }
    staged.push({ file, content: entry.content })
  }
  for (const entry of manifest.files ?? []) {
    const file = path.join(sourceRoot, entry.path)
    const sha = await sha256File(file)
    if (sha !== entry.beforeSha256) {
      throw new Error(
        `patch target ${entry.path} fingerprint mismatch: expected ${entry.beforeSha256}, got ${sha}. ` +
          `The extracted source differs from the expected release; refusing to patch blindly.`
      )
    }
    staged.push({ file, content: await patchFileContent(file, entry.replacements) })
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

export async function ensureSource(root, version) {
  const dir = sourceDir(root, version)
  if (await exists(dir)) return dir
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
    ["@oven", "bun-windows-x64", "bun.exe"],
    ["@oven", "bun-linux-x64", "bun"],
    ["@oven", "bun-darwin-arm64", "bun"],
    ["@oven", "bun-darwin-x64", "bun"],
    ["@oven", "bun-linux-arm64", "bun"],
  ].map((parts) => path.join(base, ...parts))
}

export async function resolveBun(root) {
  if (process.env.OPENCODE_TOOLINGS_BUN) {
    return { command: process.env.OPENCODE_TOOLINGS_BUN, prefixArgs: [], source: "env" }
  }
  for (const candidate of bunCandidates(root)) {
    if (await exists(candidate)) return { command: candidate, prefixArgs: [], source: "workspace" }
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
export async function installSourceDeps(sourceRoot, root, onLog) {
  const okMarker = path.join(sourceRoot, "node_modules", ".alonix-toolings-install-ok")
  if (await exists(okMarker)) return
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
  if (code !== 0) throw new Error(`build failed with exit code ${code}\n${tail.slice(-1500)}`)
  const binary = await findBuiltBinary(sourceRoot)
  if (!binary) throw new Error("build completed but no binary was found under packages/opencode/dist")
  return binary
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
    const bin = detectBinary()
    if (!bin) {
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
    const manifestFile = manifestFileFor(root, bin.version)
    if (!(await exists(manifestFile))) {
      await writeState(root, {
        status: "unsupported-version",
        version: bin.version,
        binaryPath: bin.path,
        officialSha256: officialSha,
        stepLabel: `No bundled patch manifest for OpenCode v${bin.version}; running the official binary until a patch set is added`,
      })
      return null
    }
    const manifestModule = await import(pathToFileURL(manifestFile).href)
    const manifest = manifestModule.manifest
    const manifestSha = await manifestSha256(manifest)
    const sourceRootForMarker = sourceDir(root, bin.version)
    const sourceMarker = await readPatchMarker(sourceRootForMarker)
    const artifactMarker = await readPatchedArtifactMarker(root, bin.version)
    if (await exists(patchedPath)) {
      const patchedSha = await sha256File(patchedPath)
      if (patchedSha === officialSha && artifactMarker?.manifestSha256 === manifestSha && artifactMarker?.binarySha256 === patchedSha) {
        await writeState(root, {
          status: "ok",
          version: bin.version,
          binaryPath: bin.path,
          officialSha256: officialSha,
          patchedSha256: patchedSha,
          patchedPath,
          renderersActive: true,
          stepLabel: "Patched binary active with the current rich-renderer manifest",
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
          status: "built",
          progressPercent: 100,
          stepLabel: "Patched binary installed — restart OpenCode to activate",
          version: bin.version,
          binaryPath: bin.path,
          officialSha256: officialSha,
          patchedSha256: patchedSha,
          patchedPath,
          renderersActive: false,
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
      progressPercent: 5,
      stepLabel: "Downloading source for the exact OpenCode version",
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
        JSON.stringify({ version: bin.version, manifestSha256: manifestSha }, null, 2),
        "utf8"
      )
    }

    await writeState(root, { status: "installing", progressPercent: 35, stepLabel: "Installing OpenCode build dependencies (first run only; takes a few minutes)" })
    await installSourceDeps(sourceRoot, root, (tail) => {
      void writeState(root, { status: "installing", progressPercent: 38, stepLabel: "Installing OpenCode build dependencies", logTail: tail }).catch(() => {})
    })
    await writeState(root, { status: "building", progressPercent: 40, stepLabel: "Rebuilding OpenCode (first run takes a few minutes)" })
    const binary = await buildPatched(sourceRoot, root, bin.version, (tail) => {
      void writeState(root, { status: "building", progressPercent: 45, stepLabel: "Rebuilding OpenCode", logTail: tail }).catch(() => {})
    })
    const patchedSha = await sha256File(binary)
    await fs.mkdir(path.dirname(patchedPath), { recursive: true })
    await fs.copyFile(binary, patchedPath)
    await fs.writeFile(
      patchedArtifactMarkerFile(root, bin.version),
      JSON.stringify({ version: bin.version, manifestSha256: manifestSha, binarySha256: patchedSha }, null, 2),
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
      status: "built",
      progressPercent: 100,
      stepLabel: "Patched binary installed — restart OpenCode to activate",
      version: bin.version,
      binaryPath: bin.path,
      officialSha256: officialSha,
      patchedSha256: patchedSha,
      patchedPath,
      renderersActive: false,
      logTail: "",
    })
    return { officialPath: bin.path, patchedPath, officialSha, patchedSha, installed }
  } finally {
    await fs.rm(lock, { force: true }).catch(() => {})
  }
}
