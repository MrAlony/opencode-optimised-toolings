import test from "node:test"
import assert from "node:assert/strict"
import {
  MAX_PANES,
  addPane,
  autoFill,
  createPanes,
  cyclePaneFocus,
  focusPaneAt,
  movePane,
  paneGrid,
  paneSlots,
  reconcilePanes,
  removePane,
  serializePanes,
  soloPane,
} from "../lib/panes.js"

const WIDE = { width: 200, height: 50 }

test("a single pane fills the viewport with no gap", () => {
  const grid = paneGrid(1, WIDE)
  assert.equal(grid.columns, 1)
  assert.equal(grid.rows, 1)
  assert.equal(grid.gap, 0)
  assert.equal(grid.paneWidth, 200)
  assert.equal(grid.mode, "single")
})

test("panes tile side by side when the viewport allows", () => {
  const two = paneGrid(2, WIDE)
  assert.equal(two.columns, 2)
  assert.equal(two.rows, 1)
  assert.equal(two.mode, "columns")

  // A wide terminal fits all four as readable columns in a single row.
  const four = paneGrid(4, { width: 240, height: 60 })
  assert.equal(four.visible, 4)
  assert.equal(four.columns, 4)
  assert.equal(four.mode, "columns")

  // A narrower one wraps into a 2x2 grid instead of shrinking columns.
  const wrapped = paneGrid(4, { width: 100, height: 50 })
  assert.equal(wrapped.visible, 4)
  assert.equal(wrapped.mode, "grid")
  assert.ok(wrapped.columns * wrapped.rows >= 4)
})

test("panes never render below a readable size", () => {
  // 100 cells cannot hold four 44-cell columns; the grid must degrade to 2x2.
  const grid = paneGrid(4, { width: 100, height: 50 })
  assert.ok(grid.paneWidth >= 44, `pane width ${grid.paneWidth} is unreadable`)
  assert.equal(grid.columns, 2)

  // A narrow terminal allows only one column, and a short one limits rows, so
  // some requested panes cannot be shown.
  const narrow = paneGrid(4, { width: 50, height: 40 })
  assert.equal(narrow.columns, 1)
  assert.ok(narrow.paneHeight >= 10, `pane height ${narrow.paneHeight} is unreadable`)
  assert.equal(narrow.constrained, true)
  assert.ok(narrow.hidden > 0)
})

test("a short viewport reduces rows rather than crushing them", () => {
  const grid = paneGrid(4, { width: 240, height: 14 })
  assert.equal(grid.rows, 1, "there is only room for one row")
  assert.ok(grid.paneHeight >= 10 || grid.rows === 1)
})

test("grid geometry always fits inside the viewport", () => {
  for (const count of [1, 2, 3, 4]) {
    for (const width of [40, 80, 120, 200, 400]) {
      for (const height of [12, 24, 60]) {
        const grid = paneGrid(count, { width, height })
        const usedWidth = grid.columns * grid.paneWidth + grid.gap * (grid.columns - 1)
        const usedHeight = grid.rows * grid.paneHeight + grid.gap * (grid.rows - 1)
        assert.ok(usedWidth <= width, `${count}@${width}x${height}: width ${usedWidth} overflows`)
        assert.ok(usedHeight <= height, `${count}@${width}x${height}: height ${usedHeight} overflows`)
        assert.ok(grid.visible >= 1)
      }
    }
  }
})

test("slots are laid out in reading order and never overlap", () => {
  // 240 cells fit four readable columns, so this stays a single row.
  const wide = paneGrid(4, { width: 240, height: 60 })
  const wideSlots = paneSlots(wide)
  assert.equal(wideSlots.length, wide.visible)
  assert.deepEqual(wideSlots.map((slot) => slot.index), [0, 1, 2, 3])
  assert.equal(wide.rows, 1)
  assert.ok(wideSlots.every((slot) => slot.y === 0))
  // Each slot starts after the previous one plus the gap.
  assert.equal(wideSlots[1].x, wide.paneWidth + wide.gap)

  // A narrower viewport wraps into rows.
  const grid = paneGrid(4, { width: 100, height: 50 })
  const slots = paneSlots(grid)
  assert.equal(grid.rows, 2)
  assert.equal(slots[0].y, 0)
  assert.ok(slots[2].y > 0, "the third pane wraps to the next row")
  assert.equal(slots[2].x, 0, "a wrapped pane starts a new row")
})

test("adding a session focuses it and refuses duplicates", () => {
  let panes = addPane(createPanes(), "a")
  assert.deepEqual(panes.ids, ["a"])
  assert.equal(panes.focus, "a")

  panes = addPane(panes, "b")
  assert.deepEqual(panes.ids, ["a", "b"])
  assert.equal(panes.focus, "b")

  panes = addPane(panes, "a")
  assert.deepEqual(panes.ids, ["a", "b"], "an open session must not be duplicated")
  assert.equal(panes.focus, "a")

  for (const bad of [null, undefined, "", 5]) assert.deepEqual(addPane(panes, bad).ids, panes.ids)
})

test("at capacity a new session replaces an unfocused pane", () => {
  let panes = createPanes()
  for (const id of ["a", "b", "c", "d"]) panes = addPane(panes, id)
  assert.equal(panes.ids.length, MAX_PANES)
  assert.equal(panes.focus, "d")

  panes = addPane(panes, "e")
  assert.equal(panes.ids.length, MAX_PANES, "the grid never exceeds its cap")
  assert.ok(panes.ids.includes("e"))
  assert.ok(panes.ids.includes("d"), "the focused pane must survive")
  assert.equal(panes.focus, "e")
})

test("removing a pane moves focus to a survivor", () => {
  let panes = createPanes()
  for (const id of ["a", "b"]) panes = addPane(panes, id)
  panes = removePane(panes, "b")
  assert.deepEqual(panes.ids, ["a"])
  assert.equal(panes.focus, "a")

  panes = removePane(panes, "a")
  assert.deepEqual(panes.ids, [])
  assert.equal(panes.focus, null)
  assert.equal(removePane(panes, "ghost"), panes)
})

test("focus moves by position and cycles both ways", () => {
  let panes = createPanes()
  for (const id of ["a", "b", "c"]) panes = addPane(panes, id)
  assert.equal(focusPaneAt(panes, 0).focus, "a")
  assert.equal(focusPaneAt(panes, 9), panes, "out of range is ignored")

  panes = focusPaneAt(panes, 0)
  assert.equal(cyclePaneFocus(panes, 1).focus, "b")
  assert.equal(cyclePaneFocus(panes, -1).focus, "c", "cycling back wraps")
  assert.equal(cyclePaneFocus(createPanes(), 1).focus, null)
})

test("panes can be rearranged and clamp at the ends", () => {
  let panes = createPanes()
  for (const id of ["a", "b", "c"]) panes = addPane(panes, id)
  assert.deepEqual(movePane(panes, "a", 1).ids, ["b", "a", "c"])
  assert.equal(movePane(panes, "a", -1), panes, "clamped at the start")
  assert.equal(movePane(panes, "c", 1), panes, "clamped at the end")
  assert.equal(movePane(panes, "ghost", 1), panes)
})

test("solo collapses to one pane", () => {
  let panes = createPanes()
  for (const id of ["a", "b", "c"]) panes = addPane(panes, id)
  const solo = soloPane(panes, "b")
  assert.deepEqual(solo.ids, ["b"])
  assert.equal(solo.focus, "b")
  // With no argument it solos the focused pane.
  assert.deepEqual(soloPane(panes).ids, ["c"])
})

test("deleted sessions are reconciled out of the grid", () => {
  let panes = createPanes()
  for (const id of ["a", "b", "c"]) panes = addPane(panes, id)
  const next = reconcilePanes(panes, ["a", "b"])
  assert.deepEqual(next.ids, ["a", "b"])
  assert.ok(next.focus !== "c")
  assert.equal(reconcilePanes(next, ["a", "b"]), next, "no change returns the same value")
})

test("auto-fill prefers running sessions and keeps existing panes", () => {
  const sessions = [
    { id: "idle-new", running: false, updated: 500 },
    { id: "busy-old", running: true, updated: 100 },
    { id: "idle-old", running: false, updated: 50 },
  ]
  const filled = autoFill(createPanes(), sessions, 2)
  assert.equal(filled.ids[0], "busy-old", "a running session outranks a newer idle one")
  assert.equal(filled.ids[1], "idle-new")

  // A pane the user already opened is retained.
  const existing = autoFill(createPanes({ ids: ["idle-old"], focus: "idle-old" }), sessions, 2)
  assert.ok(existing.ids.includes("idle-old"))
  assert.equal(existing.focus, "idle-old", "auto-fill must not steal focus")
})

test("state round-trips and tolerates corrupt input", () => {
  let panes = createPanes()
  for (const id of ["a", "b"]) panes = addPane(panes, id)
  const restored = createPanes(JSON.parse(JSON.stringify(serializePanes(panes))))
  assert.deepEqual(restored.ids, ["a", "b"])
  assert.equal(restored.focus, panes.focus)

  const corrupt = createPanes({ ids: [null, "a", "a", 7], focus: "ghost" })
  assert.deepEqual(corrupt.ids, ["a"])
  assert.equal(corrupt.focus, "a")
})

test("malformed geometry input never throws", () => {
  for (const input of [undefined, {}, { width: NaN, height: null }, { width: -5, height: -5 }]) {
    assert.doesNotThrow(() => paneSlots(paneGrid(3, input)))
  }
})
