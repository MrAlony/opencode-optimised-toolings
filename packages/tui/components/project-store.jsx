/** @jsxImportSource @opentui/solid */
// Cross-project reactive store for the Alonix workbench.
//
// The host TUI scopes itself to one project directory. This store queries the
// SDK directly for every project and every session so the workbench can present
// the whole portfolio, and persists workbench layout across restarts.

import { createEffect, createMemo, onCleanup } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { buildProjectModel, flattenProjectSessions, summarizeProjects } from "../lib/projects.js"
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

const PANES_KEY = "alonix_monitor_panes"
const WORKBENCH_KEY = "alonix_workbench_state"
const PINNED_PROJECTS_KEY = "alonix_pinned_projects"
const REFRESH_DEBOUNCE_MS = 150
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
 * Load every project and session the server knows about.
 *
 * Sessions are fetched unscoped (`scope: "project"` is deliberately omitted)
 * so the result spans directories rather than only the launch project.
 *
 * Each list resolves independently and a failure is reported rather than
 * flattened into an empty array. Blanking the workbench because one request
 * failed would be far worse than showing slightly stale data, so the caller
 * keeps the previous value for whichever list did not load.
 */
async function loadPortfolio(api) {
  const client = api?.client
  if (!client) return { projects: [], sessions: [], errors: [] }

  const [projectResult, sessionResult] = await Promise.allSettled([
    Promise.resolve(client.project?.list?.({})),
    Promise.resolve(client.session?.list?.({ roots: true, limit: SESSION_LIMIT })),
  ])

  const errors = []
  const unwrap = (settled, label) => {
    if (settled.status === "rejected") {
      errors.push(`${label}: ${errorText(settled.reason)}`)
      return undefined
    }
    const data = settled.value?.data
    return Array.isArray(data) ? data : undefined
  }

  return {
    projects: unwrap(projectResult, "projects"),
    sessions: unwrap(sessionResult, "sessions"),
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
    pinnedProjects: normalizeIds(readKv(api, PINNED_PROJECTS_KEY, [])),
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
    if (inFlight) {
      queued = true
      return
    }
    inFlight = true
    setStore("loading", true)
    try {
      const { projects, sessions, errors } = await loadPortfolio(api)
      if (disposed) return
      // Only overwrite a list that actually loaded, so a partial failure keeps
      // the last good data instead of emptying the workbench.
      if (projects) setStore("projects", reconcile(projects, { key: "id" }))
      if (sessions) setStore("sessions", reconcile(sessions, { key: "id" }))
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

  const offs = []
  for (const event of ["session.updated", "session.deleted", "session.idle", "project.updated"]) {
    try {
      const off = api?.event?.on?.(event, refresh)
      if (typeof off === "function") offs.push(off)
    } catch {
      // Unknown event names are ignored; the initial load still populates.
    }
  }

  onCleanup(() => {
    disposed = true
    if (debounce) clearTimeout(debounce)
    for (const off of offs) {
      try {
        off()
      } catch {
        // best effort
      }
    }
  })

  void load()

  const statuses = () => {
    const map = {}
    for (const session of store.sessions) {
      if (!session?.id) continue
      try {
        const status = api?.state?.session?.status?.(session.id)
        if (status) map[session.id] = status
      } catch {
        // status is only available for locally-synced sessions
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
      pinnedProjects: store.pinnedProjects,
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

  const sessionRows = createMemo(() => flattenProjectSessions(projectRows()))
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
    projectRows,
    sessionRows,
    summary,
    activeSessionID,
    refresh,
    reload: load,

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

    /**
     * Create a session in an explicit directory. This is what makes the
     * workbench genuinely multi-project: the host would otherwise only ever
     * create sessions in its own launch directory.
     *
     * The host itself only creates a session when a prompt is submitted, so
     * this is reserved for an explicit user action. Calling it speculatively
     * litters the list with empty sessions.
     */
    async createSession({ directory, title } = {}) {
      const body = title ? { title } : {}
      const query = directory ? { directory } : {}
      const result = await api?.client?.session?.create?.({ body, query })
      if (result?.error) {
        const detail = result.error?.message ?? JSON.stringify(result.error)
        throw new Error(`Could not create a session: ${detail}`)
      }
      const created = result?.data
      if (created?.id) refresh()
      return created ?? null
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
