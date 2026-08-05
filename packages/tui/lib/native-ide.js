import path from "node:path"

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

export function sessionSnapshot(api, sessionID) {
  const diff = sessionID ? Array.from(api.state.session.diff(sessionID) ?? []) : []
  const todo = sessionID ? Array.from(api.state.session.todo(sessionID) ?? []) : []
  const status = sessionID ? api.state.session.status(sessionID) : undefined
  const lsp = Array.from(api.state.lsp?.() ?? [])
  const mcp = Array.from(api.state.mcp?.() ?? [])
  return {
    project: projectLabel(api.state.path?.directory || api.state.path?.worktree),
    directory: api.state.path?.directory || api.state.path?.worktree || "",
    branch: api.state.vcs?.branch || "",
    sessionCount: Number(api.state.session.count?.() ?? 0),
    status: status?.type || "idle",
    changedFiles: diff.length,
    additions: diff.reduce((sum, item) => sum + Number(item.additions ?? 0), 0),
    deletions: diff.reduce((sum, item) => sum + Number(item.deletions ?? 0), 0),
    activeTodos: todo.filter((item) => item.status !== "completed" && item.status !== "cancelled").length,
    completedTodos: todo.filter((item) => item.status === "completed").length,
    lspReady: lsp.filter((item) => item.status === "connected").length,
    lspTotal: lsp.length,
    mcpReady: mcp.filter((item) => item.status === "connected").length,
    mcpFailed: mcp.filter((item) => item.status === "failed").length,
    mcpTotal: mcp.length,
    files: diff.slice(0, 6),
    todos: todo.slice(0, 6),
  }
}

export function healthTone(snapshot) {
  if (snapshot.mcpFailed > 0) return "error"
  if (snapshot.status === "busy" || snapshot.status === "retry") return "active"
  if (snapshot.lspTotal > 0 && snapshot.lspReady < snapshot.lspTotal) return "warning"
  return "ready"
}

export function contextLine(snapshot) {
  return [
    snapshot.project,
    snapshot.branch ? ` ${snapshot.branch}` : null,
    snapshot.status === "busy" ? "working" : snapshot.status === "retry" ? "retrying" : null,
  ].filter(Boolean).join("  ·  ")
}
