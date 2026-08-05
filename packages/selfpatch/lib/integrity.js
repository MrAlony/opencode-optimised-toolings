// Dependency-tree integrity checks for the self-patch pipeline.
//
// A truncated or partially-written package install produces a build failure
// that names a missing relative import but never names the package, so the
// pipeline used to wedge forever behind an opaque error like:
//
//   error: Could not resolve: "./helpers/parseUtil.js"
//       at .../node_modules/.bun/zod@3.25.76/node_modules/zod/v3/external.js
//
// These helpers turn that class of failure into something the pipeline can
// detect, explain, and repair on its own. Parsing and path logic are pure so
// the diagnosis is verifiable without a broken install.

import { promises as fs } from "node:fs"
import path from "node:path"

const UNRESOLVED = /Could not resolve:\s*"([^"]+)"/g

/**
 * Extract unresolved-import failures from a build log.
 *
 * Bun prints the specifier and, on a following line, the importing file. The
 * two are paired by order because the file line always follows its error.
 */
export function parseUnresolvedImports(log) {
  const text = String(log ?? "")
  if (!text) return []
  const lines = text.split(/\r?\n/)
  const out = []
  for (let index = 0; index < lines.length; index += 1) {
    UNRESOLVED.lastIndex = 0
    const match = UNRESOLVED.exec(lines[index])
    if (!match) continue
    // The importing file appears on the next non-empty "at <path>" line.
    let file = ""
    for (let ahead = index + 1; ahead < Math.min(lines.length, index + 4); ahead += 1) {
      const at = /^\s*at\s+(.+?)(?::\d+:\d+)?\s*$/.exec(lines[ahead])
      if (at) {
        file = at[1].trim()
        break
      }
    }
    out.push({ specifier: match[1], file })
  }
  return out
}

/**
 * Resolve the installed package root that owns a file.
 *
 * Uses the last `node_modules` segment so a nested dependency resolves to the
 * nested package rather than its parent. Scoped names consume two segments.
 */
export function packageRootFromFile(file) {
  const normalized = String(file ?? "").replaceAll("\\", "/")
  if (!normalized) return null
  const marker = "/node_modules/"
  const index = normalized.lastIndexOf(marker)
  if (index < 0) return null
  const after = normalized.slice(index + marker.length)
  const parts = after.split("/").filter(Boolean)
  if (parts.length === 0) return null
  const take = parts[0].startsWith("@") ? 2 : 1
  if (parts.length < take) return null
  const name = parts.slice(0, take).join("/")
  return { name, dir: `${normalized.slice(0, index + marker.length)}${name}` }
}

/** Unique packages implicated by a failed build, most specific first. */
export function packagesFromBuildLog(log) {
  const seen = new Map()
  for (const failure of parseUnresolvedImports(log)) {
    const owner = packageRootFromFile(failure.file)
    if (!owner) continue
    const existing = seen.get(owner.dir)
    if (existing) {
      existing.missing.push(failure.specifier)
      continue
    }
    seen.set(owner.dir, { ...owner, missing: [failure.specifier] })
  }
  return [...seen.values()]
}

/** True when a build log shows the unresolved-import signature. */
export function looksLikeBrokenInstall(log) {
  return packagesFromBuildLog(log).length > 0
}

function addTarget(set, value) {
  if (typeof value !== "string") return
  if (!value.startsWith("./")) return
  // Only runtime entries; type declarations are not needed to build.
  if (!/\.(js|cjs|mjs)$/.test(value)) return
  if (value.includes("*")) return
  set.add(value)
}

function walkExports(node, set, depth = 0) {
  if (depth > 6 || node === null || node === undefined) return
  if (typeof node === "string") {
    addTarget(set, node)
    return
  }
  if (Array.isArray(node)) {
    for (const item of node) walkExports(item, set, depth + 1)
    return
  }
  if (typeof node === "object") {
    for (const value of Object.values(node)) walkExports(value, set, depth + 1)
  }
}

/**
 * Runtime entry files a package manifest promises to provide.
 *
 * Wildcard and type-only entries are skipped: they cannot be checked with a
 * simple existence test and are not what breaks a bundler build.
 */
export function entryTargets(manifest) {
  const set = new Set()
  if (!manifest || typeof manifest !== "object") return []
  addTarget(set, manifest.main)
  addTarget(set, manifest.module)
  walkExports(manifest.exports, set)
  return [...set]
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"))
  } catch {
    return null
  }
}

async function missingFrom(dir, targets) {
  const missing = []
  for (const target of targets) {
    const resolved = path.join(dir, target)
    try {
      await fs.access(resolved)
    } catch {
      missing.push(target)
    }
  }
  return missing
}

/**
 * Verify one installed package against its own manifest.
 *
 * A package that declares entry points it does not ship is treated as broken;
 * that is exactly the truncated-install signature.
 */
export async function verifyPackage(dir) {
  const manifest = await readJson(path.join(dir, "package.json"))
  if (!manifest) return { dir, ok: false, reason: "missing package.json", missing: [] }
  const targets = entryTargets(manifest)
  if (targets.length === 0) return { dir, ok: true, name: manifest.name, missing: [] }
  const missing = await missingFrom(dir, targets)
  return { dir, ok: missing.length === 0, name: manifest.name, missing }
}

/**
 * Verify a specific set of packages by directory.
 *
 * The pipeline uses this to confirm a repair actually worked instead of
 * trusting the installer's exit code.
 */
export async function verifyPackages(dirs) {
  const broken = []
  for (const dir of Array.from(dirs ?? [])) {
    const result = await verifyPackage(dir)
    if (!result.ok) broken.push(result)
  }
  return { ok: broken.length === 0, broken }
}

/**
 * Bun global-cache entries for a package name.
 *
 * A corrupt cache entry reproduces the same truncated install on every retry,
 * so repair has to clear the cache and not just the installed copy.
 */
export async function bunCacheEntries(cacheDir, name) {
  if (!cacheDir || !name) return []
  const scoped = name.startsWith("@")
  const base = scoped ? path.join(cacheDir, name.split("/")[0]) : cacheDir
  const leaf = scoped ? name.split("/")[1] : name
  let entries = []
  try {
    entries = await fs.readdir(base, { withFileTypes: true })
  } catch {
    return []
  }
  // Bun stores both `name` and `name@version@@@n` directories.
  return entries
    .filter((entry) => entry.name === leaf || entry.name.startsWith(`${leaf}@`))
    .map((entry) => path.join(base, entry.name))
}
