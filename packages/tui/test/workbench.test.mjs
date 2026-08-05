import test from "node:test"
import assert from "node:assert/strict"
import {
  MAX_TABS,
  activateSlot,
  activateTab,
  activeTab,
  closeTab,
  createWorkbench,
  cyclePane,
  cycleRecent,
  cycleTab,
  focusPane,
  moveTab,
  openTab,
  reconcileTabs,
  serializeWorkbench,
  tabsWithSlots,
  toggleCollapsed,
  togglePinTab,
} from "../lib/workbench.js"

function tab(id, extra = {}) {
  return { id, title: `Session ${id}`, projectID: "p1", projectName: "Alpha", directory: "C:/work/alpha", ...extra }
}

function withTabs(ids) {
  return ids.reduce((state, id) => openTab(state, tab(id)), createWorkbench())
}

test("a new workbench is empty and focused on the main pane", () => {
  const state = createWorkbench()
  assert.deepEqual(state.tabs, [])
  assert.equal(state.activeID, null)
  assert.equal(state.focus, "main")
  assert.equal(activeTab(state), null)
})

test("opening a tab activates it; reopening focuses instead of duplicating", () => {
  let state = openTab(createWorkbench(), tab("a"))
  assert.equal(state.activeID, "a")
  state = openTab(state, tab("b"))
  assert.equal(state.tabs.length, 2)
  assert.equal(state.activeID, "b")

  state = openTab(state, tab("a"))
  assert.equal(state.tabs.length, 2, "reopening must not duplicate")
  assert.equal(state.activeID, "a")
  assert.equal(state.mru[0], "a")
})

test("invalid tabs are rejected without corrupting state", () => {
  const base = withTabs(["a"])
  for (const bad of [null, undefined, {}, { id: "" }, { id: 5 }]) {
    assert.deepEqual(openTab(base, bad).tabs, base.tabs)
  }
})

test("closing activates the most recently used survivor", () => {
  let state = withTabs(["a", "b", "c"])
  state = activateTab(state, "a")
  state = activateTab(state, "b")
  // MRU is now b, a, c and b is active.
  state = closeTab(state, "b")
  assert.equal(state.activeID, "a", "closing the active tab falls back to MRU")
  assert.equal(state.tabs.length, 2)

  // Closing an inactive tab leaves the active one alone.
  const before = state.activeID
  state = closeTab(state, "c")
  assert.equal(state.activeID, before)

  // Closing the last tab empties cleanly.
  state = closeTab(state, "a")
  assert.equal(state.activeID, null)
  assert.deepEqual(state.tabs, [])
})

test("closing an unknown tab is a no-op", () => {
  const state = withTabs(["a"])
  assert.equal(closeTab(state, "zzz"), state)
})

test("tab cycling is positional and wraps in both directions", () => {
  let state = withTabs(["a", "b", "c"])
  state = activateTab(state, "a")
  assert.equal(cycleTab(state, 1).activeID, "b")
  assert.equal(cycleTab(state, -1).activeID, "c", "cycling back from the first wraps to the last")
  state = activateTab(state, "c")
  assert.equal(cycleTab(state, 1).activeID, "a")
  assert.equal(cycleTab(createWorkbench(), 1).activeID, null)
})

test("recent cycling follows use order, not tab order", () => {
  let state = withTabs(["a", "b", "c"])
  state = activateTab(state, "a")
  state = activateTab(state, "c")
  // MRU: c, a, b
  assert.equal(state.mru[0], "c")
  assert.equal(cycleRecent(state, 1).activeID, "a", "next-recent is the previous session")
})

test("slots jump directly and ignore out-of-range values", () => {
  const state = withTabs(["a", "b", "c"])
  assert.equal(activateSlot(state, 2).activeID, "b")
  assert.equal(activateSlot(state, 9), state)
  assert.equal(activateSlot(state, 0), state)
  assert.deepEqual(tabsWithSlots(state).map((t) => t.slot), [1, 2, 3])
})

test("the tab strip is bounded and evicts the least recent unpinned tab", () => {
  let state = createWorkbench()
  for (let index = 0; index < MAX_TABS; index += 1) state = openTab(state, tab(`t${index}`))
  assert.equal(state.tabs.length, MAX_TABS)

  // t0 is the least recently used; opening one more must evict it.
  state = openTab(state, tab("overflow"))
  assert.equal(state.tabs.length, MAX_TABS)
  assert.ok(!state.tabs.some((t) => t.id === "t0"), "least-recent tab should be evicted")
  assert.ok(state.tabs.some((t) => t.id === "overflow"))
})

test("pinned tabs survive eviction pressure", () => {
  let state = createWorkbench()
  for (let index = 0; index < MAX_TABS; index += 1) state = openTab(state, tab(`t${index}`))
  state = togglePinTab(state, "t0")
  state = openTab(state, tab("overflow"))
  assert.ok(state.tabs.some((t) => t.id === "t0"), "a pinned tab must not be evicted")
  assert.ok(!state.tabs.some((t) => t.id === "t1"), "the next unpinned tab is evicted instead")
})

test("tabs can be reordered and clamp at the ends", () => {
  const state = withTabs(["a", "b", "c"])
  assert.deepEqual(moveTab(state, "a", 1).tabs.map((t) => t.id), ["b", "a", "c"])
  assert.deepEqual(moveTab(state, "a", -1).tabs.map((t) => t.id), ["a", "b", "c"], "clamped at the start")
  assert.deepEqual(moveTab(state, "c", 5).tabs.map((t) => t.id), ["a", "b", "c"], "clamped at the end")
  assert.equal(moveTab(state, "zzz", 1), state)
})

test("pane focus cycles only through available panes", () => {
  const state = createWorkbench()
  assert.equal(focusPane(state, "explorer").focus, "explorer")
  assert.equal(focusPane(state, "nonsense"), state)
  // On a narrow layout only main is available, so cycling stays put.
  assert.equal(cyclePane(state, 1, ["main"]).focus, "main")
  assert.equal(cyclePane(state, 1, ["explorer", "main"]).focus, "explorer")
})

test("project sections collapse and expand", () => {
  let state = toggleCollapsed(createWorkbench(), "p1")
  assert.ok(state.collapsed.has("p1"))
  state = toggleCollapsed(state, "p1")
  assert.ok(!state.collapsed.has("p1"))
  assert.equal(toggleCollapsed(state, ""), state)
})

test("deleted sessions are reconciled out of the strip", () => {
  let state = withTabs(["a", "b", "c"])
  state = activateTab(state, "c")
  const next = reconcileTabs(state, ["a", "b"])
  assert.deepEqual(next.tabs.map((t) => t.id), ["a", "b"])
  assert.ok(next.activeID !== "c", "a deleted session must not stay active")
  assert.ok(["a", "b"].includes(next.activeID))
  // No change means the same object, so consumers can skip re-rendering.
  assert.equal(reconcileTabs(next, ["a", "b"]), next)
})

test("state round-trips through serialization", () => {
  let state = withTabs(["a", "b"])
  state = togglePinTab(state, "a")
  state = toggleCollapsed(state, "p1")
  const raw = JSON.parse(JSON.stringify(serializeWorkbench(state)))
  const restored = createWorkbench(raw)
  assert.deepEqual(restored.tabs.map((t) => t.id), ["a", "b"])
  assert.equal(restored.activeID, state.activeID)
  assert.equal(restored.tabs.find((t) => t.id === "a").pinned, true)
  assert.ok(restored.collapsed.has("p1"))
})

test("restoring tolerates corrupt persisted state", () => {
  const state = createWorkbench({ tabs: [null, { id: "a" }, { id: "a" }], activeID: "ghost", mru: ["ghost", 7] })
  assert.deepEqual(state.tabs.map((t) => t.id), ["a"], "duplicates and junk are dropped")
  assert.equal(state.activeID, "a", "an invalid active id falls back to a real tab")
  assert.deepEqual(state.mru, ["a"])
})
