import { test } from "node:test"
import assert from "node:assert/strict"
import { declaredCounts, reconcileBatch, visibleOutcome } from "../lib/batch.js"

test("request plan cardinality survives truncated per-item output", () => {
  const plan = [
    { status: "PENDING", label: "https://one.test", meta: "markdown" },
    { status: "PENDING", label: "https://two.test", meta: "markdown" },
    { status: "PENDING", label: "https://three.test", meta: "markdown" },
  ]
  const observed = [{ number: 1, title: "https://one.test", status: "SUCCESS", outcome: "HTTP 200" }]
  const batch = reconcileBatch(plan, observed)
  assert.equal(batch.plannedCount, 3)
  assert.equal(batch.observedCount, 1)
  assert.equal(batch.records.length, 3)
  assert.deepEqual(batch.records.map((item) => item.status), ["SUCCESS", "PARTIAL SUCCESS", "PARTIAL SUCCESS"])
  assert.deepEqual(batch.records.map((item) => item.detailAvailable), [true, false, false])
  assert.equal(visibleOutcome(batch.records).omitted, 2)
})

test("reconciliation matches absolute result paths to relative requested paths", () => {
  const batch = reconcileBatch(
    [{ status: "PENDING", label: "packages/tui/a.jsx", meta: "requested" }],
    [{ status: "SUCCESS", label: "C:\\repo\\packages\\tui\\a.jsx", meta: "complete" }],
  )
  assert.equal(batch.records[0].detailAvailable, true)
  assert.equal(batch.records[0].status, "SUCCESS")
})

test("declared summary counts stay distinct from visible detail blocks", () => {
  assert.deepEqual(declaredCounts("3 of 3 URL request(s) returned successful HTTP responses."), { succeeded: 3, total: 3 })
  assert.deepEqual(declaredCounts("2 command(s) succeeded and 1 failed, timed out, or were aborted."), { succeeded: 2, total: 3 })
})

test("observed-only reports remain usable when no request plan exists", () => {
  const batch = reconcileBatch([], [{ number: 4, label: "status", status: "SUCCESS" }])
  assert.equal(batch.plannedCount, 1)
  assert.equal(batch.records[0].number, 4)
})
