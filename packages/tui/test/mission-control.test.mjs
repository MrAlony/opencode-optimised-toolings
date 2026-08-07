import { test } from "node:test"
import assert from "node:assert/strict"
import { agentWindow, MISSION_STALL_MS, missionControlModel } from "../lib/mission-control.js"

const now = 1_000_000
const agents = [
  { id: "attention", projectID: "p1", running: true, busy: true, attention: 1, failedCount: 0, updated: now, files: [{ file: "src/shared.ts" }] },
  { id: "working", projectID: "p1", running: true, busy: true, attention: 0, failedCount: 0, updated: now - 100, files: [{ file: "src/shared.ts" }] },
  { id: "remote", projectID: "p2", running: true, busy: false, attention: 0, failedCount: 0, updated: now - 100, files: [] },
  { id: "stalled", projectID: "p2", running: true, busy: false, attention: 0, failedCount: 0, updated: now - MISSION_STALL_MS - 1, files: [] },
  { id: "idle", projectID: "p2", running: false, busy: false, attention: 0, failedCount: 0, updated: now, files: [] },
]

test("mission control orders attention, collisions and stalls before ordinary work", () => {
  const model = missionControlModel({ agents, now })
  assert.equal(model.agents[0].id, "attention")
  assert.equal(model.stats.attention, 1)
  assert.equal(model.stats.stalled, 1)
  assert.equal(model.agents.find((item) => item.id === "remote")?.stalled, false, "remote live work must not stall merely because this process lacks its transcript")
  assert.equal(model.stats.collisions, 1)
  assert.equal(model.agents.some((item) => item.id === "idle"), false)
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

test("malformed input degrades safely", () => {
  const model = missionControlModel({ agents: [null, 4], filter: "unknown", now })
  assert.equal(model.filter, "all")
  assert.deepEqual(model.agents, [])
  assert.deepEqual(agentWindow(null, 0, 0).rows, [])
})
