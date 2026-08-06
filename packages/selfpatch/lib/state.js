import { promises as fs } from "node:fs"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { runtimeRootForPackage } from "../../shared/paths.js"

export const STATUS_ORDER = [
  "idle",
  "dev-mode",
  "no-opencode",
  "portable",
  "unsupported-version",
  "detecting",
  "downloading",
  "extracting",
  "patching",
  "building",
  "built",
  "installed",
  "swapping",
  "restarting",
  "ok",
  "error",
]

export function defaultState() {
  return {
    version: null,
    binaryPath: null,
    officialSha256: null,
    patchedSha256: null,
    patchedPath: null,
    compatibilityProfile: null,
    compatibilityMode: null,
    status: "idle",
    progressPercent: 0,
    stepLabel: "Not started",
    logTail: "",
    lastError: null,
    renderersActive: false,
    updatedAt: null,
  }
}

export function runtimeDir(root) {
  return runtimeRootForPackage(root)
}

export function stateFile(root) {
  return path.join(runtimeDir(root), "selfpatch-state.json")
}

export function patchedBinaryPath(root, version) {
  const base = process.platform === "win32" ? `opencode-${version}.exe` : `opencode-${version}`
  return path.join(runtimeDir(root), "patched", base)
}

export const STATE_STALE_AFTER_MS = 10 * 60 * 1000

export function sanitizeStoredState(state, now = Date.now()) {
  const merged = { ...defaultState(), ...(state && typeof state === "object" ? state : {}) }
  const timestamp = typeof merged.updatedAt === "number" ? merged.updatedAt : Date.parse(String(merged.updatedAt ?? ""))
  const stale = Number.isFinite(timestamp) && now - timestamp > STATE_STALE_AFTER_MS
  const legacyRelativePathFailure =
    merged.status === "error" &&
    !merged.binaryPath &&
    !merged.version &&
    /ENOENT[\s\S]*open ['"]opencode['"]/.test(String(merged.lastError ?? ""))
  if (legacyRelativePathFailure || (stale && ["idle", "dev-mode", "no-opencode", "error"].includes(merged.status))) {
    return {
      ...defaultState(),
      status: "idle",
      stepLabel: "Refreshing OpenCode enhancement status",
      updatedAt: merged.updatedAt,
    }
  }
  return merged
}

export async function readState(root) {
  try {
    const text = await fs.readFile(stateFile(root), "utf8")
    return sanitizeStoredState(JSON.parse(text))
  } catch {
    return defaultState()
  }
}

/**
 * Persist progress state atomically.
 *
 * The write is a temp file plus a rename so a reader never observes a partial
 * document. Both steps can still fail for reasons that have nothing to do with
 * patching: the runtime directory can be removed by a concurrent clean, a
 * previous crash can leave a stale temp file, and antivirus can briefly lock a
 * freshly written file on Windows.
 *
 * State is progress reporting, not the patch itself, so a failure here must not
 * surface as "Self-patch failed". Each attempt recreates the directory, uses a
 * unique temp name, and falls back to a direct write; if it still fails the
 * error is swallowed and reported through the return value.
 */
export async function writeState(root, state) {
  const file = stateFile(root)
  const dir = path.dirname(file)
  const body = JSON.stringify({ ...defaultState(), ...state, updatedAt: new Date().toISOString() }, null, 2)

  let lastError = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    // Recreate on every attempt: the directory may have been removed since the
    // last one, which is exactly the ENOENT-on-rename failure.
    try {
      await fs.mkdir(dir, { recursive: true })
    } catch (error) {
      lastError = error
      continue
    }

    // A unique suffix keeps concurrent writers, and stale temp files from a
    // previous crash, from colliding.
    const tmp = path.join(dir, `.selfpatch-state-${process.pid}-${randomUUID()}-${attempt}.tmp`)
    try {
      await fs.writeFile(tmp, body, { encoding: "utf8", mode: 0o600 })
      await fs.rename(tmp, file)
      return true
    } catch (error) {
      lastError = error
      await fs.rm(tmp, { force: true }).catch(() => {})
    }
  }

  // Last resort: a non-atomic write still beats losing the status entirely.
  try {
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(file, body, { encoding: "utf8", mode: 0o600 })
    return true
  } catch (error) {
    lastError = error
  }

  void lastError
  return false
}

export async function sha256File(file) {
  const hash = createHash("sha256")
  const handle = await fs.open(file, "r")
  try {
    const buffer = Buffer.alloc(1024 * 1024)
    let bytesRead = 0
    do {
      const result = await handle.read(buffer, 0, buffer.length, null)
      // FileHandle.read resolves to a number on some runtimes and to
      // { bytesRead, buffer } on others; normalize defensively.
      bytesRead = typeof result === "number" ? result : result.bytesRead
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead))
    } while (bytesRead > 0)
  } finally {
    await handle.close()
  }
  return hash.digest("hex")
}

export function shortSha(sha) {
  return sha ? sha.slice(0, 12) : null
}

export function stateSummary(state) {
  const lines = [
    `Status: ${state.status}`,
    `OpenCode version: ${state.version ?? "unknown"}`,
    `Binary: ${state.binaryPath ?? "unknown"}`,
  ]
  if (state.officialSha256) lines.push(`Official SHA-256: ${shortSha(state.officialSha256)}`)
  if (state.patchedSha256) lines.push(`Patched SHA-256: ${shortSha(state.patchedSha256)}`)
  if (state.progressPercent > 0) lines.push(`Progress: ${state.progressPercent}% — ${state.stepLabel}`)
  else if (state.stepLabel) lines.push(`Step: ${state.stepLabel}`)
  if (state.lastError) lines.push(`Last error: ${state.lastError}`)
  if (state.logTail) lines.push(`Recent build output:\n${state.logTail}`)
  return lines.join("\n")
}
