import { test } from "node:test"
import assert from "node:assert/strict"
import { inputItems, parseCbm, parseDiscovery, parseStealth, parseWebFetch, parseWebSearch } from "../lib/inspect.js"

test("web fetch inspector preserves per-URL mixed outcomes", () => {
  const parsed = parseWebFetch(`WEB FETCH RESULT: PARTIAL SUCCESS\n\nWHAT HAPPENED: 1 of 2 URL request(s) returned successful HTTP responses.\n\nOUTPUT ALLOCATION: shared_total=100 bytes.\n\n=== URL 1: https://ok.test ===\nOutcome: HTTP 200 OK\nFinal URL: https://ok.test/\nCache: hit\nDuration: 12 ms; attempts=1; redirects=0\nContent: type=text/html; parser=readability; format=markdown; source_bytes=10; sha256=abc\nReturned extraction: complete; allocated=10 bytes\nTitle: Good page\n--- EXTRACTED CONTENT ---\nhello\n\n=== URL 2: https://bad.test ===\nOutcome: FAILED\nFinal URL: not reached\nCache: miss\nDuration: 0 ms; attempts=0; redirects=0\nError: blocked destination`)
  assert.equal(parsed.status, "PARTIAL SUCCESS")
  assert.deepEqual(parsed.items.map((item) => item.status), ["SUCCESS", "FAILED"])
  assert.equal(parsed.items[0].titleText, "Good page")
  assert.match(parsed.items[1].error, /blocked/)
})

test("web fetch parser keeps declared batch counts separate from visible truncated blocks", () => {
  const parsed = parseWebFetch(`WEB FETCH RESULT: SUCCESS\nWHAT HAPPENED: 3 of 3 URL request(s) returned successful HTTP responses.\n\n=== URL 1: https://one.test ===\nOutcome: HTTP 200 OK\nFinal URL: https://one.test/`)
  assert.equal(parsed.items.length, 1)
  assert.match(parsed.summary, /3 of 3/)
})

test("web search inspector exposes query and result provenance", () => {
  const parsed = parseWebSearch(`WEB SEARCH RESULT: PARTIAL SUCCESS\nWHAT HAPPENED: 1 of 2 query(s) returned results. Strategy: fallback.\n\n=== QUERY 1: solid open tui ===\nOutcome: RESULTS FOUND (1)\nCache: miss\nBackend attempts:\n  - searxng: ok (1)\n\n1. OpenTUI\n   URL: https://example.test\n   Terminal renderer\n   Source: searxng/meta\n\n=== QUERY 2: absent ===\nOutcome: NO RESULTS\nCache: hit; no external backend request was needed\nBackend attempts:\n  - duckduckgo: 0 results\nNo results found.`)
  assert.deepEqual(parsed.items.map((item) => item.status), ["SUCCESS", "FAILED"])
  assert.equal(parsed.items[0].results[0].source, "searxng/meta")
  assert.match(parsed.items[1].cache, /hit/)
})

test("stealth and CBM inspectors distinguish readiness, partial evidence, and failures", () => {
  const stealth = parseStealth(`STEALTH FETCH RESULT: PARTIAL SUCCESS\nWHAT HAPPENED: 1 of 2 item(s) completed through the managed Tor boundary.\nTor: bootstrapped; SOCKS=19050; control authentication=cookie.\n\n=== ITEM 1: https://ok.test ===\nOutcome: SUCCESS\nHTTP status: 200\nTitle: ok\nReturned evidence: complete within shared output budget\n--- CONTENT ---\nhello\n\n=== ITEM 2: https://bad.test ===\nOutcome: FAILED\nError: timeout\nReturned evidence: complete within shared output budget\n--- CONTENT ---\n(empty)`)
  assert.deepEqual(stealth.items.map((item) => item.status), ["SUCCESS", "FAILED"])
  assert.equal(parseCbm("STOP. action=index requires user_authorized=true").status, "FAILED")
  const cbm = parseCbm("=== INDEX READINESS ===\nOutcome: EXISTING VERIFIED INDEX USED\n\n=== ARCHITECTURE ===\n{}")
  assert.equal(cbm.status, "SUCCESS")
  assert.deepEqual(cbm.sectionBodies.map((section) => section.name), ["INDEX READINESS", "ARCHITECTURE"])
  assert.equal(parseCbm("=== ARCHITECTURE ===\n[CBM SECTION TRUNCATED at 10 characters.]").status, "PARTIAL SUCCESS")
})

test("discovery and pending previews remain informative with zero matches", () => {
  const search = parseDiscovery(`SEARCH RESULT: SUCCESS\n\nWHAT HAPPENED: Search completed. 0 content match(es) were found.\n\nCONTENT SCAN:\n  Complete: yes\n  Files scanned: 7\n  Matches found: 0\n\n=== CONTENT MATCHES: x ===\nNo matches found.`, "alonix-search")
  assert.equal(search.items.length, 2)
  assert.match(search.items[0].label, /0 content matches/)
  assert.deepEqual(inputItems("alonix-web-fetch", { requests: [{ url: "https://one.test" }, { url: "https://two.test" }] }).map((item) => item.status), ["PENDING", "PENDING"])
})
