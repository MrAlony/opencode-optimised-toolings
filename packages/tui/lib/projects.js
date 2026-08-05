// Cross-project intelligence for the Alonix workbench.
//
// OpenCode scopes its own TUI to one project directory. The workbench lifts
// that limit by treating projects as first-class objects and grouping every
// known session under its owning project. All logic here is pure so the
// multi-project model can be verified without a server or terminal.

import { relativeTime, sessionTitle, isDefaultTitle } from "./sessions.js"

function normalizeDirectory(value) {
  const text = String(value ?? "").trim().replaceAll("\\", "/").replace(/\/+$/, "")
  return text
}

/** Case-insensitive on Windows, exact elsewhere; used only for identity. */
function directoryKey(value) {
  const normalized = normalizeDirectory(value)
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

export function projectLabel(project) {
  const explicit = String(project?.name ?? "").trim()
  if (explicit) return explicit
  const worktree = normalizeDirectory(project?.worktree)
  if (!worktree) return "project"
  return worktree.slice(worktree.lastIndexOf("/") + 1) || worktree
}

/** True when `directory` is inside (or equal to) `root`. */
export function containsDirectory(root, directory) {
  const a = directoryKey(root)
  const b = directoryKey(directory)
  if (!a || !b) return false
  if (a === b) return true
  return b.startsWith(`${a}/`)
}

/**
 * Attribute a session to a project.
 *
 * `projectID` is authoritative when both sides know it. Directory containment
 * is the fallback, because sessions created through other clients may predate
 * the project record. The longest matching worktree wins so nested checkouts
 * attribute to the most specific project.
 */
export function projectForSession(session, projects) {
  const list = Array.from(projects ?? [])
  if (!session) return null
  const byID = list.find((project) => project?.id && project.id === session.projectID)
  if (byID) return byID
  return (
    list
      .filter((project) => containsDirectory(project?.worktree, session.directory))
      .sort((a, b) => normalizeDirectory(b?.worktree).length - normalizeDirectory(a?.worktree).length)[0] ?? null
  )
}

function sessionActivity(session) {
  const value = Number(session?.time?.updated ?? session?.time?.created ?? 0)
  return Number.isFinite(value) ? value : 0
}

/**
 * Build the complete project -> sessions model that drives the workbench.
 *
 * Projects with no sessions are retained so they remain openable, and sessions
 * whose project is unknown are collected under a synthetic bucket rather than
 * being silently dropped.
 */
export function buildProjectModel(input = {}) {
  const now = Number(input.now) || Date.now()
  const statuses = input.statuses ?? {}
  const activeSessionID = input.activeSessionID ?? null
  const activeDirectory = normalizeDirectory(input.activeDirectory)
  const pinned = new Set(Array.from(input.pinnedProjects ?? []))
  const projects = Array.from(input.projects ?? []).filter((project) => project && typeof project === "object")
  const sessions = Array.from(input.sessions ?? []).filter((session) => session && typeof session.id === "string")

  const buckets = new Map()
  const ensure = (key, seed) => {
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = { ...seed, sessions: [] }
      buckets.set(key, bucket)
    }
    return bucket
  }

  for (const project of projects) {
    const worktree = normalizeDirectory(project.worktree)
    ensure(project.id ?? directoryKey(worktree), {
      id: project.id ?? directoryKey(worktree),
      name: projectLabel(project),
      worktree,
      vcs: project.vcs ?? null,
      known: true,
    })
  }

  for (const session of sessions) {
    // Child sessions belong to their parent's transcript, not the project list.
    if (session.parentID !== undefined && session.parentID !== null) continue
    const project = projectForSession(session, projects)
    const worktree = normalizeDirectory(project?.worktree ?? session.directory)
    const key = project?.id ?? directoryKey(worktree)
    const bucket = ensure(key, {
      id: key,
      name: project ? projectLabel(project) : projectLabel({ worktree }),
      worktree,
      vcs: project?.vcs ?? null,
      known: Boolean(project),
    })
    const state = String(statuses[session.id]?.type ?? "idle")
    bucket.sessions.push({
      id: session.id,
      title: sessionTitle(session),
      untitled: isDefaultTitle(session.title ?? ""),
      updated: sessionActivity(session),
      relative: relativeTime(sessionActivity(session), now),
      directory: normalizeDirectory(session.directory),
      state,
      running: state === "busy" || state === "retry",
      active: session.id === activeSessionID,
      cost: Number(session.cost ?? 0),
      changedFiles: Number(session.summary?.files ?? 0),
      additions: Number(session.summary?.additions ?? 0),
      deletions: Number(session.summary?.deletions ?? 0),
    })
  }

  const rows = [...buckets.values()].map((bucket) => {
    bucket.sessions.sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1
      if (a.running !== b.running) return a.running ? -1 : 1
      return b.updated - a.updated
    })
    const updated = bucket.sessions.reduce((max, session) => Math.max(max, session.updated), 0)
    return {
      ...bucket,
      pinned: pinned.has(bucket.id),
      current: Boolean(activeDirectory) && containsDirectory(bucket.worktree, activeDirectory),
      active: bucket.sessions.some((session) => session.active),
      running: bucket.sessions.filter((session) => session.running).length,
      sessionCount: bucket.sessions.length,
      changedFiles: bucket.sessions.reduce((sum, session) => sum + session.changedFiles, 0),
      updated,
      relative: relativeTime(updated, now),
    }
  })

  rows.sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    if (a.running !== b.running) return a.running > b.running ? -1 : 1
    if (a.updated !== b.updated) return b.updated - a.updated
    return a.name.localeCompare(b.name)
  })

  return rows
}

/** Portfolio-level totals for the workbench header. */
export function summarizeProjects(rows) {
  const list = Array.from(rows ?? [])
  return {
    projects: list.length,
    sessions: list.reduce((sum, row) => sum + row.sessionCount, 0),
    running: list.reduce((sum, row) => sum + row.running, 0),
    changedFiles: list.reduce((sum, row) => sum + row.changedFiles, 0),
    withWork: list.filter((row) => row.changedFiles > 0).length,
  }
}

/** Flatten to a single ordered session list, tagged with its project. */
export function flattenProjectSessions(rows) {
  const out = []
  for (const row of Array.from(rows ?? [])) {
    for (const session of row.sessions ?? []) {
      out.push({ ...session, projectID: row.id, projectName: row.name, worktree: row.worktree })
    }
  }
  return out
}

/**
 * Recently touched projects, most recent first. Used for quick-switch slots so
 * the common case of alternating between two projects is a single keystroke.
 */
export function recentProjects(rows, limit = 9) {
  return Array.from(rows ?? [])
    .filter((row) => row.updated > 0)
    .sort((a, b) => b.updated - a.updated)
    .slice(0, Math.max(0, limit))
}
