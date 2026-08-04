import { promises as fs } from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"

export const STATUS_ORDER = [
  "idle",
  "dev-mode",
  "no-opencode",
  "unsupported-version",
  "detecting",
  "downloading",
  "extracting",
  "patching",
  "building",
  "built",
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
  return path.join(root, "runtime")
}

export function stateFile(root) {
  return path.join(runtimeDir(root), "selfpatch-state.json")
}

export function patchedBinaryPath(root, version) {
  const base = process.platform === "win32" ? `opencode-${version}.exe` : `opencode-${version}`
  return path.join(runtimeDir(root), "patched", base)
}

export async function readState(root) {
  try {
    const text = await fs.readFile(stateFile(root), "utf8")
    const parsed = JSON.parse(text)
    return { ...defaultState(), ...parsed }
  } catch {
    return defaultState()
  }
}

export async function writeState(root, state) {
  const file = stateFile(root)
  const dir = path.dirname(file)
  await fs.mkdir(dir, { recursive: true })
  const tmp = path.join(dir, `.selfpatch-state-${process.pid}.tmp`)
  const body = JSON.stringify({ ...defaultState(), ...state, updatedAt: new Date().toISOString() }, null, 2)
  await fs.writeFile(tmp, body, { encoding: "utf8", mode: 0o600 })
  await fs.rename(tmp, file)
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
