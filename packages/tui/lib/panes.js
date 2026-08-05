// Split-pane state for watching several sessions at once.
//
// The workbench can show up to four live sessions side by side, each running
// its own agent, so work in different projects is visible simultaneously
// instead of one-at-a-time. Pure reducers over an immutable value, so the
// grid maths and every transition are verifiable without a renderer.

export const MAX_PANES = 4

export const GRID_MODES = ["single", "columns", "grid"]

/**
 * Pane geometry for a viewport.
 *
 * A terminal cannot show four readable columns below roughly 160 cells, so the
 * arrangement degrades rather than producing unusable slivers: 2x2 becomes two
 * stacked rows, then a single pane. `minPaneWidth` is the readability floor.
 */
export function paneGrid(count, viewport = {}, options = {}) {
  const width = Math.max(20, Math.floor(Number(viewport.width) || 80))
  const height = Math.max(8, Math.floor(Number(viewport.height) || 24))
  const requested = Math.max(1, Math.min(MAX_PANES, Math.floor(Number(count) || 1)))
  const minPaneWidth = Math.max(24, Math.floor(Number(options.minPaneWidth) || 44))
  const minPaneHeight = Math.max(6, Math.floor(Number(options.minPaneHeight) || 10))

  // How many panes fit at a readable size. Gaps consume cells too, so they are
  // part of the budget; ignoring them yields panes below the stated floor.
  const gapUnit = 1
  const columnsThatFit = Math.max(1, Math.floor((width + gapUnit) / (minPaneWidth + gapUnit)))
  const rowsThatFit = Math.max(1, Math.floor((height + gapUnit) / (minPaneHeight + gapUnit)))

  let columns = Math.min(requested, columnsThatFit)
  let rows = Math.max(1, Math.ceil(requested / columns))
  if (rows > rowsThatFit) {
    rows = rowsThatFit
    columns = Math.min(columnsThatFit, Math.max(1, Math.ceil(requested / rows)))
  }

  const visible = Math.max(1, Math.min(requested, columns * rows))
  // Recompute so the grid is tight around what is actually shown.
  columns = Math.min(columns, visible)
  rows = Math.max(1, Math.ceil(visible / columns))

  const gap = visible > 1 ? 1 : 0
  const paneWidth = Math.max(1, Math.floor((width - gap * (columns - 1)) / columns))
  const paneHeight = Math.max(1, Math.floor((height - gap * (rows - 1)) / rows))

  return {
    requested,
    visible,
    hidden: requested - visible,
    columns,
    rows,
    gap,
    paneWidth,
    paneHeight,
    mode: visible === 1 ? "single" : rows === 1 ? "columns" : "grid",
    // True when the viewport forced fewer panes than the user asked for.
    constrained: visible < requested,
  }
}

/** Position of each visible pane, for rendering and hit-testing. */
export function paneSlots(grid) {
  const slots = []
  for (let index = 0; index < grid.visible; index += 1) {
    const row = Math.floor(index / grid.columns)
    const column = index % grid.columns
    slots.push({
      index,
      row,
      column,
      x: column * (grid.paneWidth + grid.gap),
      y: row * (grid.paneHeight + grid.gap),
      width: grid.paneWidth,
      height: grid.paneHeight,
    })
  }
  return slots
}

function normalize(ids) {
  const seen = new Set()
  const out = []
  for (const id of Array.from(ids ?? [])) {
    if (typeof id !== "string" || !id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
    if (out.length >= MAX_PANES) break
  }
  return out
}

export function createPanes(initial = {}) {
  const ids = normalize(initial.ids)
  const focus = ids.includes(initial.focus) ? initial.focus : (ids[0] ?? null)
  return { ids, focus }
}

/**
 * Add a session to the grid, or focus it when already shown.
 *
 * At capacity the least-recently focused pane is replaced, so adding a session
 * always succeeds instead of silently doing nothing.
 */
export function addPane(state, sessionID) {
  if (typeof sessionID !== "string" || !sessionID) return state
  if (state.ids.includes(sessionID)) return { ...state, focus: sessionID }
  if (state.ids.length < MAX_PANES) {
    return { ids: [...state.ids, sessionID], focus: sessionID }
  }
  const replaceIndex = state.ids.findIndex((id) => id !== state.focus)
  const target = replaceIndex < 0 ? 0 : replaceIndex
  const ids = [...state.ids]
  ids[target] = sessionID
  return { ids, focus: sessionID }
}

export function removePane(state, sessionID) {
  if (!state.ids.includes(sessionID)) return state
  const ids = state.ids.filter((id) => id !== sessionID)
  const focus = state.focus === sessionID ? (ids[0] ?? null) : state.focus
  return { ids, focus }
}

export function focusPaneAt(state, index) {
  const position = Math.floor(Number(index) || 0)
  if (position < 0 || position >= state.ids.length) return state
  return { ...state, focus: state.ids[position] }
}

export function cyclePaneFocus(state, delta = 1) {
  if (state.ids.length === 0) return state
  const size = state.ids.length
  const current = state.ids.indexOf(state.focus)
  const base = current < 0 ? 0 : current
  const next = ((base + Math.trunc(Number(delta) || 0)) % size + size) % size
  return { ...state, focus: state.ids[next] }
}

/** Swap two panes so the user can arrange the grid. */
export function movePane(state, sessionID, delta) {
  const index = state.ids.indexOf(sessionID)
  if (index < 0) return state
  const target = index + Math.trunc(Number(delta) || 0)
  if (target < 0 || target >= state.ids.length) return state
  const ids = [...state.ids]
  ids[index] = ids[target]
  ids[target] = sessionID
  return { ...state, ids }
}

/** Collapse to just the focused session. */
export function soloPane(state, sessionID) {
  const id = sessionID ?? state.focus
  if (!id || !state.ids.includes(id)) return state
  return { ids: [id], focus: id }
}

/** Drop panes whose sessions no longer exist. */
export function reconcilePanes(state, sessionIDs) {
  const valid = new Set(Array.from(sessionIDs ?? []))
  if (state.ids.every((id) => valid.has(id))) return state
  const ids = state.ids.filter((id) => valid.has(id))
  const focus = valid.has(state.focus) ? state.focus : (ids[0] ?? null)
  return { ids, focus }
}

export function serializePanes(state) {
  return { ids: state.ids, focus: state.focus }
}

/**
 * Fill the grid with the sessions most worth watching.
 *
 * Running sessions first, then most recently updated: the point of the monitor
 * is to see active work, so idle sessions never displace a live one.
 */
export function autoFill(state, sessions, limit = MAX_PANES) {
  const size = Math.max(1, Math.min(MAX_PANES, Math.floor(Number(limit) || MAX_PANES)))
  const ranked = Array.from(sessions ?? [])
    .filter((session) => session && typeof session.id === "string")
    .sort((a, b) => {
      if (Boolean(a.running) !== Boolean(b.running)) return a.running ? -1 : 1
      return (Number(b.updated) || 0) - (Number(a.updated) || 0)
    })

  const ids = []
  // Keep panes the user already chose, so an auto-fill never steals focus.
  for (const id of state.ids) {
    if (ids.length >= size) break
    if (ranked.some((session) => session.id === id)) ids.push(id)
  }
  for (const session of ranked) {
    if (ids.length >= size) break
    if (!ids.includes(session.id)) ids.push(session.id)
  }
  const focus = ids.includes(state.focus) ? state.focus : (ids[0] ?? null)
  return { ids, focus }
}
