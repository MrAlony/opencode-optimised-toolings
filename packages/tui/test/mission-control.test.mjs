import { test } from "node:test"
import assert from "node:assert/strict"
import { agentWindow, missionControlLayout, missionControlModel, missionScrollIndex, MISSION_STALL_MS } from "../lib/mission-control.js"

const now = 1_000_000
const agents = [
  { id: "attention", projectID: "p1", running: true, busy: true, attention: 1, failedCount: 0, latestToolFailed: false, updated: now, files: [{ file: "src/shared.ts" }] },
  { id: "working", projectID: "p1", running: true, busy: true, attention: 0, failedCount: 0, latestToolFailed: false, updated: now - 100, files: [{ file: "src/shared.ts" }] },
  { id: "remote", projectID: "p2", running: true, busy: false, attention: 0, failedCount: 0, latestToolFailed: false, updated: now - 100, files: [] },
  { id: "stalled", projectID: "p2", running: true, busy: false, attention: 0, failedCount: 0, latestToolFailed: false, updated: now - MISSION_STALL_MS - 1, files: [] },
  { id: "idle", projectID: "p2", running: false, busy: false, attention: 0, failedCount: 0, latestToolFailed: false, updated: now, files: [] },
]

test("mission control orders attention, collisions and stalls before ordinary work", () => {
  const model = missionControlModel({ agents, now })
  assert.equal(model.agents[0].id, "attention")
  assert.equal(model.stats.attention, 1)
  assert.equal(model.stats.stalled, 1)
  assert.equal(model.stats.errors, 0)
  assert.equal(model.agents.find((item) => item.id === "remote")?.stalled, false, "remote live work must not stall merely because this process lacks its transcript")
  assert.equal(model.stats.collisions, 1)
  assert.equal(model.agents.some((item) => item.id === "idle"), false)
})

test("current errors, user blockers, and stalls remain separate", () => {
  const model = missionControlModel({
    now,
    agents: [
      { id: "recovered", running: true, attention: 0, failedCount: 3, latestToolFailed: false, updated: now - 10, files: [] },
      { id: "failed", running: true, attention: 0, failedCount: 1, latestToolFailed: true, updated: now - 20, files: [] },
      { id: "blocked", running: true, attention: 1, failedCount: 0, latestToolFailed: false, updated: now - 30, files: [] },
      { id: "inactive", running: true, attention: 0, failedCount: 2, latestToolFailed: false, updated: now - MISSION_STALL_MS - 1, files: [] },
    ],
  })
  const recovered = model.agents.find((item) => item.id === "recovered")
  assert.equal(recovered.needsAttention, false)
  assert.equal(recovered.hasError, false)
  assert.equal(recovered.stalled, false)
  assert.equal(model.stats.attention, 1)
  assert.equal(model.stats.errors, 1)
  assert.equal(model.stats.stalled, 1)
  assert.equal(model.stats.working, 1)
  assert.deepEqual(missionControlModel({ agents: model.agents, now, filter: "attention" }).agents.map((item) => item.id), ["blocked"])
  assert.deepEqual(missionControlModel({ agents: model.agents, now, filter: "errors" }).agents.map((item) => item.id), ["failed"])
  assert.deepEqual(missionControlModel({ agents: model.agents, now, filter: "stalled" }).agents.map((item) => item.id), ["inactive"])
  assert.deepEqual(missionControlModel({ agents: model.agents, now, filter: "working" }).agents.map((item) => item.id), ["recovered"])
})

test("filters and folder scope remain distinct and deterministic", () => {
  assert.deepEqual(missionControlModel({ agents, now, filter: "attention" }).agents.map((item) => item.id), ["attention"])
  assert.deepEqual(missionControlModel({ agents, now, filter: "stalled" }).agents.map((item) => item.id), ["stalled"])
  assert.deepEqual(missionControlModel({ agents, now, filter: "collisions" }).agents.map((item) => item.id), ["attention", "working"])
  assert.deepEqual(missionControlModel({ agents, now, project: "p2" }).agents.map((item) => item.id), ["stalled", "remote"])
})

test("agent window mounts only the bounded visible range", () => {
  const rows = Array.from({ length: 100 }, (_, id) => ({ id }))
  const window = agentWindow(rows, 50, 9)
  assert.equal(window.rows.length, 9)
  assert.ok(window.rows.some((item) => item.id === 50))
  assert.equal(window.before + window.rows.length + window.after, 100)
})

test("card capacity counts every column and never overflows the padded viewport", () => {
  for (const density of ["cards", "compact", "table"]) {
    for (const width of [20, 40, 67, 68, 107, 108, 160]) {
      for (const height of [8, 18, 29, 60]) {
        const layout = missionControlLayout({ width, height }, density)
        assert.equal(layout.capacity, layout.visibleRows * layout.columns)
        const used = layout.columns * layout.cardWidth + layout.gap * (layout.columns - 1)
        assert.ok(used <= layout.contentWidth, `${density}@${width}x${height}: ${used} overflows ${layout.contentWidth}`)
      }
    }
  }
  const threeColumns = missionControlLayout({ width: 108, height: 29 }, "cards")
  assert.equal(threeColumns.columns, 3)
  assert.equal(threeColumns.visibleRows, 2)
  assert.equal(threeColumns.capacity, 6, "two three-column rows must mount six agents, not two")

  const conservativeHostHeight = missionControlLayout({ width: 150, height: 18 }, "cards")
  assert.equal(conservativeHostHeight.columns, 3)
  assert.equal(conservativeHostHeight.visibleRows, 2)
  assert.equal(conservativeHostHeight.capacity, 6, "a conservative route height must not hide the fourth active agent")
  const fourAgents = agentWindow(Array.from({ length: 4 }, (_, id) => ({ id })), 0, conservativeHostHeight.capacity)
  assert.equal(fourAgents.rows.length, 4)
  assert.equal(fourAgents.after, 0)
})

test("arbitrary agent counts remain reachable one visual row at a time", () => {
  const total = 101
  assert.equal(missionScrollIndex(0, total, "down", 3), 3)
  assert.equal(missionScrollIndex(99, total, "down", 3), 100)
  assert.equal(missionScrollIndex(3, total, "up", 3), 0)
  assert.equal(missionScrollIndex(0, total, "up", 3), 0)
  assert.equal(missionScrollIndex(8, total, "down", 1), 9)
})

test("malformed input degrades safely", () => {
  const model = missionControlModel({ agents: [null, 4], filter: "unknown", now })
  assert.equal(model.filter, "all")
  assert.deepEqual(model.agents, [])
  assert.deepEqual(agentWindow(null, 0, 0).rows, [])
})
