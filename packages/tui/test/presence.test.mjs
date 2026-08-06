import test from "node:test"
import assert from "node:assert/strict"
import { durableStatus, mergeStatus } from "../lib/presence.js"

function message(role, completed, created = 1) {
  return { info: { role, time: { created, ...(completed === undefined ? {} : { completed }) } } }
}

test("unfinished recent durable transcripts expose work owned by another process", () => {
  assert.deepEqual(durableStatus([message("user", undefined, 100)], { now: 200 }), { type: "busy", source: "transcript" })
  assert.deepEqual(durableStatus([message("assistant", undefined, 100)], { now: 200 }), { type: "busy", source: "transcript" })
  assert.deepEqual(durableStatus([message("assistant", 150, 100)], { now: 200 }), { type: "idle", source: "transcript" })
})

test("abandoned historical transcripts never resurrect as live work", () => {
  assert.deepEqual(durableStatus([message("user", undefined, 100)], { now: 1_000, maxAgeMs: 100 }), {
    type: "idle",
    source: "transcript-expired",
  })
  assert.deepEqual(durableStatus([message("assistant", undefined, 100)], { now: 1_000, maxAgeMs: 100 }), {
    type: "idle",
    source: "transcript-expired",
  })
  assert.equal(durableStatus([message("user", undefined, 100)], { now: 1_000, maxAgeMs: 100, sessionUpdatedAt: 950 }).type, "busy")
})

test("the newest persisted message decides durable presence", () => {
  const status = durableStatus([message("assistant", 10, 1), message("user", undefined, 2)], { now: 3 })
  assert.equal(status.type, "busy")
})

test("live busy state wins while durable state repairs false idle", () => {
  assert.equal(mergeStatus({ type: "retry" }, { type: "idle" }).type, "retry")
  assert.deepEqual(mergeStatus({ type: "idle" }, { type: "busy", source: "transcript" }), {
    type: "busy",
    source: "transcript",
  })
  assert.equal(mergeStatus(undefined, undefined).type, "idle")
})

test("malformed transcript input degrades safely", () => {
  assert.equal(durableStatus(null), null)
  assert.equal(durableStatus([null, {}]), null)
})
