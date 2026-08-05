/** @jsxImportSource @opentui/solid */
// Reactive runtime shared by every Alonix IDE surface.
//
// Three concerns live here because they must be singletons per plugin instance:
//   1. Theme-reactive design tokens (recomputed only when the theme changes).
//   2. One animation clock for the whole UI instead of a timer per component.
//   3. One session store fed by host events instead of per-surface polling.

import { createContext, createEffect, createMemo, createSignal, onCleanup, useContext } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { createTokens } from "../lib/design.js"
import { buildSessionModel, normalizePins, togglePin } from "../lib/sessions.js"

const PIN_KEY = "alonix_ide_pinned_sessions"
const CLOCK_INTERVAL_MS = 80
const REFRESH_DEBOUNCE_MS = 120

/**
 * Theme-reactive tokens. `api.theme.current` is a live proxy, so reading it
 * inside a memo subscribes the whole IDE to theme changes.
 */
export function createSkin(api, options = {}) {
  const motion = options.motion !== false
  return createMemo(() => {
    const current = (() => {
      try {
        return api?.theme?.current ?? {}
      } catch {
        return {}
      }
    })()
    // Touch each consumed channel so the memo tracks the theme proxy.
    const snapshot = {}
    for (const key of [
      "background",
      "backgroundPanel",
      "backgroundElement",
      "backgroundMenu",
      "text",
      "textMuted",
      "border",
      "borderActive",
      "primary",
      "secondary",
      "accent",
      "success",
      "warning",
      "error",
      "info",
      "diffAdded",
      "diffRemoved",
    ]) {
      snapshot[key] = current[key]
    }
    return createTokens(snapshot, { motion })
  })
}

const ClockContext = createContext(null)

/**
 * Single interval driving all animation. It only runs while at least one
 * surface is subscribed, so an idle IDE costs nothing.
 */
export function createClock(enabled = true) {
  const [elapsed, setElapsed] = createSignal(0)
  const [subscribers, setSubscribers] = createSignal(0)
  const start = Date.now()
  let timer = null

  createEffect(() => {
    const active = enabled && subscribers() > 0
    if (!active) {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
      return
    }
    if (timer) return
    timer = setInterval(() => setElapsed(Date.now() - start), CLOCK_INTERVAL_MS)
  })

  onCleanup(() => {
    if (timer) clearInterval(timer)
    timer = null
  })

  return {
    elapsed,
    enabled: () => enabled,
    subscribe() {
      setSubscribers((value) => value + 1)
      onCleanup(() => setSubscribers((value) => Math.max(0, value - 1)))
    },
  }
}

export function ClockProvider(props) {
  return <ClockContext.Provider value={props.clock}>{props.children}</ClockContext.Provider>
}

/**
 * Subscribe to the shared clock. Returns a `() => number` of elapsed ms, or a
 * constant 0 when motion is disabled so callers need no branching.
 */
export function useClock(active = () => true) {
  const clock = useContext(ClockContext)
  if (!clock || !clock.enabled()) return () => 0
  const [live, setLive] = createSignal(false)
  createEffect(() => setLive(Boolean(typeof active === "function" ? active() : active)))
  createEffect(() => {
    if (!live()) return
    clock.subscribe()
  })
  return () => (live() ? clock.elapsed() : 0)
}

/**
 * Session store.
 *
 * The plugin state API exposes per-session lookups but no listing, so the list
 * comes from the SDK client and is refreshed on host session events. Refreshes
 * are debounced and single-flighted; a failed refresh keeps the last good list
 * rather than blanking the switcher.
 */
export function createSessionStore(api) {
  const [store, setStore] = createStore({
    sessions: [],
    pinned: normalizePins(readPins(api)),
    query: "",
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
      const result = await api?.client?.session?.list?.({ roots: true, limit: 200 })
      const data = Array.isArray(result?.data) ? result.data : []
      if (!disposed) {
        setStore("sessions", reconcile(data, { key: "id" }))
        setStore("error", "")
        setStore("loadedAt", Date.now())
      }
    } catch (error) {
      // Keep the previous list; an empty switcher is worse than a stale one.
      if (!disposed) setStore("error", error instanceof Error ? error.message : String(error))
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
  for (const event of ["session.updated", "session.deleted", "session.idle"]) {
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
        // status is optional
      }
    }
    return map
  }

  const diffs = () => {
    const map = {}
    for (const session of store.sessions) {
      if (!session?.id) continue
      try {
        const diff = api?.state?.session?.diff?.(session.id)
        if (diff) map[session.id] = Array.from(diff)
      } catch {
        // diff is optional
      }
    }
    return map
  }

  return {
    get sessions() {
      return store.sessions
    },
    get pinned() {
      return store.pinned
    },
    get query() {
      return store.query
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
    setQuery(value) {
      setStore("query", String(value ?? ""))
    },
    togglePin(id) {
      const next = togglePin(store.pinned, id)
      setStore("pinned", next)
      try {
        api?.kv?.set?.(PIN_KEY, next)
      } catch {
        // KV is best effort; pins stay for this process either way.
      }
      return next
    },
    refresh,
    reload: load,
    /** Ranked, decorated rows for the current query and active session. */
    model(activeID, query) {
      return buildSessionModel({
        sessions: store.sessions,
        statuses: statuses(),
        diffs: diffs(),
        pinned: store.pinned,
        query: query ?? store.query,
        activeID,
        now: Date.now(),
      })
    },
  }
}

function readPins(api) {
  try {
    return api?.kv?.get?.(PIN_KEY, [])
  } catch {
    return []
  }
}

/** Current session id from the host route, or null on home/plugin routes. */
export function activeSessionID(api) {
  try {
    const current = api?.route?.current
    if (current?.name !== "session") return null
    const id = current?.params?.sessionID
    return typeof id === "string" && id ? id : null
  } catch {
    return null
  }
}

/** Navigate to a session and close any open dialog. Safe to call anywhere. */
export function openSession(api, sessionID) {
  if (typeof sessionID !== "string" || !sessionID) return false
  try {
    api.route.navigate("session", { sessionID })
    try {
      api.ui.dialog.clear()
    } catch {
      // no dialog open
    }
    return true
  } catch {
    return false
  }
}
