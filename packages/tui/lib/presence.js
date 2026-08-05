// Durable cross-process session presence inference.
//
// OpenCode keeps live SessionStatus in the server process that owns the run.
// Another OpenCode process can still see persisted messages, so an unfinished
// assistant message (or a user message without a following assistant) is the
// authoritative fallback for displaying work started elsewhere.

function timestamp(message) {
  const info = message?.info ?? message
  const value = Number(info?.time?.created ?? info?.time?.updated ?? 0)
  return Number.isFinite(value) ? value : 0
}

export function durableStatus(messages) {
  const rows = Array.from(messages ?? []).filter(Boolean)
  if (!rows.length) return null
  const last = rows.toSorted((a, b) => timestamp(a) - timestamp(b)).at(-1)
  const info = last?.info ?? last
  if (!info || typeof info !== "object") return null
  if (info.role === "user") return { type: "busy", source: "transcript" }
  if (info.role === "assistant") {
    return info.time?.completed
      ? { type: "idle", source: "transcript" }
      : { type: "busy", source: "transcript" }
  }
  return null
}

export function mergeStatus(live, durable) {
  const liveType = String(live?.type ?? live ?? "")
  if (liveType === "busy" || liveType === "retry" || liveType === "compacting") {
    return typeof live === "object" ? live : { type: liveType, source: "live" }
  }
  return durable ?? (liveType ? (typeof live === "object" ? live : { type: liveType, source: "live" }) : { type: "idle" })
}
