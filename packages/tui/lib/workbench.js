// Workbench state machine.
//
// Models the editor-like surface of the IDE: open session tabs, most-recently-
// used ordering, focus, and pane navigation. Implemented as pure reducers over
// an immutable state object so every interaction is verifiable and undoable
// without a renderer.

export const PANES = ["explorer", "main", "detail"]

export const MAX_TABS = 12

/** Initial workbench state. */
export function createWorkbench(initial = {}) {
  const tabs = normalizeTabs(initial.tabs)
  const activeID = tabs.some((tab) => tab.id === initial.activeID) ? initial.activeID : (tabs[0]?.id ?? null)
  return {
    tabs,
    activeID,
    // MRU is separate from tab order: tab order is stable and user-visible,
    // MRU drives ctrl-tab style switching where recency is what matters.
    mru: normalizeMru(initial.mru ?? tabs.map((tab) => tab.id), tabs),
    focus: PANES.includes(initial.focus) ? initial.focus : "main",
    explorerIndex: Math.max(0, Number(initial.explorerIndex) || 0),
    collapsed: new Set(Array.from(initial.collapsed ?? [])),
  }
}

function normalizeTabs(value) {
  const seen = new Set()
  const out = []
  for (const tab of Array.from(value ?? [])) {
    if (!tab || typeof tab.id !== "string" || !tab.id || seen.has(tab.id)) continue
    seen.add(tab.id)
    out.push({
      id: tab.id,
      title: String(tab.title ?? ""),
      projectID: tab.projectID ?? null,
      projectName: String(tab.projectName ?? ""),
      directory: String(tab.directory ?? ""),
      pinned: tab.pinned === true,
    })
    if (out.length >= MAX_TABS) break
  }
  return out
}

function normalizeMru(value, tabs) {
  const valid = new Set(tabs.map((tab) => tab.id))
  const seen = new Set()
  const out = []
  for (const id of Array.from(value ?? [])) {
    if (typeof id !== "string" || !valid.has(id) || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  // Any tab missing from MRU is appended so the two never drift apart.
  for (const tab of tabs) if (!seen.has(tab.id)) out.push(tab.id)
  return out
}

function touch(state, id) {
  return { ...state, activeID: id, mru: [id, ...state.mru.filter((item) => item !== id)] }
}

/**
 * Open a session tab, or focus it when already open.
 *
 * Unpinned tabs are evicted by least-recent use once the limit is reached, so
 * long sessions of exploration never grow the tab strip without bound.
 */
export function openTab(state, tab) {
  if (!tab || typeof tab.id !== "string" || !tab.id) return state
  const existing = state.tabs.find((item) => item.id === tab.id)
  if (existing) return touch(state, tab.id)

  const next = [...state.tabs, normalizeTabs([tab])[0]]
  let tabs = next
  if (next.length > MAX_TABS) {
    const evictable = [...state.mru].reverse().find((id) => {
      const candidate = state.tabs.find((item) => item.id === id)
      return candidate && !candidate.pinned
    })
    tabs = evictable ? next.filter((item) => item.id !== evictable) : next.slice(-MAX_TABS)
  }
  return touch({ ...state, tabs, mru: normalizeMru(state.mru, tabs) }, tab.id)
}

/** Close a tab and activate the most recent surviving one. */
export function closeTab(state, id) {
  if (!state.tabs.some((tab) => tab.id === id)) return state
  const tabs = state.tabs.filter((tab) => tab.id !== id)
  const mru = state.mru.filter((item) => item !== id)
  const activeID = state.activeID === id ? (mru[0] ?? tabs[0]?.id ?? null) : state.activeID
  return { ...state, tabs, mru, activeID }
}

export function activateTab(state, id) {
  if (!state.tabs.some((tab) => tab.id === id)) return state
  return touch(state, id)
}

/** Cycle by tab-strip order (stable, positional). */
export function cycleTab(state, delta = 1) {
  if (state.tabs.length === 0) return state
  const index = state.tabs.findIndex((tab) => tab.id === state.activeID)
  const base = index < 0 ? 0 : index
  const size = state.tabs.length
  const next = ((base + delta) % size + size) % size
  return touch(state, state.tabs[next].id)
}

/** Cycle by recency (ctrl-tab semantics). */
export function cycleRecent(state, delta = 1) {
  if (state.mru.length === 0) return state
  const size = state.mru.length
  const index = state.mru.indexOf(state.activeID)
  const base = index < 0 ? 0 : index
  const next = ((base + delta) % size + size) % size
  return touch(state, state.mru[next])
}

/** Jump to a 1-based tab slot; out-of-range slots are ignored. */
export function activateSlot(state, slot) {
  const index = Math.floor(Number(slot) || 0) - 1
  if (index < 0 || index >= state.tabs.length) return state
  return touch(state, state.tabs[index].id)
}

export function togglePinTab(state, id) {
  if (!state.tabs.some((tab) => tab.id === id)) return state
  return { ...state, tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, pinned: !tab.pinned } : tab)) }
}

/** Move a tab within the strip, clamped to the ends. */
export function moveTab(state, id, delta) {
  const index = state.tabs.findIndex((tab) => tab.id === id)
  if (index < 0) return state
  const target = Math.max(0, Math.min(state.tabs.length - 1, index + Math.trunc(Number(delta) || 0)))
  if (target === index) return state
  const tabs = [...state.tabs]
  const [moved] = tabs.splice(index, 1)
  tabs.splice(target, 0, moved)
  return { ...state, tabs }
}

/** Move focus between panes, skipping panes the layout is not showing. */
export function focusPane(state, pane) {
  if (!PANES.includes(pane)) return state
  return { ...state, focus: pane }
}

export function cyclePane(state, delta = 1, available = PANES) {
  const panes = PANES.filter((pane) => available.includes(pane))
  if (panes.length === 0) return state
  const index = panes.indexOf(state.focus)
  const base = index < 0 ? 0 : index
  const size = panes.length
  const next = ((base + delta) % size + size) % size
  return { ...state, focus: panes[next] }
}

export function toggleCollapsed(state, projectID) {
  if (typeof projectID !== "string" || !projectID) return state
  const collapsed = new Set(state.collapsed)
  if (collapsed.has(projectID)) collapsed.delete(projectID)
  else collapsed.add(projectID)
  return { ...state, collapsed }
}

export function setExplorerIndex(state, index) {
  return { ...state, explorerIndex: Math.max(0, Math.floor(Number(index) || 0)) }
}

export function activeTab(state) {
  return state.tabs.find((tab) => tab.id === state.activeID) ?? null
}

/** Tabs decorated with their 1-based slot for display and quick-jump. */
export function tabsWithSlots(state) {
  return state.tabs.map((tab, index) => ({
    ...tab,
    slot: index < 9 ? index + 1 : null,
    active: tab.id === state.activeID,
  }))
}

/**
 * Serializable snapshot for persistence. `Set` and derived data are dropped so
 * the value round-trips through JSON without custom handling.
 */
export function serializeWorkbench(state) {
  return {
    tabs: state.tabs,
    activeID: state.activeID,
    mru: state.mru,
    focus: state.focus,
    collapsed: [...state.collapsed],
  }
}

/**
 * Drop tabs whose sessions no longer exist. Deleted sessions must not linger in
 * the strip and must never remain the active tab.
 */
export function reconcileTabs(state, sessionIDs) {
  const valid = new Set(Array.from(sessionIDs ?? []))
  if (state.tabs.every((tab) => valid.has(tab.id))) return state
  const tabs = state.tabs.filter((tab) => valid.has(tab.id))
  const mru = state.mru.filter((id) => valid.has(id))
  const activeID = valid.has(state.activeID) ? state.activeID : (mru[0] ?? tabs[0]?.id ?? null)
  return { ...state, tabs, mru, activeID }
}
