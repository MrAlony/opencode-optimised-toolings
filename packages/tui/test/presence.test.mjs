import test from "node:test"
import assert from "node:assert/strict"
import { durableStatus, mergeStatus } from "../lib/presence.js"

function message(role, completed, created = 1) {
  return { info: { role, time: { created, ...(completed === undefined ? {} : { completed }) } } }
}

test("unfinished recent durable transcripts expose work owned by another process", () => {
  assert.deepEqual(durableStatus([message("user", undefined, 100)], { now: 200 }), { type: "busy", source: "transcript", observedAt: 100 })
  assert.deepEqual(durableStatus([message("assistant", undefined, 100)], { now: 200 }), { type: "busy", source: "transcript", observedAt: 100 })
  assert.deepEqual(durableStatus([message("assistant", 150, 100)], { now: 200 }), { type: "idle", source: "transcript", observedAt: 150 })
})

test("abandoned historical transcripts never resurrect as live work", () => {
  assert.deepEqual(durableStatus([message("user", undefined, 100)], { now: 1_000, maxAgeMs: 100 }), {
    type: "idle",
    source: "transcript-expired",
    observedAt: 100,
  })
  assert.deepEqual(durableStatus([message("assistant", undefined, 100)], { now: 1_000, maxAgeMs: 100 }), {
    type: "idle",
    source: "transcript-expired",
    observedAt: 100,
  })
  assert.equal(durableStatus([message("user", undefined, 100)], { now: 1_000, maxAgeMs: 100, sessionUpdatedAt: 950 }).type, "busy")
})

test("the newest persisted message decides durable presence", () => {
  const status = durableStatus([message("assistant", 10, 1), message("user", undefined, 2)], { now: 3 })
  assert.equal(status.type, "busy")
})

test("completed transcript repairs stale SDK busy while a newer producer event starts new work", () => {
  const completed = { type: "idle", source: "transcript", observedAt: 200 }
  assert.equal(mergeStatus({ type: "busy", source: "sdk", observedAt: 300 }, completed).type, "idle", "polling cannot keep completed work alive")
  assert.equal(mergeStatus({ type: "busy", source: "shared-presence", observedAt: 150 }, completed).type, "idle", "an older lease cannot outrank completion")
  assert.equal(mergeStatus({ type: "busy", source: "live-event", observedAt: 250 }, completed).type, "busy", "a newer event proves a new turn")
  assert.equal(mergeStatus({ type: "retry", source: "host-state", observedAt: 250 }, completed).type, "retry")
})

test("durable unfinished state repairs false idle", () => {
  assert.deepEqual(mergeStatus({ type: "idle" }, { type: "busy", source: "transcript", observedAt: 10 }), {
    type: "busy",
    source: "transcript",
    observedAt: 10,
  })
  assert.equal(mergeStatus(undefined, undefined).type, "idle")
})

test("malformed transcript input degrades safely", () => {
  assert.equal(durableStatus(null), null)
  assert.equal(durableStatus([null, {}]), null)
})
