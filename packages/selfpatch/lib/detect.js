import { spawnSync } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import path from "node:path"

const DEV_NAMES = new Set(["node", "node.exe", "bun", "bun.exe", "deno", "deno.exe"])

export function isDevRuntime(execPath) {
  const base = path.basename(execPath || "").toLowerCase()
  return DEV_NAMES.has(base)
}

export function versionOf(bin) {
  const res = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 10_000, windowsHide: true })
  if (res.error || res.status !== 0) return null
  const text = `${res.stdout ?? ""} ${res.stderr ?? ""}`
  const match = text.match(/(\d+\.\d+\.\d+)/)
  return match ? { version: match[1] } : null
}

function isFile(file) {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

/**
 * Resolve an npm global shim to the real executable it launches.
 *
 * On Windows, `opencode` on PATH is a `.cmd`/`.ps1` shim. Node refuses to spawn
 * `.cmd` files without a shell (EINVAL), and spawning through a shell to probe
 * a version is neither necessary nor safe here, so the shipped binary inside
 * the npm package is located directly instead.
 */
function resolveNpmShim(directory) {
  const candidates = [
    path.join(directory, "node_modules", "opencode-ai", "bin", "opencode.exe"),
    path.join(directory, "node_modules", "opencode-ai", "bin", "opencode"),
    path.join(directory, "..", "lib", "node_modules", "opencode-ai", "bin", "opencode"),
  ]
  for (const candidate of candidates) {
    if (isFile(candidate)) return path.resolve(candidate)
  }
  return null
}

/**
 * Find a directly spawnable OpenCode executable on PATH.
 *
 * Only real executables are returned; shims are resolved to the binary they
 * wrap. This avoids depending on shell execution, which differs across
 * platforms and is blocked for `.cmd` targets on current Node versions.
 */
export function resolveOnPath(env = process.env) {
  const separator = process.platform === "win32" ? ";" : ":"
  const directories = String(env.PATH ?? env.Path ?? "")
    .split(separator)
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter(Boolean)
  const direct = process.platform === "win32" ? ["opencode.exe", "opencode.com"] : ["opencode"]
  const shims = process.platform === "win32" ? ["opencode.cmd", "opencode.ps1", "opencode"] : []

  for (const directory of directories) {
    for (const name of direct) {
      const candidate = path.join(directory, name)
      if (isFile(candidate)) return path.resolve(candidate)
    }
    // A shim proves OpenCode is installed here even though it cannot be spawned
    // directly; resolve it to the packaged executable.
    for (const name of shims) {
      if (!isFile(path.join(directory, name))) continue
      const resolved = resolveNpmShim(directory)
      if (resolved) return resolved
    }
  }
  return null
}

/**
 * Resolve the OpenCode binary to inspect.
 *
 * `process.execPath` is the plugin's own host, which is the OpenCode binary in
 * normal use but a node/bun executable when the plugin is loaded by a dev
 * runtime. A dev host does not mean there is nothing to patch, so it is kept
 * only as a fallback while a real OpenCode binary is searched for. `devMode` is
 * therefore reported only when no genuine OpenCode binary exists, which keeps
 * development runs from patching without falsely reporting a working
 * installation as unpatchable.
 */
export function detectBinary(overrides = {}) {
  const candidates = []
  if (overrides.bin) candidates.push(overrides.bin)
  if (process.env.OPENCODE_TOOLINGS_BIN) candidates.push(process.env.OPENCODE_TOOLINGS_BIN)
  if (process.execPath) candidates.push(process.execPath)
  const onPath = resolveOnPath()
  if (onPath) candidates.push(onPath)

  let devFallback = null
  for (const candidate of candidates) {
    try {
      const probe = path.resolve(candidate)
      if (!existsSync(probe)) continue
      const info = versionOf(probe)
      if (!info) continue
      if (!isDevRuntime(probe)) return { path: path.resolve(probe), version: info.version, devMode: false }
      if (!devFallback) devFallback = { path: path.resolve(probe), version: info.version, devMode: true }
    } catch {
      // try the next candidate
    }
  }
  return devFallback
}
