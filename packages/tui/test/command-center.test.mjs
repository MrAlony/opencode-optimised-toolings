import { test } from "node:test"
import assert from "node:assert/strict"
import { commandCenterModel, decisionRecord, normalizeDeliveryState } from "../lib/command-center.js"

const projects = [
  { id: "p1", stateKey: "directory:/one", name: "one", worktree: "/one", updated: 100 },
  { id: "p2", stateKey: "directory:/two", name: "two", worktree: "/two", updated: 90 },
]

const sessions = [
  { id: "review", title: "Review me", projectID: "p1", projectName: "one", running: false, changedFiles: 4, activeTodos: 0, completedTodos: 2, attention: 0, updated: 100, files: [{ file: "src/shared.ts" }], todos: [{ content: "Ship", status: "completed" }] },
  { id: "blocked", title: "Blocked", projectID: "p1", projectName: "one", running: false, changedFiles: 0, activeTodos: 1, completedTodos: 0, attention: 1, updated: 90, files: [], todos: [{ content: "Choose API", status: "in_progress" }] },
  { id: "overlap", title: "Overlap", projectID: "p2", projectName: "two", running: false, changedFiles: 1, activeTodos: 0, completedTodos: 1, attention: 0, updated: 80, files: [{ file: "src/shared.ts" }], todos: [] },
  { id: "running", title: "Live", projectID: "p2", projectName: "two", running: true, changedFiles: 3, activeTodos: 1, completedTodos: 0, attention: 0, updated: 110, files: [{ file: "src/live.ts" }], todos: [{ content: "Implement", status: "pending" }] },
]

test("delivery hub separates tasks, reviews, unresolved work and collisions", () => {
  const model = commandCenterModel({ projects, sessions })
  assert.deepEqual(model.review.map((item) => item.id), ["review", "overlap"])
  assert.deepEqual(model.unresolved.map((item) => item.id), ["blocked"])
  assert.equal(model.tasks.length, 3)
  assert.equal(model.openTasks.length, 2)
  assert.equal(model.collisions.length, 1)
  assert.equal(model.collisions[0].file, "src/shared.ts")
  assert.equal(model.outcomes.length, 0, "reviewable work must not also appear as a completed outcome")
  assert.equal(model.stats.openTasks, 2)
})

test("reviewed work leaves the queue and selected-folder scope is exact", () => {
  const reviewed = commandCenterModel({ projects, sessions, reviewed: ["review"] })
  assert.deepEqual(reviewed.review.map((item) => item.id), ["overlap"])
  const selected = commandCenterModel({ projects, sessions, scope: "selected", selectedProjectID: "p1" })
  assert.deepEqual(selected.projects.map((item) => item.id), ["p1"])
  assert.deepEqual(selected.sessions.map((item) => item.id), ["review", "blocked"])
  assert.equal(selected.collisions.length, 0)
})

test("project lanes report actionable delivery health", () => {
  const model = commandCenterModel({ projects, sessions })
  assert.equal(model.lanes[0].health, "attention")
  assert.ok(model.lanes.some((lane) => lane.openTasks > 0))
  assert.ok(model.lanes.some((lane) => lane.reviews > 0))
})

test("decisions are explicit, bounded and project-scoped", () => {
  const decision = decisionRecord({ text: " Use SQLite for durable state ", projectID: "p1", projectName: "one", createdAt: 10 })
  assert.equal(decision.text, "Use SQLite for durable state")
  const state = normalizeDeliveryState({ reviewed: ["a", "a"], decisions: [decision, { text: "" }] })
  assert.deepEqual(state.reviewed, ["a"])
  assert.equal(state.decisions.length, 1)
  const model = commandCenterModel({ projects, sessions, decisions: state.decisions, scope: "selected", selectedProjectID: "p1" })
  assert.equal(model.decisions.length, 1)
})

test("malformed and empty input never throws", () => {
  const model = commandCenterModel({ sessions: [null, 4], projects: "bad", decisions: [undefined] })
  assert.equal(model.stats.chats, 0)
  assert.deepEqual(model.tasks, [])
  assert.equal(decisionRecord({ text: " " }), null)
})
