// Session intelligence for the Alonix IDE.
//
// Session switching is the primary interaction of the workbench, so ranking,
// grouping, matching, and labelling are pure functions that can be verified
// independently of the renderer.

const DAY_MS = 24 * 60 * 60 * 1000

const DEFAULT_TITLE = /^(New session - |Child session - )\d{4}-\d{2}-\d{2}T/

/** OpenCode names untitled sessions with a timestamp; treat those as unnamed. */
export function isDefaultTitle(title) {
  return DEFAULT_TITLE.test(String(title ?? ""))
}

export function sessionTitle(session) {
  const title = String(session?.title ?? "").trim()
  if (!title || isDefaultTitle(title)) return "Untitled session"
  return title
}

function updatedAt(session) {
  const value = session?.time?.updated ?? session?.time?.created ?? 0
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : 0
}

/** Compact, human relative time ("now", "12m", "3h", "2d", "5w"). */
export function relativeTime(timestamp, now = Date.now()) {
  const value = Number(timestamp)
  if (!Number.isFinite(value) || value <= 0) return ""
  const delta = Math.max(0, Number(now) - value)
  if (delta < 45_000) return "now"
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  const weeks = Math.floor(days / 7)
  if (weeks < 5) return `${weeks}w`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo`
  return `${Math.floor(days / 365)}y`
}

/** Calendar bucket used to group the switcher list. */
export function timeBucket(timestamp, now = Date.now()) {
  const value = Number(timestamp)
  if (!Number.isFinite(value) || value <= 0) return "Earlier"
  const startOfToday = new Date(now)
  startOfToday.setHours(0, 0, 0, 0)
  const today = startOfToday.getTime()
  if (value >= today) return "Today"
  if (value >= today - DAY_MS) return "Yesterday"
  if (value >= today - 6 * DAY_MS) return "This week"
  if (value >= today - 29 * DAY_MS) return "This month"
  return "Earlier"
}

/**
 * Subsequence fuzzy match with contiguity and word-boundary bonuses.
 * Returns `null` when the query does not match at all.
 */
export function fuzzyMatch(text, query) {
  const haystack = String(text ?? "")
  const needle = String(query ?? "").trim()
  if (!needle) return { score: 0, positions: [] }
  const lowerHay = haystack.toLowerCase()
  const lowerNeedle = needle.toLowerCase()

  const exact = lowerHay.indexOf(lowerNeedle)
  if (exact >= 0) {
    const positions = []
    for (let index = 0; index < lowerNeedle.length; index += 1) positions.push(exact + index)
    const boundary = exact === 0 || /[\s/\\._-]/.test(haystack[exact - 1] ?? "")
    return { score: 1000 - exact + (boundary ? 250 : 0) + lowerNeedle.length * 10, positions }
  }

  const positions = []
  let cursor = 0
  let score = 0
  let streak = 0
  for (const character of lowerNeedle) {
    const found = lowerHay.indexOf(character, cursor)
    if (found < 0) return null
    const boundary = found === 0 || /[\s/\\._-]/.test(haystack[found - 1] ?? "")
    streak = found === cursor && cursor > 0 ? streak + 1 : 0
    score += 12 + streak * 8 + (boundary ? 26 : 0) - Math.min(10, found - cursor)
    positions.push(found)
    cursor = found + 1
  }
  return { score, positions }
}

function statusOf(session, statuses) {
  const status = statuses?.[session?.id]
  const type = String(status?.type ?? "")
  if (type === "busy") return "busy"
  if (type === "retry") return "retry"
  return "idle"
}

/**
 * Build the ranked, decorated session model used by every IDE surface.
 *
 * Ordering rules, in priority order: the active session first, then pinned
 * sessions, then running sessions, then recency. A search query re-ranks by
 * match quality while keeping recency as the tie-breaker.
 */
export function buildSessionModel(input = {}) {
  const now = Number(input.now) || Date.now()
  const statuses = input.statuses ?? {}
  const pinned = new Set(Array.from(input.pinned ?? []))
  const query = String(input.query ?? "").trim()
  const activeID = input.activeID ?? null
  const diffs = input.diffs ?? {}

  const rows = Array.from(input.sessions ?? [])
    .filter((session) => session && typeof session.id === "string")
    // Child sessions belong to their parent's transcript, not the switcher.
    .filter((session) => session.parentID === undefined || session.parentID === null)
    .map((session) => {
      const title = sessionTitle(session)
      const updated = updatedAt(session)
      const state = statusOf(session, statuses)
      const changes = Array.from(diffs[session.id] ?? [])
      const match = query ? fuzzyMatch(title, query) : { score: 0, positions: [] }
      return {
        id: session.id,
        title,
        updated,
        relative: relativeTime(updated, now),
        bucket: timeBucket(updated, now),
        state,
        running: state !== "idle",
        active: session.id === activeID,
        pinned: pinned.has(session.id),
        untitled: isDefaultTitle(session.title ?? ""),
        directory: String(session.directory ?? ""),
        cost: Number(session.cost ?? 0),
        changedFiles: changes.length,
        additions: changes.reduce((sum, item) => sum + (Number(item.additions) || 0), 0),
        deletions: changes.reduce((sum, item) => sum + (Number(item.deletions) || 0), 0),
        match,
      }
    })
    .filter((row) => !query || row.match !== null)

  rows.sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1
    if (query) {
      const delta = (b.match?.score ?? 0) - (a.match?.score ?? 0)
      if (delta !== 0) return delta
    } else {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      if (a.running !== b.running) return a.running ? -1 : 1
    }
    return b.updated - a.updated
  })

  return rows.map((row, index) => ({ ...row, slot: index < 9 ? index + 1 : null }))
}

/**
 * Group ranked rows into labelled sections. Searching flattens the list into a
 * single relevance-ordered section because calendar buckets are noise there.
 */
export function groupSessions(rows, query = "") {
  const list = Array.from(rows ?? [])
  if (String(query ?? "").trim()) {
    return list.length ? [{ label: "Best matches", rows: list }] : []
  }
  const groups = []
  const byLabel = new Map()
  const push = (label, row) => {
    let group = byLabel.get(label)
    if (!group) {
      group = { label, rows: [] }
      byLabel.set(label, group)
      groups.push(group)
    }
    group.rows.push(row)
  }
  for (const row of list) {
    if (row.active) push("Current", row)
    else if (row.pinned) push("Pinned", row)
    else if (row.running) push("Working", row)
    else push(row.bucket, row)
  }
  return groups
}

/** Flatten groups back into the index space used for keyboard selection. */
export function flattenGroups(groups) {
  const flat = []
  for (const group of groups ?? []) {
    for (const row of group.rows ?? []) flat.push(row)
  }
  return flat
}

/** Aggregate counters for headers and badges. */
export function summarizeSessions(rows) {
  const list = Array.from(rows ?? [])
  return {
    total: list.length,
    running: list.filter((row) => row.running).length,
    pinned: list.filter((row) => row.pinned).length,
    touched: list.filter((row) => row.changedFiles > 0).length,
  }
}

/**
 * Persisted pin list. Bounded and de-duplicated so a corrupt or unbounded KV
 * value can never grow without limit or crash the switcher.
 */
export function normalizePins(value, limit = 24) {
  const list = Array.isArray(value) ? value : []
  const seen = new Set()
  const out = []
  for (const item of list) {
    if (typeof item !== "string" || !item || seen.has(item)) continue
    seen.add(item)
    out.push(item)
    if (out.length >= limit) break
  }
  return out
}

export function togglePin(pins, id, limit = 24) {
  const list = normalizePins(pins, limit)
  if (typeof id !== "string" || !id) return list
  return list.includes(id) ? list.filter((item) => item !== id) : normalizePins([id, ...list], limit)
}
