import { promises as fsPromises } from "node:fs"
import * as fsSync from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { runtimeRootForPackage } from "../../shared/paths.js"

export const customTools = [
  "alonix-edit",
  "alonix-read",
  "alonix-search",
  "alonix-explore",
  "alonix-shell",
  "alonix-background-process",
  "alonix-index-project",
  "alonix-index-context",
  "alonix-index-investigate",
  "alonix-index-memory",
  "alonix-web-search",
  "alonix-web-fetch",
  "alonix-stealth-fetch",
  "alonix-stealth-search",
  "alonix-stealth-rotate-tor",
  "alonix-stealth-status",
]

export function findRoot(startDir) {
  let dir = startDir
  for (let i = 0; i < 8; i++) {
    try {
      const pkg = JSON.parse(fsSync.readFileSync(path.join(dir, "package.json"), "utf8"))
      if (pkg.name === "opencode-optimised-toolings") return dir
    } catch {
      // keep climbing
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return startDir
}

export function rootFromModule(importMetaUrl) {
  return findRoot(path.dirname(fileURLToPath(importMetaUrl)))
}

export function statePathForRoot(root) {
  return path.join(runtimeRootForPackage(root), "selfpatch-state.json")
}

const WAITING_STATE = { status: "idle", stepLabel: "Waiting for the self-patch controller", progressPercent: 0, lastError: null, logTail: "" }

export const STALE_AFTER_MS = 2 * 60 * 1000

export function sanitizeToolingState(state, now = Date.now()) {
  if (!state || typeof state !== "object") return { ...WAITING_STATE }
  const value = state.updatedAt
  const timestamp = typeof value === "number" ? value : Date.parse(String(value ?? ""))
  const stale = Number.isFinite(timestamp) && now - timestamp > STALE_AFTER_MS
  const legacyRelativePathFailure =
    state.status === "error" &&
    !state.binaryPath &&
    !state.version &&
    /ENOENT[\s\S]*open ['"]opencode['"]/.test(String(state.lastError ?? ""))
  if (legacyRelativePathFailure || (stale && ["idle", "dev-mode", "no-opencode", "error"].includes(state.status))) {
    return {
      ...WAITING_STATE,
      status: "idle",
      stepLabel: "Refreshing OpenCode enhancement status",
      updatedAt: state.updatedAt,
    }
  }
  return state
}

export function readStateSync(file) {
  try {
    return sanitizeToolingState(JSON.parse(fsSync.readFileSync(file, "utf8")))
  } catch {
    return { ...WAITING_STATE }
  }
}

export async function readStateFile(file) {
  try {
    return sanitizeToolingState(JSON.parse(await fsPromises.readFile(file, "utf8")))
  } catch {
    return { ...WAITING_STATE }
  }
}

export function isStale(state, now = Date.now()) {
  const value = state?.updatedAt
  const timestamp = typeof value === "number" ? value : Date.parse(String(value ?? ""))
  if (!Number.isFinite(timestamp)) return false
  return now - timestamp > STALE_AFTER_MS
}

/**
 * Describe the tooling state for the UI.
 *
 * `renderersRegistered` is direct runtime evidence: renderers can only register
 * through the patched core's registry, so a positive count proves the patched
 * binary is the one currently running. That outranks the state file, which is
 * written by a different process and can legitimately be stale or describe a
 * dev host. Without this the UI could claim self-patching is "not applicable"
 * while simultaneously reporting 16/16 active renderers.
 */
export function indicatorFor(state, evidence = {}) {
  const renderersRegistered = Number(evidence.renderersRegistered ?? 0) > 0
  if (renderersRegistered && state?.status !== "built") {
    return state?.status === "error"
      ? { level: "warn", text: "Patched binary active", detail: "Rich renderers are active; a later background maintenance check failed" }
      : { level: "ok", text: "Patched binary active", detail: "Rich tool renderers active" }
  }
  if (isStale(state) && ["idle", "dev-mode", "no-opencode", "error"].includes(state?.status)) {
    return { level: "info", text: "Tooling self-patch: checking…", detail: "No fresh status record from the running OpenCode process yet" }
  }
  switch (state?.status) {
    case "ok":
      return { level: "ok", text: "Patched binary active", detail: "Rich tool renderers active" }
    case "idle":
      return { level: "info", text: "Tooling self-patch pending" }
    case "dev-mode":
      return {
        level: "info",
        text: "Self-patch paused: dev runtime",
        detail: "OpenCode is being hosted by node/bun, so the binary is left untouched",
      }
    case "no-opencode":
      return {
        level: "warn",
        text: "No OpenCode binary found to patch",
        detail: "Rich renderers stay inactive until an OpenCode binary is detected",
      }
    case "portable":
    case "unsupported-version":
      return {
        level: "ok",
        text: `Plugin active on OpenCode v${state.version ?? "?"}`,
        detail: "Portable IDE features are available; optional host enhancements were safely skipped",
      }
    case "error":
      return { level: "error", text: state.lastError ?? "Tooling self-patch failed" }
    case "built":
      return {
        level: "info",
        text: "Patched binary installed — restart OpenCode to activate",
        detail: "Running instances keep the original binary until you restart",
      }
    case "restarting":
    case "swapping":
      return { level: "info", text: "Restart OpenCode to activate the patched binary" }
    default:
      return { level: "warn", text: `${state?.stepLabel ?? state?.status ?? "unknown"}${state?.progressPercent ? ` (${state.progressPercent}%)` : ""}` }
  }
}

export function toastForTransition(prev, next) {
  if (!prev) return null
  if (next?.status === "built" && prev?.status !== "built") {
    return { variant: "info", title: "OpenCode patched", message: "Patched binary installed — restart OpenCode to activate rich tool renderers." }
  }
  if (next?.status === "ok" && prev?.status === "built") {
    return { variant: "success", title: "Tooling active", message: "Patched binary loaded — rich renderers enabled for all custom tools." }
  }
  if (next?.status === "error" && prev?.status !== "error") {
    return { variant: "error", title: "Self-patch failed", message: next.lastError ?? "Check the alonix-toolings status for details." }
  }
  return null
}

export function formatStateLog(state) {
  const s = state ?? {}
  const lines = [
    `Status: ${s.status}`,
    `OpenCode version: ${s.version ?? "unknown"}`,
    `Plugin active: yes`,
    `Optional host enhancements: ${s.renderersActive ? "active" : "inactive; portable mode remains available"}`,
    s.compatibilityProfile ? `Compatibility profile: v${s.compatibilityProfile} (${s.compatibilityMode ?? "verified"})` : null,
    s.progressPercent > 0 ? `Progress: ${s.progressPercent}% — ${s.stepLabel}` : `Step: ${s.stepLabel}`,
    s.patchedSha256 ? `Patched SHA-256: ${s.patchedSha256.slice(0, 12)}` : null,
    s.lastError ? `Last error: ${s.lastError}` : null,
  ]
    .filter(Boolean)
    .join("\n")
  return s.logTail ? `${lines}\n\nRecent build output:\n${s.logTail}` : lines
}
