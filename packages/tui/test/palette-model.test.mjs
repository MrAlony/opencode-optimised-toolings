import test from "node:test"
import assert from "node:assert/strict"
import { paletteDisplayRows, paletteWindow, preservePaletteSelection } from "../lib/palette-model.js"

const actions = [
  { id: "a", kind: "project" },
  { id: "b", kind: "project" },
  { id: "c", kind: "session" },
]

test("palette selection remains anchored to action identity across refresh reordering", () => {
  assert.deepEqual(preservePaletteSelection(actions, "b", 0), { id: "b", index: 1 })
  assert.deepEqual(preservePaletteSelection([actions[2], actions[1], actions[0]], "b", 0), { id: "b", index: 1 })
  assert.deepEqual(preservePaletteSelection([actions[2], actions[0]], "b", 1), { id: "a", index: 1 })
})

test("group headers consume the same exact painted-row budget as actions", () => {
  const rows = paletteDisplayRows([
    { kind: "project", label: "Folders", rows: actions.slice(0, 2) },
    { kind: "session", label: "Chats", rows: actions.slice(2) },
  ])
  assert.equal(rows.length, 5)
  const first = paletteWindow(rows, "b", 0, 3)
  assert.equal(first.rows.length, 3)
  assert.deepEqual(first.rows.map((row) => row.kind), ["group", "row", "row"])
  const second = paletteWindow(rows, "c", first.start, 3)
  assert.equal(second.rows.length, 3)
  assert.equal(second.rows.at(-1).actionID, "c")
})
