import { test } from "node:test"
import assert from "node:assert/strict"
import { declaredCounts, inputPlanAvailable, pendingPlanSummary, reconcileBatch, visibleOutcome } from "../lib/batch.js"

test("pending input hydration is distinct from a real zero-item plan", () => {
  assert.equal(inputPlanAvailable("alonix-shell", {}), false)
  assert.equal(inputPlanAvailable("alonix-shell", { commands: [] }), false)
  assert.equal(inputPlanAvailable("alonix-shell", { commands: [{ command: "npm test" }] }), true)
  assert.equal(inputPlanAvailable("alonix-read", { paths: [], requests: [] }), false)
  assert.equal(inputPlanAvailable("alonix-read", { requests: [{ path: "a.js", ranges: [] }] }), true)
  assert.equal(inputPlanAvailable("alonix-search", {}), false)
  assert.equal(inputPlanAvailable("alonix-search", { query: "x", base_dir: ".", file_pattern: "**/*" }), true)
  assert.equal(inputPlanAvailable("alonix-explore", { base_dir: "." }), true)
  assert.equal(inputPlanAvailable("alonix-index-project", { project: "repo" }), false)
  assert.equal(inputPlanAvailable("alonix-index-project", { project: "repo", action: "list" }), true)
  assert.equal(inputPlanAvailable("alonix-index-context", { project: "repo" }), true)
  assert.equal(pendingPlanSummary(false, 0, "command"), "command input pending")
  assert.equal(pendingPlanSummary(true, 2, "query", "queries"), "2 queries")
})

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
