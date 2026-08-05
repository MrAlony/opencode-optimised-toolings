import { test } from "node:test"
import assert from "node:assert/strict"
import { opColor, parseOperations } from "../lib/background.js"

const REPORT = `=== OPERATION 1: start ===
PROCESS READY
  ID: bgp_msf8mmxj1
  PID: 62132
  State: running
=== OPERATION 1: status ===
PROCESS STATUS
  ID: bgp_msf8mmxj1
  PID: 62132
  State: running
=== OPERATION 2: stop_all ===
Stop completed for 1 of 1 running process(es)
`

const skin = { error: "#e", success: "#s", accent: "#a", text: "#t" }

test("parseOperations splits operation blocks", () => {
  const ops = parseOperations(REPORT)
  assert.equal(ops.length, 3)
  assert.equal(ops[0].label, "start")
  assert.equal(ops[2].label, "stop_all")
})

test("parseOperationBlock extracts headline and key-values", () => {
  const [first] = parseOperations(REPORT)
  assert.equal(first.headline, "PROCESS READY")
  assert.deepEqual(first.kv, [["ID", "bgp_msf8mmxj1"], ["PID", "62132"], ["State", "running"]])
  assert.equal(first.body.length, 0)
})

test("opColor classifies headlines", () => {
  assert.equal(opColor("PROCESS READY", skin), "#s")
  assert.equal(opColor("PROCESS START FAILED", skin), "#e")
  assert.equal(opColor("Stop completed for 1 of 1", skin), "#s")
  assert.equal(opColor("plain line", skin), "#t")
})
