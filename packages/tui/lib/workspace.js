// Workspace intelligence for the Alonix IDE.
//
// Reads the host's reactive state and derives everything the IDE surfaces need.
// All accessors are defensive: the TUI API is only fully populated once sync
// completes, and plugin surfaces render before that.

import path from "node:path"

function list(value) {
  try {
    const result = typeof value === "function" ? value() : value
    return Array.isArray(result) ? result : Array.from(result ?? [])
  } catch {
    return []
  }
}

function safe(fn, fallback) {
  try {
    const value = fn()
    return value === undefined || value === null ? fallback : value
  } catch {
    return fallback
  }
}

export function projectLabel(directory) {
  const value = String(directory ?? "").trim()
  if (!value) return "workspace"
  return path.basename(value) || value
}

export function compactPath(value, max = 46) {
  const text = String(value ?? "").replaceAll("\\", "/")
  if (text.length <= max) return text
  const tail = Math.max(8, Math.floor(max * 0.58))
  return `…/${text.slice(-tail).replace(/^\/+/, "")}`
}

/** Split a path into `{ dir, name }` so the explorer can dim the directory. */
export function splitPath(value, max = 34) {
  const text = String(value ?? "").replaceAll("\\", "/")
  const index = text.lastIndexOf("/")
  const name = index >= 0 ? text.slice(index + 1) : text
  const dir = index >= 0 ? text.slice(0, index) : ""
  const room = Math.max(4, max - name.length - 1)
  return { name, dir: dir ? compactPath(dir, room) : "" }
}

export function fileKind(file) {
  const name = String(file ?? "")
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase()
  if (["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(ext)) return "code"
  if (["json", "yml", "yaml", "toml", "ini", "env"].includes(ext)) return "config"
  if (["md", "mdx", "txt", "rst"].includes(ext)) return "doc"
  if (["css", "scss", "less"].includes(ext)) return "style"
  if (["png", "jpg", "jpeg", "gif", "svg", "webp", "ico"].includes(ext)) return "asset"
  if (["test", "spec"].some((marker) => name.includes(`.${marker}.`))) return "test"
  return "file"
}

/** Aggregate token/cost usage from the session's assistant messages. */
export function contextUsage(api, sessionID) {
  if (!sessionID) return { tokens: 0, percent: null, cost: 0, model: "", provider: "" }
  const messages = list(() => api?.state?.session?.messages?.(sessionID))
  const session = safe(() => api?.state?.session?.get?.(sessionID), undefined)
  const cost = Number(session?.cost ?? 0)
  const last = [...messages]
    .reverse()
    .find((item) => item?.role === "assistant" && Number(item?.tokens?.output ?? 0) > 0)
  if (!last) return { tokens: 0, percent: null, cost, model: "", provider: "" }
  const tokens =
    Number(last.tokens?.input ?? 0) +
    Number(last.tokens?.output ?? 0) +
    Number(last.tokens?.reasoning ?? 0) +
    Number(last.tokens?.cache?.read ?? 0) +
    Number(last.tokens?.cache?.write ?? 0)
  const providers = list(() => api?.state?.provider)
  const model = providers.find((item) => item?.id === last.providerID)?.models?.[last.modelID]
  const limit = Number(model?.limit?.context ?? 0)
  return {
    tokens,
    percent: limit > 0 ? Math.min(100, Math.round((tokens / limit) * 100)) : null,
    cost,
    model: String(last.modelID ?? ""),
    provider: String(last.providerID ?? ""),
  }
}

/**
 * Complete presentation snapshot for a session (or the workspace when no
 * session is active). Pure with respect to the API: it only reads.
 */
export function workspaceSnapshot(api, sessionID) {
  const diff = sessionID ? list(() => api?.state?.session?.diff?.(sessionID)) : []
  const todo = sessionID ? list(() => api?.state?.session?.todo?.(sessionID)) : []
  const status = sessionID ? safe(() => api?.state?.session?.status?.(sessionID), undefined) : undefined
  const permissions = sessionID ? list(() => api?.state?.session?.permission?.(sessionID)) : []
  const questions = sessionID ? list(() => api?.state?.session?.question?.(sessionID)) : []
  const lsp = list(() => api?.state?.lsp?.())
  const mcp = list(() => api?.state?.mcp?.())
  const directory = safe(() => api?.state?.path?.directory, "") || safe(() => api?.state?.path?.worktree, "") || ""
  const session = sessionID ? safe(() => api?.state?.session?.get?.(sessionID), undefined) : undefined

  const additions = diff.reduce((sum, item) => sum + (Number(item?.additions) || 0), 0)
  const deletions = diff.reduce((sum, item) => sum + (Number(item?.deletions) || 0), 0)
  const activeTodos = todo.filter((item) => item?.status !== "completed" && item?.status !== "cancelled")
  const completedTodos = todo.filter((item) => item?.status === "completed")
  const mcpFailed = mcp.filter((item) => item?.status === "failed")

  return {
    sessionID: sessionID ?? null,
    sessionTitle: String(session?.title ?? ""),
    project: projectLabel(directory),
    directory,
    branch: safe(() => api?.state?.vcs?.branch, "") || "",
    defaultBranch: safe(() => api?.state?.vcs?.default_branch, "") || "",
    ready: safe(() => api?.state?.ready === true, false),
    version: safe(() => api?.app?.version, "") || "",
    theme: safe(() => api?.theme?.selected, "") || "",
    sessionCount: Number(safe(() => api?.state?.session?.count?.(), 0)) || 0,
    status: String(status?.type ?? "idle"),
    busy: status?.type === "busy" || status?.type === "retry",
    changedFiles: diff.length,
    additions,
    deletions,
    files: diff.slice(0, 40),
    todos: todo,
    activeTodos: activeTodos.length,
    completedTodos: completedTodos.length,
    currentTodo: activeTodos.find((item) => item?.status === "in_progress") ?? activeTodos[0] ?? null,
    permissions: permissions.length,
    questions: questions.length,
    attention: permissions.length + questions.length,
    lspReady: lsp.filter((item) => item?.status === "connected").length,
    lspTotal: lsp.length,
    lsp,
    mcpReady: mcp.filter((item) => item?.status === "connected").length,
    mcpFailed: mcpFailed.length,
    mcpTotal: mcp.length,
    mcp,
    context: contextUsage(api, sessionID),
  }
}

/**
 * Overall workbench health. Attention (permissions/questions) outranks
 * failures because it blocks the user, not just the tooling.
 */
export function healthTone(snapshot) {
  if (!snapshot) return "neutral"
  if (snapshot.attention > 0) return "warning"
  if (snapshot.mcpFailed > 0) return "error"
  if (snapshot.busy) return "accent"
  if (snapshot.lspTotal > 0 && snapshot.lspReady < snapshot.lspTotal) return "warning"
  return "success"
}

export function healthLabel(snapshot) {
  if (!snapshot) return "starting"
  if (snapshot.attention > 0) return snapshot.permissions > 0 ? "needs approval" : "needs an answer"
  if (snapshot.mcpFailed > 0) return "mcp failure"
  if (snapshot.status === "retry") return "retrying"
  if (snapshot.busy) return "working"
  if (!snapshot.ready) return "syncing"
  return "ready"
}

/** One-line workspace identity used in prompt and header chrome. */
export function contextLine(snapshot) {
  if (!snapshot) return ""
  return [
    snapshot.project,
    snapshot.branch ? `⑂ ${snapshot.branch}` : null,
    snapshot.changedFiles ? `±${snapshot.changedFiles}` : null,
    healthLabel(snapshot) === "ready" ? null : healthLabel(snapshot),
  ]
    .filter(Boolean)
    .join("  ·  ")
}

/** Compact metric tiles for the home deck and workbench header. */
export function workspaceMetrics(snapshot) {
  if (!snapshot) return []
  return [
    { key: "sessions", label: "sessions", value: snapshot.sessionCount, tone: "accent" },
    {
      key: "files",
      label: "changed",
      value: snapshot.changedFiles,
      tone: snapshot.changedFiles ? "warning" : "neutral",
    },
    { key: "added", label: "added", value: `+${snapshot.additions}`, tone: "success" },
    { key: "removed", label: "removed", value: `-${snapshot.deletions}`, tone: "error" },
    {
      key: "lsp",
      label: "lsp",
      value: `${snapshot.lspReady}/${snapshot.lspTotal}`,
      tone: snapshot.lspTotal && snapshot.lspReady < snapshot.lspTotal ? "warning" : "success",
    },
    {
      key: "mcp",
      label: "mcp",
      value: `${snapshot.mcpReady}/${snapshot.mcpTotal}`,
      tone: snapshot.mcpFailed ? "error" : "success",
    },
  ]
}
