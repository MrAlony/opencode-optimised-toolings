/** @jsxImportSource @opentui/solid */
// Cross-project reactive store for the Alonix workbench.
//
// The host TUI scopes itself to one project directory. This store queries the
// SDK directly for every project and every session so the workbench can present
// the whole portfolio, and persists workbench layout across restarts.

import { createEffect, createMemo, onCleanup } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { buildProjectModel, flattenProjectSessions, recentSessions, summarizeProjects } from "../lib/projects.js"
import { listMessages, listProjects, listSessions, listStatuses } from "../lib/sdk.js"
import { durableStatus, mergeStatus } from "../lib/presence.js"
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
const REFRESH_DEBOUNCE_MS = 150
const RECONCILE_INTERVAL_MS = 5_000
const PRESENCE_LIMIT = 16
const SESSION_LIMIT = 400

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
function directoryKey(value) {
  const normalized = String(value ?? "").trim().replaceAll("\\", "/").replace(/\/+$/, "")
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

function normalizeDirectories(value, limit = 200) {
  const out = []
  const seen = new Set()
  for (const item of Array.from(value ?? [])) {
    const directory = String(item ?? "").trim().replaceAll("\\", "/").replace(/\/+$/, "")
    const key = directoryKey(directory)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(directory)
    if (out.length >= limit) break
  }
  return out
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

async function loadPortfolio(api, registeredDirectories = [], activeSessionID = null) {
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

  const projectSettled = await Promise.allSettled([listProjects(client)])
  const serverProjects = unwrap(projectSettled[0], "projects")
  const projects = mergeProjects(serverProjects, registeredDirectories)

  // Always include the launch directory: it answers before any project record
  // exists and covers sessions whose project is not yet registered.
  const directories = new Set([""])
  for (const project of projects ?? []) {
    const worktree = String(project?.worktree ?? "").trim()
    if (worktree) directories.add(worktree)
  }

  const listFor = (directory) => listSessions(client, { directory, roots: true, limit: SESSION_LIMIT })

  const targets = [...directories]
  const [settled, statusSettled] = await Promise.all([
    Promise.allSettled(targets.map((directory) => listFor(directory))),
    Promise.allSettled(targets.map((directory) => listStatuses(client, directory))),
  ])

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
      if (candidates.length >= PRESENCE_LIMIT) break
    }
    const messageResults = await Promise.allSettled(candidates.map((session) => listMessages(client, session, 1)))
    messageResults.forEach((result, index) => {
      if (result.status !== "fulfilled") return
      const inferred = durableStatus(result.value)
      if (inferred) durableStatuses[candidates[index].id] = inferred
    })
  }

  const statuses = {}
  for (const session of sessions ?? []) statuses[session.id] = mergeStatus(liveStatuses[session.id], durableStatuses[session.id])

  return {
    projects,
    // `undefined` means "nothing loaded", which preserves the previous list.
    sessions,
    statuses,
    errors,
  }
}

function errorText(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

export function createProjectStore(api) {
  const [store, setStore] = createStore({
    projects: [],
    sessions: [],
    statuses: {},
    registeredProjects: normalizeDirectories(readKv(api, REGISTERED_PROJECTS_KEY, [])),
    selectedProjectID: null,
    selectedProjectDirectory: "",
    pinnedProjects: normalizeIds(readKv(api, PINNED_PROJECTS_KEY, [])),
    hiddenProjects: normalizeIds(readKv(api, HIDDEN_PROJECTS_KEY, []), 200),
    workbench: createWorkbench(readKv(api, WORKBENCH_KEY, {})),
    panes: createPanes(readKv(api, PANES_KEY, {})),
    loading: false,
    error: "",
    loadedAt: 0,
  })

  let inFlight = false
  let queued = false
  let debounce = null
  let disposed = false

  async function load() {
    if (disposed) return
    const persistedProjects = normalizeDirectories(readKv(api, REGISTERED_PROJECTS_KEY, store.registeredProjects))
    if (persistedProjects.join("\n") !== store.registeredProjects.join("\n")) {
      setStore("registeredProjects", persistedProjects)
    }
    if (inFlight) {
      queued = true
      return
    }
    inFlight = true
    setStore("loading", true)
    try {
      const { projects, sessions, statuses, errors } = await loadPortfolio(api, store.registeredProjects, activeSessionID())
      if (disposed) return
      // Only overwrite a list that actually loaded, so a partial failure keeps
      // the last good data instead of emptying the workbench.
      if (projects) setStore("projects", reconcile(projects, { key: "id" }))
      if (sessions) setStore("sessions", reconcile(sessions, { key: "id" }))
      if (statuses) setStore("statuses", reconcile(statuses))
      setStore("error", errors.length ? errors.join("; ") : "")
      if (projects || sessions) setStore("loadedAt", Date.now())
    } catch (error) {
      // Keep the last good portfolio; a blank workbench is worse than a stale one.
      if (!disposed) setStore("error", errorText(error))
    } finally {
      inFlight = false
      if (!disposed) setStore("loading", false)
      if (queued && !disposed) {
        queued = false
        void load()
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

  // Subscribing to only `session.updated` left the sidebar stale: a new session
  // never appeared, and a session that started working kept showing as idle.
  // These are the events that actually change what the sidebar displays.
  const WATCHED_EVENTS = [
    "session.created",
    "session.updated",
    "session.deleted",
    "session.idle",
    "session.status",
    "session.error",
    "session.diff",
    "session.compacted",
    "message.updated",
    "message.part.updated",
    "project.updated",
    "project.directories.updated",
  ]

  const offs = []
  for (const event of WATCHED_EVENTS) {
    try {
      const off = api?.event?.on?.(event, refresh)
      if (typeof off === "function") offs.push(off)
    } catch {
      // Unknown event names are ignored; the initial load still populates.
    }
  }

  const reconcileTimer = setInterval(() => {
    if (!disposed) void load()
  }, RECONCILE_INTERVAL_MS)

  onCleanup(() => {
    disposed = true
    clearInterval(reconcileTimer)
    if (debounce) clearTimeout(debounce)
    for (const off of offs) {
      try {
        off()
      } catch {
        // best effort
      }
    }
  })

  const statuses = () => {
    const map = { ...store.statuses }
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

  void load()

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
    writeKv(api, WORKBENCH_KEY, serializeWorkbench(next))
  }

  function commitPanes(next) {
    setStore("panes", next)
    writeKv(api, PANES_KEY, serializePanes(next))
  }

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
    projectRows,
    sessionRows,
    recentSessionRows,
    summary,
    activeSessionID,
    refresh,
    reload: load,

    selectProject(project) {
      const projectID = typeof project === "string" ? project : project?.id
      const directory = typeof project === "object" ? String(project?.worktree ?? "") : ""
      setStore("selectedProjectID", typeof projectID === "string" && projectID ? projectID : null)
      if (directory) setStore("selectedProjectDirectory", directory)
    },
    addProject(directory) {
      const target = normalizeDirectories([directory])[0]
      if (!target) return false
      const next = normalizeDirectories([target, ...store.registeredProjects])
      setStore("registeredProjects", next)
      writeKv(api, REGISTERED_PROJECTS_KEY, next)
      const hidden = store.hiddenProjects.filter((item) => directoryKey(item) !== directoryKey(target))
      if (hidden.length !== store.hiddenProjects.length) {
        setStore("hiddenProjects", hidden)
        writeKv(api, HIDDEN_PROJECTS_KEY, hidden)
      }
      const id = `alonix:${directoryKey(target)}`
      setStore("selectedProjectID", id)
      setStore("selectedProjectDirectory", target)
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
    toggleCollapsed(projectID) {
      commitWorkbench(toggleCollapsed(store.workbench, projectID))
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
      writeKv(api, HIDDEN_PROJECTS_KEY, next)
      const registered = store.registeredProjects.filter((item) => directoryKey(item) !== directoryKey(target))
      if (registered.length !== store.registeredProjects.length) {
        setStore("registeredProjects", registered)
        writeKv(api, REGISTERED_PROJECTS_KEY, registered)
      }
      if (store.selectedProjectID && projectRows().find((row) => row.id === store.selectedProjectID)?.worktree === target) {
        setStore("selectedProjectID", null)
      }
    },
    unhideProject(worktree) {
      const target = String(worktree ?? "").trim()
      if (!target) return
      const next = store.hiddenProjects.filter((item) => item !== target)
      setStore("hiddenProjects", next)
      writeKv(api, HIDDEN_PROJECTS_KEY, next)
    },
    showAllProjects() {
      setStore("hiddenProjects", [])
      writeKv(api, HIDDEN_PROJECTS_KEY, [])
    },
    togglePinProject(projectID) {
      if (typeof projectID !== "string" || !projectID) return
      const current = store.pinnedProjects
      const next = current.includes(projectID)
        ? current.filter((item) => item !== projectID)
        : normalizeIds([projectID, ...current])
      setStore("pinnedProjects", next)
      writeKv(api, PINNED_PROJECTS_KEY, next)
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
