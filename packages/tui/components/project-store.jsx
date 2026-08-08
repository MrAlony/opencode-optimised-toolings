/** @jsxImportSource @opentui/solid */
// Cross-project reactive store for the Alonix workbench.
//
// The host TUI scopes itself to one project directory. This store queries the
// SDK directly for every project and every session so the workbench can present
// the whole portfolio, and persists workbench layout across restarts.

import { createEffect, createMemo, onCleanup } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import {
  buildProjectModel,
  flattenProjectSessions,
  normalizeProjectPreferenceKeys,
  projectStateKey,
  recentSessions,
  summarizeProjects,
} from "../lib/projects.js"
import { listDiff, listMessages, listProjects, listSessions, listStatuses, listTodos } from "../lib/sdk.js"
import { durableStatus, mergeStatus } from "../lib/presence.js"
import { clearPresenceLease, publishPresenceLease, readPresenceLeases, readPresenceSnapshot } from "../lib/presence-lease.js"
import { decisionRecord, normalizeDeliveryState } from "../lib/command-center.js"
import {
  activateSlot,
  activateTab,
  closeTab,
  createWorkbench,
  cyclePane,
  cycleRecent,
  cycleTab,
  focusPane,
  openTab,
  reconcileTabs,
  serializeWorkbench,
  setExplorerIndex,
  toggleCollapsed,
  togglePinTab,
} from "../lib/workbench.js"
import {
  addPane,
  autoFill,
  createPanes,
  cyclePaneFocus,
  focusPaneAt,
  reconcilePanes,
  removePane,
  serializePanes,
  soloPane,
} from "../lib/panes.js"

const HIDDEN_PROJECTS_KEY = "alonix_hidden_projects"
const PANES_KEY = "alonix_monitor_panes"
const WORKBENCH_KEY = "alonix_workbench_state"
const PINNED_PROJECTS_KEY = "alonix_pinned_projects"
const REGISTERED_PROJECTS_KEY = "alonix_registered_projects"
const SELECTED_PROJECT_KEY = "alonix_selected_project"
const PORTFOLIO_SNAPSHOT_KEY = "alonix_portfolio_snapshot"
const DELIVERY_STATE_KEY = "alonix_delivery_state"
const PORTFOLIO_SNAPSHOT_VERSION = 2
const PORTFOLIO_SNAPSHOT_SESSION_LIMIT = 1_000
const PRESENCE_LEASE_MS = 20_000
const PRESENCE_CACHE_LIMIT = 200
const REFRESH_DEBOUNCE_MS = 60
const STRUCTURAL_RECONCILE_INTERVAL_MS = 45_000
const PRESENCE_RECONCILE_INTERVAL_MS = 10_000
const PRESENCE_EVENT_DEBOUNCE_MS = 40
const SDK_CONCURRENCY = 4
const PRESENCE_RECENT_LIMIT = 12
const PRESENCE_ROTATING_LIMIT = 8
const DELIVERY_RECENT_LIMIT = 8
const DELIVERY_ROTATING_LIMIT = 4
const SESSION_LIMIT = 400
const SDK_REQUEST_TIMEOUT_MS = 6_000
const SDK_REQUEST_TIMEOUT_MIN_MS = 100
const SDK_REQUEST_TIMEOUT_MAX_MS = 30_000

function readKv(api, key, fallback) {
  try {
    const value = api?.kv?.get?.(key, fallback)
    return value === undefined ? fallback : value
  } catch {
    return fallback
  }
}

function writeKv(api, key, value) {
  try {
    api?.kv?.set?.(key, value)
  } catch {
    // Persistence is best effort; the session still works in memory.
  }
}

function kvReady(api) {
  try {
    // Older/mock hosts do not expose readiness; their synchronous KV is ready.
    return api?.kv?.ready !== false
  } catch {
    return true
  }
}

/**
 * Load every project, and the sessions belonging to each of them.
 *
 * `session.list` is scoped to a single directory: with no `directory` query it
 * answers for the server's launch directory only. Listing once therefore
 * returns the launch project's sessions no matter which project you select,
 * which is why switching projects appeared to show the wrong sessions. The
 * only way to span projects is to ask per project worktree and merge.
 *
 * Each request resolves independently and failures are reported rather than
 * flattened into an empty array, so one unreachable project cannot blank the
 * whole portfolio.
 */
function normalizeDirectory(value) {
  let normalized = String(value ?? "").trim().replaceAll("\\", "/").replace(/\/+$/, "")
  if (process.platform === "win32" && /^\/(?!\/)/.test(normalized)) {
    const drive = String(process.env.SystemDrive ?? process.cwd().match(/^[a-zA-Z]:/)?.[0] ?? "C:").replace(/\/$/, "")
    normalized = `${drive}${normalized}`
  }
  return normalized
}

function directoryKey(value) {
  const normalized = normalizeDirectory(value)
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

function normalizeCachedStatuses(value, now = Date.now()) {
  const source = value && typeof value === "object" ? value : {}
  const statuses = {}
  for (const [id, entry] of Object.entries(source).slice(0, PRESENCE_CACHE_LIMIT)) {
    const type = String(entry?.type ?? "")
    const observedAt = Number(entry?.observedAt)
    if (!id || !["busy", "retry", "compacting"].includes(type)) continue
    if (!Number.isFinite(observedAt) || now - observedAt > PRESENCE_LEASE_MS) continue
    statuses[id] = { type, source: "shared-presence", observedAt }
  }
  return statuses
}

function normalizePortfolioSnapshot(value) {
  if (!value || ![1, PORTFOLIO_SNAPSHOT_VERSION].includes(value.version)) return null
  const projects = Array.isArray(value.projects) ? value.projects.filter((item) => item && typeof item === "object").slice(0, 200) : []
  const sessions = Array.isArray(value.sessions) ? value.sessions.filter((item) => item?.id && typeof item === "object").slice(0, PORTFOLIO_SNAPSHOT_SESSION_LIMIT) : []
  const savedAt = Number(value.savedAt)
  if (!projects.length && !sessions.length) return null
  return {
    version: PORTFOLIO_SNAPSHOT_VERSION,
    savedAt: Number.isFinite(savedAt) && savedAt > 0 ? savedAt : Date.now(),
    projects,
    sessions,
    statuses: normalizeCachedStatuses(value.statuses),
  }
}

function sharedPresence(statuses, now = Date.now()) {
  const out = {}
  for (const [id, status] of Object.entries(statuses ?? {})) {
    const type = String(status?.type ?? status ?? "")
    if (!["busy", "retry", "compacting"].includes(type)) continue
    const observedAt = status?.source === "shared-presence" && Number.isFinite(Number(status?.observedAt))
      ? Number(status.observedAt)
      : now
    if (now - observedAt > PRESENCE_LEASE_MS) continue
    out[id] = { type, observedAt }
    if (Object.keys(out).length >= PRESENCE_CACHE_LIMIT) break
  }
  return out
}

function portfolioSnapshot(projects, sessions, statuses = {}, now = Date.now()) {
  return {
    version: PORTFOLIO_SNAPSHOT_VERSION,
    savedAt: now,
    projects: Array.from(projects ?? []).slice(0, 200),
    sessions: Array.from(sessions ?? []).slice(0, PORTFOLIO_SNAPSHOT_SESSION_LIMIT),
    statuses: sharedPresence(statuses, now),
  }
}

function statusEventPayload(event) {
  const properties = event?.properties ?? event?.payload?.properties
  const sessionID = String(properties?.sessionID ?? "").trim()
  const status = properties?.status
  const type = String(status?.type ?? "")
  return sessionID && type ? { sessionID, status, type } : null
}

function mergePresenceSessions(current, incoming) {
  const byID = new Map(Array.from(current ?? []).filter((session) => session?.id).map((session) => [session.id, session]))
  for (const session of incoming ?? []) {
    if (!session?.id || byID.has(session.id)) continue
    byID.set(session.id, session)
  }
  return [...byID.values()]
}

function mergePresenceStatuses(current, incoming, now = Date.now()) {
  const merged = {}
  for (const [id, status] of Object.entries(current ?? {})) {
    const type = String(status?.type ?? status ?? "")
    if (!["busy", "retry", "compacting"].includes(type)) continue
    if (status?.source === "shared-presence" && now - Number(status?.observedAt ?? 0) > PRESENCE_LEASE_MS) continue
    merged[id] = status
  }
  for (const [id, status] of Object.entries(incoming ?? {})) {
    const type = String(status?.type ?? status ?? "")
    if (["busy", "retry", "compacting"].includes(type)) merged[id] = status
  }
  return merged
}

function normalizeDirectories(value, limit = 200) {
  const out = []
  const seen = new Set()
  for (const item of Array.from(value ?? [])) {
    const directory = normalizeDirectory(item)
    const key = directoryKey(directory)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(directory)
    if (out.length >= limit) break
  }
  return out
}

function sdkRequestTimeoutMs() {
  const configured = Number(process.env.ALONIX_PORTFOLIO_REQUEST_TIMEOUT_MS)
  if (!Number.isFinite(configured)) return SDK_REQUEST_TIMEOUT_MS
  return Math.max(SDK_REQUEST_TIMEOUT_MIN_MS, Math.min(SDK_REQUEST_TIMEOUT_MAX_MS, Math.floor(configured)))
}

async function withDeadline(operation, label, timeoutMs = sdkRequestTimeoutMs()) {
  let timer
  const controller = new AbortController()
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort(new Error(`${label} timed out after ${timeoutMs}ms`))
          reject(new Error(`${label} timed out after ${timeoutMs}ms`))
        }, timeoutMs)
        timer?.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function mapSettledBounded(items, worker, concurrency = SDK_CONCURRENCY) {
  const rows = Array.from(items ?? [])
  const results = new Array(rows.length)
  let cursor = 0
  const run = async () => {
    while (cursor < rows.length) {
      const index = cursor++
      try {
        results[index] = { status: "fulfilled", value: await worker(rows[index], index) }
      } catch (reason) {
        results[index] = { status: "rejected", reason }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, run))
  return results
}

function mergeProjects(serverProjects, registeredDirectories) {
  const rows = Array.from(serverProjects ?? [])
  const known = new Set(rows.map((project) => directoryKey(project?.worktree)).filter(Boolean))
  for (const worktree of normalizeDirectories(registeredDirectories)) {
    const key = directoryKey(worktree)
    if (known.has(key)) continue
    rows.push({ id: `alonix:${key}`, worktree, name: undefined, manual: true, time: { created: 0, updated: 0 }, sandboxes: [] })
    known.add(key)
  }
  return rows
}

async function loadPortfolio(api, registeredDirectories = [], activeSessionID = null, previousSessions = [], intelligenceOffset = 0, onCore = null) {
  const client = api?.client
  if (!client) return { projects: [], sessions: [], errors: [] }

  const errors = []
  const unwrap = (settled, label) => {
    if (settled.status === "rejected") {
      errors.push(`${label}: ${errorText(settled.reason)}`)
      return undefined
    }
    return Array.isArray(settled.value) ? settled.value : undefined
  }

  const directoryLabel = (directory) => directory || "current directory"
  const knownDirectories = normalizeDirectories([
    ...registeredDirectories,
    ...Array.from(previousSessions ?? []).map((session) => session?.directory),
  ])
  const earlyTargets = ["", ...knownDirectories]
  const projectRequest = Promise.allSettled([
    withDeadline((signal) => listProjects(client, { signal }), "Project listing"),
  ])

  // Probe every directory already known locally immediately. This runs in
  // parallel with project enumeration, so a slow global endpoint cannot delay
  // an existing remote run from appearing as working after a fresh TUI launch.
  const [earlySettled, earlyStatusSettled] = await Promise.all([
    mapSettledBounded(earlyTargets, (directory) => withDeadline(
      (signal) => listSessions(client, { directory, roots: true, limit: SESSION_LIMIT }, { signal }),
      `Chat listing (${directoryLabel(directory)})`,
    )),
    mapSettledBounded(earlyTargets, (directory) => withDeadline(
      (signal) => listStatuses(client, directory, { signal }),
      `Chat status (${directoryLabel(directory)})`,
    )),
  ])

  const earlyByID = new Map()
  let earlyAnySucceeded = false
  earlySettled.forEach((result, index) => {
    const rows = unwrap(result, `sessions (${directoryLabel(earlyTargets[index])})`)
    if (!rows) return
    earlyAnySucceeded = true
    for (const session of rows) if (session?.id && !earlyByID.has(session.id)) earlyByID.set(session.id, session)
  })
  const earlyStatuses = {}
  for (const result of earlyStatusSettled) if (result.status === "fulfilled") Object.assign(earlyStatuses, result.value ?? {})
  if (typeof onCore === "function") {
    try { onCore({ projects: mergeProjects([], registeredDirectories), sessions: earlyAnySucceeded ? [...earlyByID.values()] : undefined, statuses: earlyStatuses, errors: [...errors] }) } catch {}
  }

  const projectSettled = await projectRequest
  const serverProjects = unwrap(projectSettled[0], "projects")
  const projects = mergeProjects(serverProjects, registeredDirectories)
  const earlyKeys = new Set(earlyTargets.map(directoryKey))
  const lateTargets = []
  for (const project of projects ?? []) {
    const worktree = String(project?.worktree ?? "").trim()
    const key = directoryKey(worktree)
    if (worktree && !earlyKeys.has(key)) {
      earlyKeys.add(key)
      lateTargets.push(worktree)
    }
  }
  const [lateSettled, lateStatusSettled] = await Promise.all([
    mapSettledBounded(lateTargets, (directory) => withDeadline(
      (signal) => listSessions(client, { directory, roots: true, limit: SESSION_LIMIT }, { signal }),
      `Chat listing (${directoryLabel(directory)})`,
    )),
    mapSettledBounded(lateTargets, (directory) => withDeadline(
      (signal) => listStatuses(client, directory, { signal }),
      `Chat status (${directoryLabel(directory)})`,
    )),
  ])
  const targets = [...earlyTargets, ...lateTargets]
  const settled = [...earlySettled, ...lateSettled]
  const statusSettled = [...earlyStatusSettled, ...lateStatusSettled]

  // Merge and de-duplicate: a session reachable from two directories is one
  // session, and the first (most specific) answer wins.
  const byID = new Map()
  let anySucceeded = false
  settled.forEach((result, index) => {
    const label = targets[index] || "current directory"
    const rows = unwrap(result, `sessions (${label})`)
    if (!rows) return
    anySucceeded = true
    for (const session of rows) {
      if (session?.id && !byID.has(session.id)) byID.set(session.id, session)
    }
  })

  const liveStatuses = {}
  statusSettled.forEach((result) => {
    if (result.status !== "fulfilled") return
    Object.assign(liveStatuses, result.value ?? {})
  })

  const sessions = anySucceeded ? [...byID.values()] : undefined

  // Publish structural data and live server status before transcript and
  // delivery enrichment. Those secondary reads can be slow or unavailable, but
  // must never delay an already-running session appearing in the dock/overview.
  if (typeof onCore === "function") {
    try { onCore({ projects, sessions, statuses: liveStatuses, errors: [...errors] }) } catch {}
  }

  const durableStatuses = {}
  if (sessions) {
    const candidates = []
    const seen = new Set()
    const active = sessions.find((session) => session.id === activeSessionID)
    if (active) { candidates.push(active); seen.add(active.id) }
    for (const session of sessions.toSorted((a, b) => Number(b?.time?.updated ?? 0) - Number(a?.time?.updated ?? 0))) {
      if (seen.has(session.id)) continue
      candidates.push(session)
      seen.add(session.id)
      if (candidates.length >= PRESENCE_RECENT_LIMIT) break
    }
    const messageResults = await mapSettledBounded(candidates, (session) => withDeadline(
      (signal) => listMessages(client, session, 1, { signal }),
      `Recent activity (${session.id})`,
    ))
    messageResults.forEach((result, index) => {
      if (result.status !== "fulfilled") return
      const session = candidates[index]
      const inferred = durableStatus(result.value, { sessionUpdatedAt: session?.time?.updated })
      if (inferred) durableStatuses[session.id] = inferred
    })
  }

  const statuses = {}
  for (const session of sessions ?? []) statuses[session.id] = mergeStatus(liveStatuses[session.id], durableStatuses[session.id])

  // Persisted delivery intelligence is loaded through a bounded rolling window.
  // Active/running/recent chats lead; older chats rotate across structural
  // refreshes. Previous values survive transient failures and are stored in the
  // portfolio snapshot, so warm starts do not wait for the same SDK calls.
  let enrichedSessions = sessions
  if (sessions) {
    const previous = new Map(Array.from(previousSessions ?? []).map((session) => [session?.id, session]))
    enrichedSessions = sessions.map((session) => ({
      ...session,
      alonixTodos: Array.from(previous.get(session.id)?.alonixTodos ?? []),
      alonixFiles: Array.from(previous.get(session.id)?.alonixFiles ?? []),
    }))
    const candidates = []
    const seen = new Set()
    const add = (session) => {
      if (!session?.id || seen.has(session.id)) return
      seen.add(session.id)
      candidates.push(session)
    }
    add(enrichedSessions.find((session) => session.id === activeSessionID))
    for (const session of enrichedSessions) {
      const type = statuses[session.id]?.type
      if (type === "busy" || type === "retry" || Number(session.summary?.files ?? 0) > 0) add(session)
      if (candidates.length >= DELIVERY_RECENT_LIMIT) break
    }
    const recent = enrichedSessions.toSorted((a, b) => Number(b?.time?.updated ?? 0) - Number(a?.time?.updated ?? 0))
    for (const session of recent) {
      add(session)
      if (candidates.length >= DELIVERY_RECENT_LIMIT) break
    }
    const remaining = recent.filter((session) => !seen.has(session.id))
    if (remaining.length) {
      const start = Math.abs(Number(intelligenceOffset) || 0) % remaining.length
      for (let index = 0; index < Math.min(DELIVERY_ROTATING_LIMIT, remaining.length); index += 1) add(remaining[(start + index) % remaining.length])
    }
    const intelligence = await mapSettledBounded(candidates, async (session) => {
      const [todos, files] = await Promise.all([
        withDeadline((signal) => listTodos(client, session, { signal }), `Delivery tasks (${session.id})`),
        withDeadline((signal) => listDiff(client, session, { signal }), `Delivery changes (${session.id})`),
      ])
      return { id: session.id, todos, files }
    })
    const byID = new Map(enrichedSessions.map((session) => [session.id, session]))
    intelligence.forEach((result) => {
      if (result.status !== "fulfilled") return
      const session = byID.get(result.value.id)
      if (!session) return
      session.alonixTodos = result.value.todos
      session.alonixFiles = result.value.files
    })
  }

  return {
    projects,
    // `undefined` means "nothing loaded", which preserves the previous list.
    sessions: enrichedSessions,
    statuses,
    errors,
  }
}

async function loadPresence(api, projects, sessions, activeSessionID = null, rotationOffset = 0, onLive = null) {
  const client = api?.client
  if (!client || !sessions?.length) return {}

  const directories = new Set([""])
  for (const project of projects ?? []) {
    const worktree = String(project?.worktree ?? "").trim()
    if (worktree) directories.add(worktree)
  }

  const statusResults = await mapSettledBounded([...directories], (directory) => withDeadline(
    (signal) => listStatuses(client, directory, { signal }),
    `Presence status (${directory || "current directory"})`,
  ))
  const live = {}
  for (const result of statusResults) {
    if (result.status === "fulfilled") Object.assign(live, result.value ?? {})
  }
  if (typeof onLive === "function" && Object.keys(live).length) {
    try { onLive(live) } catch {}
  }

  const candidates = []
  const seen = new Set()
  const addCandidate = (session) => {
    if (!session?.id || seen.has(session.id)) return
    candidates.push(session)
    seen.add(session.id)
  }
  addCandidate(sessions.find((session) => session.id === activeSessionID))
  for (const session of sessions) {
    const type = live[session?.id]?.type
    if (type === "busy" || type === "retry" || type === "compacting") addCandidate(session)
  }
  const recent = sessions.toSorted((a, b) => Number(b?.time?.updated ?? 0) - Number(a?.time?.updated ?? 0))
  for (const session of recent.slice(0, PRESENCE_RECENT_LIMIT)) addCandidate(session)
  const remaining = recent.filter((session) => session?.id && !seen.has(session.id))
  if (remaining.length) {
    const start = Math.abs(Number(rotationOffset) || 0) % remaining.length
    for (let index = 0; index < Math.min(PRESENCE_ROTATING_LIMIT, remaining.length); index += 1) {
      addCandidate(remaining[(start + index) % remaining.length])
    }
  }

  const durable = {}
  const messageResults = await mapSettledBounded(candidates, (session) => withDeadline(
    (signal) => listMessages(client, session, 1, { signal }),
    `Presence activity (${session.id})`,
  ))
  messageResults.forEach((result, index) => {
    if (result.status !== "fulfilled") return
    const session = candidates[index]
    const inferred = durableStatus(result.value, { sessionUpdatedAt: session?.time?.updated })
    if (inferred) durable[session.id] = inferred
  })

  const statuses = {}
  for (const session of sessions) {
    if (!session?.id) continue
    const merged = mergeStatus(live[session.id], durable[session.id])
    if (merged) statuses[session.id] = merged
  }
  return statuses
}

function errorText(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

export function createProjectStore(api) {
  const initiallyHydrated = kvReady(api)
  const initialRead = (key, fallback) => (initiallyHydrated ? readKv(api, key, fallback) : fallback)
  const initialRegisteredProjects = normalizeDirectories(initialRead(REGISTERED_PROJECTS_KEY, []))
  const initialSelection = initialRead(SELECTED_PROJECT_KEY, {})
  const initialSnapshot = normalizePortfolioSnapshot(initialRead(PORTFOLIO_SNAPSHOT_KEY, null))
  const initialPresence = readPresenceSnapshot(api)
  const initialDelivery = normalizeDeliveryState(initialRead(DELIVERY_STATE_KEY, {}))
  const [store, setStore] = createStore({
    // Registered folders are durable local state. Render them immediately while
    // the authoritative SDK refresh runs, rather than showing an empty spinner.
    projects: mergeProjects(initialSnapshot?.projects ?? [], initialRegisteredProjects),
    sessions: mergePresenceSessions(initialSnapshot?.sessions ?? [], initialPresence.sessions),
    statuses: mergePresenceStatuses(initialSnapshot?.statuses ?? {}, initialPresence.statuses),
    registeredProjects: initialRegisteredProjects,
    selectedProjectID: typeof initialSelection?.id === "string" ? initialSelection.id : null,
    selectedProjectDirectory: typeof initialSelection?.directory === "string" ? initialSelection.directory : "",
    pinnedProjects: normalizeIds(initialRead(PINNED_PROJECTS_KEY, [])),
    hiddenProjects: normalizeIds(initialRead(HIDDEN_PROJECTS_KEY, []), 200),
    workbench: createWorkbench(initialRead(WORKBENCH_KEY, {})),
    panes: createPanes(initialRead(PANES_KEY, {})),
    delivery: initialDelivery,
    loading: true,
    phase: initialSnapshot ? "cached" : "loading",
    error: "",
    loadedAt: initialSnapshot?.savedAt ?? 0,
  })

  let inFlight = false
  let queued = false
  let debounce = null
  let presenceInFlight = false
  let presenceQueued = false
  let presenceDebounce = null
  let presenceRotation = 0
  let intelligenceRotation = 0
  let disposed = false
  let persistenceHydrated = initiallyHydrated
  const pendingPersistence = new Map()
  let initialSettled = Boolean(initialSnapshot)
  let resolveInitialLoad
  const initialLoad = new Promise((resolve) => {
    resolveInitialLoad = resolve
    if (initialSnapshot) resolve({ phase: "cached", ready: true, cached: true, error: "" })
  })
  const settleInitialLoad = () => {
    if (initialSettled) return
    initialSettled = true
    resolveInitialLoad?.({ phase: store.phase, ready: store.phase === "ready" || store.phase === "cached", cached: store.phase === "cached", error: store.error })
  }

  function persist(key, value) {
    if (!persistenceHydrated) {
      pendingPersistence.set(key, value)
      return
    }
    writeKv(api, key, value)
  }

  function persistPortfolio(projects, sessions, statuses = {}, removedStatusIDs = []) {
    const persisted = normalizePortfolioSnapshot(readKv(api, PORTFOLIO_SNAPSHOT_KEY, null))
    const mergedStatuses = { ...(persisted?.statuses ?? {}) }
    for (const [id, status] of Object.entries(statuses ?? {})) {
      const type = String(status?.type ?? status ?? "")
      if (["busy", "retry", "compacting"].includes(type)) mergedStatuses[id] = status
    }
    for (const id of removedStatusIDs) delete mergedStatuses[id]
    persist(PORTFOLIO_SNAPSHOT_KEY, portfolioSnapshot(projects, sessions, mergedStatuses))
  }

  // OpenCode hydrates kv.json asynchronously. Plugin callbacks are outside the
  // component render graph, so relying on a Solid effect here is host-build
  // dependent. A tiny bounded watcher observes the authoritative readiness flag
  // in both checkout and installed modes and is explicitly cleaned up.
  function hydratePersistence() {
    if (persistenceHydrated || !kvReady(api)) return false
    const pending = new Set(pendingPersistence.keys())
    if (!pending.has(REGISTERED_PROJECTS_KEY)) setStore("registeredProjects", normalizeDirectories(readKv(api, REGISTERED_PROJECTS_KEY, [])))
    if (!pending.has(PINNED_PROJECTS_KEY)) setStore("pinnedProjects", normalizeIds(readKv(api, PINNED_PROJECTS_KEY, [])))
    if (!pending.has(HIDDEN_PROJECTS_KEY)) setStore("hiddenProjects", normalizeIds(readKv(api, HIDDEN_PROJECTS_KEY, []), 200))
    if (!pending.has(WORKBENCH_KEY)) setStore("workbench", createWorkbench(readKv(api, WORKBENCH_KEY, {})))
    if (!pending.has(PANES_KEY)) setStore("panes", createPanes(readKv(api, PANES_KEY, {})))
    if (!pending.has(DELIVERY_STATE_KEY)) setStore("delivery", normalizeDeliveryState(readKv(api, DELIVERY_STATE_KEY, {})))
    if (!pending.has(SELECTED_PROJECT_KEY)) {
      const selected = readKv(api, SELECTED_PROJECT_KEY, {})
      setStore("selectedProjectID", typeof selected?.id === "string" ? selected.id : null)
      setStore("selectedProjectDirectory", typeof selected?.directory === "string" ? selected.directory : "")
    }
    if (!pending.has(PORTFOLIO_SNAPSHOT_KEY)) {
      const snapshot = normalizePortfolioSnapshot(readKv(api, PORTFOLIO_SNAPSHOT_KEY, null))
      if (snapshot) {
        setStore("projects", reconcile(mergeProjects(snapshot.projects, store.registeredProjects), { key: "id" }))
        const presence = readPresenceSnapshot(api)
        setStore("sessions", reconcile(mergePresenceSessions(snapshot.sessions, presence.sessions), { key: "id" }))
        setStore("statuses", reconcile(mergePresenceStatuses(store.statuses, { ...snapshot.statuses, ...presence.statuses })))
        setStore("loadedAt", snapshot.savedAt)
        setStore("phase", "cached")
        settleInitialLoad()
      }
    }
    persistenceHydrated = true
    migrateProjectPreferences()
    for (const [key, value] of pendingPersistence) writeKv(api, key, value)
    pendingPersistence.clear()
    void load()
    return true
  }
  let hydrationTimer = null
  if (!persistenceHydrated) {
    hydrationTimer = setInterval(() => {
      if (hydratePersistence() && hydrationTimer) {
        clearInterval(hydrationTimer)
        hydrationTimer = null
      }
    }, 25)
  }

  async function load() {
    if (disposed) return
    const persistedRaw = readKv(api, REGISTERED_PROJECTS_KEY, store.registeredProjects)
    const persistedProjects = normalizeDirectories(persistedRaw)
    if (persistenceHydrated && JSON.stringify(Array.from(persistedRaw ?? [])) !== JSON.stringify(persistedProjects)) {
      persist(REGISTERED_PROJECTS_KEY, persistedProjects)
    }
    if (persistedProjects.join("\n") !== store.registeredProjects.join("\n")) {
      setStore("registeredProjects", persistedProjects)
    }
    if (inFlight) {
      queued = true
      return
    }
    inFlight = true
    setStore("loading", true)
    if (!store.loadedAt) setStore("phase", "loading")
    try {
      const applyCore = ({ projects, sessions, statuses, errors }) => {
        if (disposed) return
        if (projects) setStore("projects", reconcile(projects, { key: "id" }))
        if (sessions) {
          const previous = new Map(store.sessions.map((session) => [session?.id, session]))
          const carried = sessions.map((session) => ({
            ...session,
            alonixTodos: Array.from(previous.get(session.id)?.alonixTodos ?? []),
            alonixFiles: Array.from(previous.get(session.id)?.alonixFiles ?? []),
          }))
          setStore("sessions", reconcile(carried, { key: "id" }))
          publishHostPresence()
          setStore("loadedAt", Date.now())
          setStore("phase", "ready")
        }
        if (statuses) setStore("statuses", reconcile(mergePresenceStatuses(store.statuses, statuses)))
        if (errors?.length) setStore("error", errors.join("; "))
        settleInitialLoad()
      }
      const { projects, sessions, statuses, errors } = await loadPortfolio(api, store.registeredProjects, activeSessionID(), store.sessions, intelligenceRotation, applyCore)
      intelligenceRotation = (intelligenceRotation + DELIVERY_ROTATING_LIMIT) % Math.max(1, sessions?.length ?? store.sessions.length)
      if (disposed) return
      // Only overwrite a list that actually loaded, so a partial failure keeps
      // the last good data instead of emptying the workbench.
      if (projects) setStore("projects", reconcile(projects, { key: "id" }))
      if (sessions) setStore("sessions", reconcile(sessions, { key: "id" }))
      if (statuses) setStore("statuses", reconcile(mergePresenceStatuses(store.statuses, statuses)))
      setStore("error", errors.length ? errors.join("; ") : "")
      // Folder metadata can arrive before any chat listing. Only an actual
      // session-list result (including a legitimate empty array) makes zero
      // chats authoritative.
      if (sessions !== undefined) {
        const authoritativeProjects = projects ?? store.projects
        setStore("loadedAt", Date.now())
        setStore("phase", "ready")
        persistPortfolio(authoritativeProjects, sessions, statuses ?? store.statuses)
      } else if (!store.loadedAt) {
        setStore("phase", "error")
      }
      if (projects || sessions) migrateProjectPreferences(projects ?? store.projects)
    } catch (error) {
      // Keep the last good portfolio; a blank workbench is worse than a stale one.
      if (!disposed) {
        setStore("error", errorText(error))
        if (!store.loadedAt) setStore("phase", "error")
      }
    } finally {
      inFlight = false
      if (!disposed) setStore("loading", false)
      settleInitialLoad()
      if (queued && !disposed) {
        queued = false
        void load()
      } else if (presenceQueued && !disposed) {
        presenceQueued = false
        schedulePresence()
      }
    }
  }

  function refresh() {
    if (disposed) return
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(() => {
      debounce = null
      void load()
    }, REFRESH_DEBOUNCE_MS)
  }

  function publishHostPresence() {
    if (disposed || !store.sessions.length) return false
    const local = {}
    for (const session of store.sessions) {
      if (!session?.id) continue
      try {
        const status = api?.state?.session?.status?.(session.id)
        const type = String(status?.type ?? "")
        if (["busy", "retry", "compacting"].includes(type)) {
          local[session.id] = status
          publishPresenceLease(api, session.id, status, { session })
        }
      } catch {}
    }
    if (!Object.keys(local).length) return false
    const merged = mergePresenceStatuses(store.statuses, local)
    setStore("statuses", reconcile(merged))
    persistPortfolio(store.projects, store.sessions, merged)
    return true
  }

  function applyStatusEvent(event) {
    if (disposed) return false
    const payload = statusEventPayload(event)
    if (!payload) return publishHostPresence()
    const next = { ...store.statuses }
    if (["busy", "retry", "compacting"].includes(payload.type)) {
      const session = store.sessions.find((item) => item?.id === payload.sessionID)
      publishPresenceLease(api, payload.sessionID, payload.status, { session })
      next[payload.sessionID] = payload.status
      setStore("statuses", reconcile(next))
      persistPortfolio(store.projects, store.sessions, { [payload.sessionID]: payload.status })
      return true
    }
    if (payload.type === "idle") {
      clearPresenceLease(api, payload.sessionID)
      delete next[payload.sessionID]
      setStore("statuses", reconcile(next))
      persistPortfolio(store.projects, store.sessions, next, [payload.sessionID])
      return true
    }
    return publishHostPresence()
  }

  function schedulePresence(event) {
    if (disposed) return
    // The process that owns the run has authoritative reactive status already.
    // Publish it to the shared lease synchronously; the debounced SDK pass only
    // verifies cross-process state and fills gaps.
    if (!statusEventPayload(event)) publishHostPresence()
    if (presenceDebounce) clearTimeout(presenceDebounce)
    presenceDebounce = setTimeout(() => {
      presenceDebounce = null
      void refreshPresence()
    }, PRESENCE_EVENT_DEBOUNCE_MS)
  }

  async function refreshPresence() {
    if (disposed || !store.sessions.length) return
    if (inFlight) {
      presenceQueued = true
      return
    }
    if (presenceInFlight) {
      presenceQueued = true
      return
    }
    presenceInFlight = true
    try {
      const publishLive = (live) => {
        if (disposed) return
        const merged = mergePresenceStatuses(store.statuses, live)
        setStore("statuses", reconcile(merged))
        persistPortfolio(store.projects, store.sessions, merged)
      }
      const next = await loadPresence(api, store.projects, store.sessions, activeSessionID(), presenceRotation, publishLive)
      presenceRotation = (presenceRotation + PRESENCE_ROTATING_LIMIT) % Math.max(1, store.sessions.length)
      if (disposed || !Object.keys(next).length) return
      const merged = mergePresenceStatuses(store.statuses, next)
      setStore("statuses", reconcile(merged))
      persistPortfolio(store.projects, store.sessions, merged)
    } catch {
      // Presence is advisory. Keep the last known state on a transient failure.
    } finally {
      presenceInFlight = false
      if (presenceQueued && !disposed) {
        presenceQueued = false
        schedulePresence()
      }
    }
  }

  // Subscribing to only `session.updated` left the sidebar stale: a new session
  // never appeared, and a session that started working kept showing as idle.
  // These are the events that actually change what the sidebar displays.
  const STRUCTURAL_EVENTS = [
    "session.created",
    "session.updated",
    "session.deleted",
    "session.compacted",
    "project.updated",
    "project.directories.updated",
  ]
  const PRESENCE_EVENTS = ["session.idle", "session.error", "session.diff"]

  const offs = []
  for (const event of STRUCTURAL_EVENTS) {
    try {
      const off = api?.event?.on?.(event, refresh)
      if (typeof off === "function") offs.push(off)
    } catch {
      // Unknown event names are ignored; periodic reconciliation still covers them.
    }
  }
  try {
    const off = api?.event?.on?.("session.status", (event) => {
      // The event payload is authoritative and arrives at the same boundary as
      // the host reducer. Sampling reactive state here races reducer ordering in
      // real OpenCode builds, which left the cross-window lease empty.
      applyStatusEvent(event)
      schedulePresence(event)
    })
    if (typeof off === "function") offs.push(off)
  } catch {
    // Local reactive state and periodic reconciliation remain available.
  }
  for (const event of PRESENCE_EVENTS) {
    try {
      const off = api?.event?.on?.(event, schedulePresence)
      if (typeof off === "function") offs.push(off)
    } catch {
      // Local reactive state remains available even without this event.
    }
  }
  // Streaming message events are intentionally not subscribed here. The host's
  // reactive session state updates this process immediately; reloading every
  // project on every token caused the entire IDE to stutter.

  const structuralTimer = setInterval(() => {
    if (!disposed) void load()
  }, STRUCTURAL_RECONCILE_INTERVAL_MS)
  structuralTimer?.unref?.()
  const presenceTimer = setInterval(() => {
    if (!disposed) {
      publishHostPresence()
      void refreshPresence()
    }
  }, PRESENCE_RECONCILE_INTERVAL_MS)
  presenceTimer?.unref?.()

  onCleanup(() => {
    disposed = true
    clearInterval(structuralTimer)
    clearInterval(presenceTimer)
    if (hydrationTimer) clearInterval(hydrationTimer)
    if (debounce) clearTimeout(debounce)
    if (presenceDebounce) clearTimeout(presenceDebounce)
    for (const off of offs) {
      try {
        off()
      } catch {
        // best effort
      }
    }
  })

  const statuses = () => {
    const map = mergePresenceStatuses(readPresenceLeases(api), store.statuses)
    for (const session of store.sessions) {
      if (!session?.id) continue
      try {
        const status = api?.state?.session?.status?.(session.id)
        if (status) map[session.id] = mergeStatus(status, map[session.id])
      } catch {
        // Durable polling still covers sessions owned by another process.
      }
    }
    return map
  }

  const activeSessionID = () => {
    try {
      const current = api?.route?.current
      if (current?.name !== "session") return null
      const id = current?.params?.sessionID
      return typeof id === "string" && id ? id : null
    } catch {
      return null
    }
  }

  const projectRows = createMemo(() =>
    buildProjectModel({
      projects: store.projects,
      sessions: store.sessions,
      statuses: statuses(),
      selectedProjectID: store.selectedProjectID,
      selectedProjectDirectory: store.selectedProjectDirectory,
      pinnedProjects: store.pinnedProjects,
      hiddenProjects: store.hiddenProjects,
      activeSessionID: activeSessionID(),
      activeDirectory: (() => {
        try {
          return api?.state?.path?.directory ?? ""
        } catch {
          return ""
        }
      })(),
      now: Date.now(),
    }),
  )

  if (persistenceHydrated) {
    // Start authoritative discovery without delaying plugin registration. A
    // cached session list gets an immediate lightweight presence probe in
    // parallel so work owned by another OpenCode process is marked promptly.
    void load()
    if (store.sessions.length) void refreshPresence()
  }

  const sessionRows = createMemo(() => flattenProjectSessions(projectRows()))
  const recentSessionRows = createMemo(() => recentSessions(projectRows(), 5))
  const summary = createMemo(() => summarizeProjects(projectRows()))

  // Tabs for sessions that no longer exist must disappear, but only once a
  // real listing has arrived; otherwise the first render would clear them.
  createEffect(() => {
    if (!store.loadedAt) return
    const ids = store.sessions.map((session) => session.id)
    const next = reconcileTabs(store.workbench, ids)
    if (next !== store.workbench) commitWorkbench(next)
    // A monitored session that no longer exists must leave the grid too.
    const panes = reconcilePanes(store.panes, ids)
    if (panes !== store.panes) commitPanes(panes)
  })

  function commitWorkbench(next) {
    setStore("workbench", next)
    persist(WORKBENCH_KEY, serializeWorkbench(next))
  }

  function commitPanes(next) {
    setStore("panes", next)
    persist(PANES_KEY, serializePanes(next))
  }

  function migrateProjectPreferences(identityRows = projectRows()) {
    const rows = Array.from(identityRows ?? [])
    if (!rows.length) return
    const collapsed = normalizeProjectPreferenceKeys(store.workbench.collapsed, rows)
    const currentCollapsed = [...store.workbench.collapsed]
    if (collapsed.join("\n") !== currentCollapsed.join("\n")) {
      commitWorkbench({ ...store.workbench, collapsed: new Set(collapsed) })
    }
    const pinned = normalizeProjectPreferenceKeys(store.pinnedProjects, rows, 32)
    if (pinned.join("\n") !== store.pinnedProjects.join("\n")) {
      setStore("pinnedProjects", pinned)
      persist(PINNED_PROJECTS_KEY, pinned)
    }
  }

  createEffect(migrateProjectPreferences)

  return {
    get projects() {
      return store.projects
    },
    get sessions() {
      return store.sessions
    },
    get loading() {
      return store.loading
    },
    get error() {
      return store.error
    },
    get loadedAt() {
      return store.loadedAt
    },
    get ready() {
      return (store.phase === "ready" || store.phase === "cached") && store.loadedAt > 0
    },
    get phase() {
      return store.phase
    },
    get workbench() {
      return store.workbench
    },
    get panes() {
      return store.panes
    },
    get pinnedProjects() {
      return store.pinnedProjects
    },
    get hiddenProjects() {
      return store.hiddenProjects
    },
    get registeredProjects() {
      return store.registeredProjects
    },
    get selectedProjectID() {
      return store.selectedProjectID
    },
    get selectedProjectDirectory() {
      return store.selectedProjectDirectory
    },
    get delivery() {
      return store.delivery
    },
    projectRows,
    sessionRows,
    recentSessionRows,
    summary,
    activeSessionID,
    refresh,
    refreshPresence,
    reload: load,
    waitForInitialLoad(timeoutMs = 30_000) {
      if (initialSettled) return Promise.resolve({ phase: store.phase, ready: store.phase === "ready" || store.phase === "cached", cached: store.phase === "cached", error: store.error })
      let timer
      return Promise.race([
        initialLoad,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve({ phase: "timeout", ready: false, error: "Initial portfolio loading exceeded its deadline" }), Math.max(100, Number(timeoutMs) || 30_000))
          timer?.unref?.()
        }),
      ]).finally(() => { if (timer) clearTimeout(timer) })
    },

    selectProject(project) {
      const row = typeof project === "string"
        ? projectRows().find((item) => item.id === project || item.stateKey === project)
        : project
      const projectID = row?.id ?? (typeof project === "string" ? project : null)
      const directory = String(row?.worktree ?? "")
      const id = typeof projectID === "string" && projectID ? projectID : null
      setStore("selectedProjectID", id)
      if (directory) setStore("selectedProjectDirectory", directory)
      persist(SELECTED_PROJECT_KEY, { id, directory: directory || store.selectedProjectDirectory })
    },
    markReviewed(sessionID) {
      const id = String(sessionID ?? "").trim()
      if (!id) return false
      const marking = !store.delivery.reviewed.includes(id)
      const reviewed = marking
        ? [id, ...store.delivery.reviewed].slice(0, 500)
        : store.delivery.reviewed.filter((item) => item !== id)
      const next = { ...store.delivery, reviewed }
      setStore("delivery", next)
      persist(DELIVERY_STATE_KEY, next)
      return marking
    },
    addDecision(input) {
      const decision = decisionRecord(input)
      if (!decision) return false
      const next = normalizeDeliveryState({ ...store.delivery, decisions: [decision, ...store.delivery.decisions.filter((item) => item.id !== decision.id)] })
      setStore("delivery", next)
      persist(DELIVERY_STATE_KEY, next)
      return true
    },
    removeDecision(id) {
      const target = String(id ?? "")
      const decisions = store.delivery.decisions.filter((item) => item.id !== target)
      if (decisions.length === store.delivery.decisions.length) return false
      const next = { ...store.delivery, decisions }
      setStore("delivery", next)
      persist(DELIVERY_STATE_KEY, next)
      return true
    },
    addProject(directory) {
      const target = normalizeDirectories([directory])[0]
      if (!target) return false
      const next = normalizeDirectories([target, ...store.registeredProjects])
      setStore("registeredProjects", next)
      persist(REGISTERED_PROJECTS_KEY, next)
      const hidden = store.hiddenProjects.filter((item) => directoryKey(item) !== directoryKey(target))
      if (hidden.length !== store.hiddenProjects.length) {
        setStore("hiddenProjects", hidden)
        persist(HIDDEN_PROJECTS_KEY, hidden)
      }
      const id = `alonix:${directoryKey(target)}`
      setStore("selectedProjectID", id)
      setStore("selectedProjectDirectory", target)
      persist(SELECTED_PROJECT_KEY, { id, directory: target })
      setStore("projects", reconcile(mergeProjects(store.projects, [target]), { key: "id" }))
      void load()
      return true
    },

    openTab(tab) {
      commitWorkbench(openTab(store.workbench, tab))
    },
    closeTab(id) {
      commitWorkbench(closeTab(store.workbench, id))
    },
    activateTab(id) {
      commitWorkbench(activateTab(store.workbench, id))
    },
    cycleTab(delta) {
      commitWorkbench(cycleTab(store.workbench, delta))
    },
    cycleRecent(delta) {
      commitWorkbench(cycleRecent(store.workbench, delta))
    },
    activateSlot(slot) {
      commitWorkbench(activateSlot(store.workbench, slot))
    },
    togglePinTab(id) {
      commitWorkbench(togglePinTab(store.workbench, id))
    },
    toggleCollapsed(project) {
      const row = typeof project === "object" ? project : projectRows().find((item) => item.id === project || item.stateKey === project)
      const key = row ? projectStateKey(row) : String(project ?? "")
      commitWorkbench(toggleCollapsed(store.workbench, key))
    },
    focusPane(pane) {
      commitWorkbench(focusPane(store.workbench, pane))
    },
    cyclePane(delta, available) {
      commitWorkbench(cyclePane(store.workbench, delta, available))
    },
    setExplorerIndex(index) {
      // Cursor position is transient; persisting it would add write churn
      // without improving restore quality.
      setStore("workbench", setExplorerIndex(store.workbench, index))
    },
    closeOtherTabs(id) {
      const keep = id ?? store.workbench.activeID
      let next = store.workbench
      for (const tab of [...store.workbench.tabs]) {
        if (tab.id !== keep && !tab.pinned) next = closeTab(next, tab.id)
      }
      commitWorkbench(next)
    },
    /**
     * Hide a project from the list.
     *
     * Deliberately not a delete: sessions and files are untouched, and adding
     * the directory again brings it straight back. Keyed by worktree because
     * that is what survives a project being re-registered.
     */
    hideProject(worktree) {
      const target = String(worktree ?? "").trim()
      if (!target) return
      const next = normalizeIds([target, ...store.hiddenProjects], 200)
      setStore("hiddenProjects", next)
      persist(HIDDEN_PROJECTS_KEY, next)
      const registered = store.registeredProjects.filter((item) => directoryKey(item) !== directoryKey(target))
      if (registered.length !== store.registeredProjects.length) {
        setStore("registeredProjects", registered)
        persist(REGISTERED_PROJECTS_KEY, registered)
      }
      if (store.selectedProjectID && projectRows().find((row) => row.id === store.selectedProjectID)?.worktree === target) {
        setStore("selectedProjectID", null)
        setStore("selectedProjectDirectory", "")
        persist(SELECTED_PROJECT_KEY, { id: null, directory: "" })
      }
    },
    unhideProject(worktree) {
      const target = String(worktree ?? "").trim()
      if (!target) return
      const next = store.hiddenProjects.filter((item) => item !== target)
      setStore("hiddenProjects", next)
      persist(HIDDEN_PROJECTS_KEY, next)
    },
    showAllProjects() {
      setStore("hiddenProjects", [])
      persist(HIDDEN_PROJECTS_KEY, [])
    },
    togglePinProject(project) {
      const row = typeof project === "object" ? project : projectRows().find((item) => item.id === project || item.stateKey === project)
      const key = row ? projectStateKey(row) : String(project ?? "")
      if (!key) return
      const current = store.pinnedProjects
      const next = current.includes(key)
        ? current.filter((item) => item !== key)
        : normalizeIds([key, ...current])
      setStore("pinnedProjects", next)
      persist(PINNED_PROJECTS_KEY, next)
    },

    addPane(sessionID) {
      commitPanes(addPane(store.panes, sessionID))
    },
    removePane(sessionID) {
      commitPanes(removePane(store.panes, sessionID))
    },
    focusPaneAt(index) {
      commitPanes(focusPaneAt(store.panes, index))
    },
    focusPane(sessionID) {
      commitPanes(addPane(store.panes, sessionID))
    },
    cyclePaneFocus(delta) {
      commitPanes(cyclePaneFocus(store.panes, delta))
    },
    soloPane(sessionID) {
      commitPanes(soloPane(store.panes, sessionID))
    },
    /** Fill the monitor with whatever is most worth watching right now. */
    autoFillPanes(limit) {
      commitPanes(autoFill(store.panes, sessionRows(), limit))
    },

  }
}

function normalizeIds(value, limit = 32) {
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
