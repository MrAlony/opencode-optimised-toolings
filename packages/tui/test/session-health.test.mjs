import test from "node:test"
import assert from "node:assert/strict"
import { healthIsVisible, sessionHealth, SESSION_STALL_MS } from "../lib/session-health.js"

const now = 1_000_000
const activity = (overrides = {}) => ({ busy: false, headline: "Idle", runningCount: 0, latestTool: null, latestToolFailed: false, hydrated: true, progressAt: now, inFlight: false, ...overrides })

test("session health has one evidence-qualified precedence across all surfaces", () => {
  assert.equal(sessionHealth({ activity: activity({ latestToolFailed: true }), attention: 1, running: true, now }).state, "needs-input")
  assert.equal(sessionHealth({ activity: activity({ latestToolFailed: true }), running: true, now }).state, "error")
  assert.equal(sessionHealth({ activity: activity(), running: false, terminalState: "error", completedAt: now, now }).state, "error")
  assert.equal(sessionHealth({ activity: activity(), running: false, terminalState: "needs-input", completedAt: now, now }).state, "needs-input")
  assert.equal(sessionHealth({ activity: activity({ runningCount: 1, inFlight: true, progressAt: now - SESSION_STALL_MS - 1 }), running: true, now }).state, "stalled")
  assert.equal(sessionHealth({ activity: activity({ busy: true, headline: "Thinking" }), running: true, now }).state, "thinking")
  assert.equal(sessionHealth({ activity: activity({ busy: true, headline: "Responding" }), running: true, now }).state, "responding")
  assert.equal(sessionHealth({ activity: activity({ busy: true, runningCount: 1, headline: "Editing app.ts" }), running: true, now }).state, "working")
  assert.equal(sessionHealth({ activity: activity({ headline: "All tests pass" }), running: false, completed: true, completedAt: now, now }).state, "completed")
})

test("missing hydration or old session metadata can never manufacture a stall", () => {
  const unknown = activity({ hydrated: false, progressAt: 0, inFlight: false, headline: "Idle" })
  assert.equal(sessionHealth({ activity: unknown, running: true, updated: 1, now }).state, "working")
  assert.equal(sessionHealth({ activity: activity({ inFlight: false, progressAt: 1 }), running: true, updated: 1, now }).state, "working")
  assert.equal(sessionHealth({ activity: activity({ runningCount: 1, inFlight: true, progressAt: now - 100 }), running: true, updated: 1, now }).state, "working")
  assert.equal(sessionHealth({ activity: activity({ runningCount: 0, inFlight: true, progressAt: 1 }), running: true, now }).state, "working", "long model composition without a running tool is not enough evidence to claim a stall")
})

test("assistant transcript history alone is never a completion lifecycle event", () => {
  assert.equal(sessionHealth({ activity: activity({ assistantCompleted: true }), running: false, now }).state, "idle")
  assert.equal(sessionHealth({ activity: activity(), running: false, completed: true, completedAt: 0, now }).state, "idle")
})

test("current state defines tone, motion, and completed visibility", () => {
  const completed = sessionHealth({ activity: activity(), running: false, terminalState: "completed", completed: true, completedAt: now, now })
  assert.deepEqual({ tone: completed.tone, pulse: completed.pulse, label: completed.label }, { tone: "success", pulse: false, label: "completed" })
  assert.equal(healthIsVisible(completed), true)
  const old = sessionHealth({ activity: activity(), running: false, terminalState: "completed", completed: true, completedAt: 1, now })
  assert.equal(healthIsVisible(old), true, "unseen completion remains visible regardless of age")
  assert.equal(sessionHealth({ activity: activity(), running: false, terminalState: "seen", completedAt: now, now }).state, "idle")
})

test("malformed health input degrades to idle", () => {
  assert.equal(sessionHealth().state, "idle")
  assert.equal(sessionHealth({ activity: null }).state, "idle")
})
