import test from "node:test"
import assert from "node:assert/strict"
import { diagnosticEvidenceLines } from "../lib/evidence.js"

test("diagnostic evidence preserves inline advisories and multiline recovery context", () => {
  const output = [
    "TERMINAL RESULT: PARTIAL SUCCESS",
    "WHAT HAPPENED: one command failed.",
    "[CRITICAL CBM ESCALATION] Stop broad filesystem discovery.",
    "",
    "=== COMMAND 1 ===",
    "ordinary output that should stay in the structured command card",
    "--- AUTOMATIC RECOVERY ---",
    "Outcome: SUCCEEDED",
    "Detected: quoted Windows executable",
    "Correction: added the call operator",
    "",
    "--- TECHNICAL STATUS ---",
    "status: SUCCESS",
    "duration_ms: 42",
    "cwd: C:/repo",
    "command: test",
    "[TIMEOUT ADVISORY] Do not retry unchanged.",
  ].join("\n")
  const lines = diagnosticEvidenceLines(output)
  assert.ok(lines.includes("[CRITICAL CBM ESCALATION] Stop broad filesystem discovery."))
  assert.ok(lines.includes("--- AUTOMATIC RECOVERY ---"))
  assert.ok(lines.includes("Outcome: SUCCEEDED"))
  assert.ok(lines.includes("Correction: added the call operator"))
  assert.ok(lines.includes("--- TECHNICAL STATUS ---"))
  assert.ok(lines.includes("status: SUCCESS"))
  assert.ok(lines.includes("[TIMEOUT ADVISORY] Do not retry unchanged."))
  assert.ok(!lines.includes("ordinary output that should stay in the structured command card"))
})

test("diagnostic evidence bounds each structured section", () => {
  const body = Array.from({ length: 20 }, (_, index) => `detail ${index + 1}`)
  const lines = diagnosticEvidenceLines(["READ RECOVERY (1):", ...body, "OUTPUT BUDGET:", "Shared total: 100"].join("\n"), { contextLimit: 3 })
  assert.deepEqual(lines.slice(0, 4), ["READ RECOVERY (1):", "detail 1", "detail 2", "detail 3"])
  assert.ok(!lines.includes("detail 4"))
  assert.ok(lines.includes("OUTPUT BUDGET:"))
  assert.ok(lines.includes("Shared total: 100"))
})
