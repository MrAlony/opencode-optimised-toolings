import { test } from "node:test"
import assert from "node:assert/strict"
import { parseReportBlocks, reportStatus, reportSummary } from "../lib/report.js"

const SEARCH = `SEARCH RESULT: SUCCESS

WHAT HAPPENED: Search completed within all configured bounds. 1 content match(es) were found.

FILE DISCOVERY:
  Method: ripgrep
  Complete: yes

CONTENT SCAN:
  Complete: yes
  Files scanned: 7
  Matches found: 1

EVIDENCE MEANING: Candidate enumeration and returned content evidence are complete within configured bounds.

=== MATCHING FILES: scripts/*.mjs ===
.\\scripts\\install.mjs:23:  const tuiSpec = ...
`

test("reportStatus recognizes the search header", () => {
  assert.equal(reportStatus(SEARCH, "alonix-search"), "SUCCESS")
})

test("reportSummary prefers the human outcome and stays transcript-sized", () => {
  assert.equal(reportSummary(SEARCH, "alonix-search"), "Search completed within all configured bounds. 1 content match(es) were found.")
  assert.equal(reportSummary("", "alonix-web-search"), "Running alonix-web-search")
  assert.ok(reportSummary(`WHAT HAPPENED: ${"x".repeat(180)}`, "alonix-search").length <= 120)
})

test("parseReportBlocks splits sections, key-values and lists", () => {
  const blocks = parseReportBlocks(SEARCH)
  assert.ok(blocks.some((b) => b.type === "section" && b.title === "MATCHING FILES: scripts/*.mjs"))
  assert.ok(blocks.some((b) => b.type === "kv" && b.key === "Method" && b.value === "ripgrep"))
  assert.ok(blocks.some((b) => b.type === "kv" && b.key === "Files scanned" && b.value === "7"))
  const sectioned = parseReportBlocks(`=== GEN ===\n  Method: manual\n  State: running`)
  assert.ok(sectioned.some((b) => b.type === "kv" && b.indented && b.key === "Method" && b.value === "manual"))
})

test("reportStatus maps explore and web headers", () => {
  assert.equal(reportStatus(`EXPLORE RESULT: SUCCESS\nWHAT HAPPENED: baseline complete`, "alonix-explore"), "SUCCESS")
  assert.equal(reportStatus(`WEB SEARCH RESULT: SUCCESS\nWHAT HAPPENED: ok`, "alonix-web-search"), "SUCCESS")
  assert.equal(reportStatus(`STEALTH STATUS: READY\nTor bootstrapped: no`, "alonix-stealth-status"), "SUCCESS")
  assert.equal(reportStatus(`STEALTH FETCH RESULT: SUCCESS\nOutcome: SUCCESS`, "alonix-stealth-fetch"), "SUCCESS")
})

test("reportStatus detects failure and CBM outcomes", () => {
  assert.equal(reportStatus(`SEARCH RESULT: FAILED\nWHAT HAPPENED: boom`, "alonix-search"), "FAILED")
  assert.equal(reportStatus(`=== INDEX READINESS ===\nOutcome: EXISTING VERIFIED INDEX USED`, "alonix-index-context"), "SUCCESS")
  assert.equal(reportStatus(`=== INDEX READINESS ===\nOutcome: FAILED`, "alonix-index-project"), "FAILED")
})

test("reportStatus falls back to neutral for unknown text", () => {
  assert.equal(reportStatus("hello world", "anything"), "PARTIAL SUCCESS")
})

test("parseReportBlocks keeps plain text lines", () => {
  const blocks = parseReportBlocks(`SEARCH RESULT: SUCCESS\nplain output line one\nplain output line two`)
  assert.ok(blocks.some((b) => b.type === "text" && b.lines.includes("plain output line one")))
})
