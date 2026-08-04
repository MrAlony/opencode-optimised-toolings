import { promises as fsPromises } from "node:fs"
import * as fsSync from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const customTools = [
  "fs_edit_many",
  "fs_read_many",
  "fs_search",
  "fs_explore",
  "shell",
  "background_process",
  "cbm_project",
  "cbm_context",
  "cbm_investigate",
  "cbm_memory",
  "web_search",
  "web_fetch_many",
  "stealth_fetch_many",
  "stealth_search_many",
  "stealth_rotate_tor",
  "stealth_status",
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
  return path.join(root, "runtime", "selfpatch-state.json")
}

export function readStateSync(file) {
  try {
    return JSON.parse(fsSync.readFileSync(file, "utf8"))
  } catch {
    return { status: "idle", stepLabel: "Waiting for the self-patch controller", progressPercent: 0, lastError: null, logTail: "" }
  }
}

export async function readStateFile(file) {
  try {
    return JSON.parse(await fsPromises.readFile(file, "utf8"))
  } catch {
    return { status: "idle", stepLabel: "Waiting for the self-patch controller", progressPercent: 0, lastError: null, logTail: "" }
  }
}

export function indicatorFor(state) {
  switch (state?.status) {
    case "ok":
      return { level: "hidden", text: "Patched binary active" }
    case "idle":
      return { level: "info", text: "Tooling self-patch pending" }
    case "dev-mode":
    case "no-opencode":
      return { level: "info", text: "Tooling self-patch: not applicable" }
    case "unsupported-version":
      return { level: "warn", text: `Tooling patch not available for OpenCode v${state.version ?? "?"}` }
    case "error":
      return { level: "error", text: state.lastError ?? "Tooling self-patch failed" }
    case "built":
      return { level: "info", text: "Patched binary ready — OpenCode restarts automatically" }
    case "restarting":
    case "swapping":
      return { level: "info", text: "Swapping binaries and restarting OpenCode — session will resume" }
    default:
      return { level: "warn", text: `${state?.stepLabel ?? state?.status ?? "unknown"}${state?.progressPercent ? ` (${state.progressPercent}%)` : ""}` }
  }
}

export function toastForTransition(prev, next) {
  if (!prev) return null
  if (next?.status === "built") {
    return { variant: "info", title: "Patched binary ready", message: "OpenCode restarts automatically in a few seconds to activate rich tool renderers." }
  }
  if (next?.status === "restarting") {
    return { variant: "info", title: "Restarting OpenCode", message: "Your session resumes automatically with the patched binary." }
  }
  if (next?.status === "ok" && ["built", "restarting", "swapping"].includes(prev?.status)) {
    return { variant: "success", title: "Tooling active", message: "Patched binary loaded — rich renderers enabled for all custom tools." }
  }
  if (next?.status === "error" && prev?.status !== "error") {
    return { variant: "error", title: "Self-patch failed", message: next.lastError ?? "Check the toolings status for details." }
  }
  return null
}

export function formatStateLog(state) {
  const s = state ?? {}
  const lines = [
    `Status: ${s.status}`,
    `OpenCode version: ${s.version ?? "unknown"}`,
    `Patched binary active: ${s.status === "ok" ? "yes" : "no"}`,
    `Rich tool renderers: ${s.renderersActive ? "active" : "inactive (needs the patched binary)"}`,
    s.progressPercent > 0 ? `Progress: ${s.progressPercent}% — ${s.stepLabel}` : `Step: ${s.stepLabel}`,
    s.patchedSha256 ? `Patched SHA-256: ${s.patchedSha256.slice(0, 12)}` : null,
    s.lastError ? `Last error: ${s.lastError}` : null,
  ]
    .filter(Boolean)
    .join("\n")
  return s.logTail ? `${lines}\n\nRecent build output:\n${s.logTail}` : lines
}
