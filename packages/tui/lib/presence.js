// Durable cross-process session presence inference.
//
// OpenCode keeps live SessionStatus in the server process that owns the run.
// Another OpenCode process can still see persisted messages, so an unfinished
// assistant message (or a user message without a following assistant) is the
// authoritative fallback for displaying work started elsewhere.

export const DURABLE_BUSY_MAX_AGE_MS = 15 * 60 * 1000

function createdAt(message) {
  const info = message?.info ?? message
  const value = Number(info?.time?.created ?? 0)
  return Number.isFinite(value) ? value : 0
}

function activityAt(message) {
  const info = message?.info ?? message
  const values = [info?.time?.created, info?.time?.updated, info?.time?.completed].map(Number).filter(Number.isFinite)
  return values.length ? Math.max(...values) : 0
}

export function durableStatus(messages, options = {}) {
  const rows = Array.from(messages ?? []).filter(Boolean)
  if (!rows.length) return null
  const last = rows.toSorted((a, b) => createdAt(a) - createdAt(b)).at(-1)
  const info = last?.info ?? last
  if (!info || typeof info !== "object") return null
  const observedAt = activityAt(last)
  if (info.role === "assistant" && info.time?.completed) return { type: "idle", source: "transcript", observedAt }
  if (info.role !== "user" && info.role !== "assistant") return null

  // An unfinished persisted message is evidence of cross-process work only for
  // a bounded lease. Old crashes and abandoned drafts otherwise remain
  // unfinished forever and were being resurrected as "working" months later.
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now()
  const maxAgeMs = Number.isFinite(Number(options.maxAgeMs)) ? Math.max(0, Number(options.maxAgeMs)) : DURABLE_BUSY_MAX_AGE_MS
  const sessionUpdatedAt = Number(options.sessionUpdatedAt) || 0
  const lastActivity = Math.max(observedAt, sessionUpdatedAt)
  if (!lastActivity || now - lastActivity > maxAgeMs) return { type: "idle", source: "transcript-expired", observedAt: lastActivity }
  return { type: "busy", source: "transcript", observedAt: lastActivity }
}

const ACTIVE = new Set(["busy", "retry", "compacting"])
const EVENT_SOURCES = new Set(["live-event", "host-state", "shared-presence"])

/**
 * Reconcile independent status authorities.
 *
 * A completed latest transcript repairs stale SDK/cache busy state. Only a
 * genuinely newer producer event/lease may supersede that completion, which is
 * how a new turn starts without allowing old busy booleans to live forever.
 */
export function mergeStatus(live, durable) {
  const liveType = String(live?.type ?? live ?? "")
  const durableType = String(durable?.type ?? durable ?? "")
  if (ACTIVE.has(liveType)) {
    if (durableType === "idle") {
      const liveAt = Number(live?.observedAt ?? 0)
      const durableAt = Number(durable?.observedAt ?? 0)
      const source = String(live?.source ?? "")
      if (!EVENT_SOURCES.has(source) || !liveAt || liveAt <= durableAt) return durable
    }
    return typeof live === "object" ? live : { type: liveType, source: "live" }
  }
  return durable ?? (liveType ? (typeof live === "object" ? live : { type: liveType, source: "live" }) : { type: "idle" })
}
