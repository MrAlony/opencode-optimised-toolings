import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { acknowledgeTerminalReceipt, clearCompletionReceipt, publishCompletionReceipt, publishTerminalReceipt, readCompletionReceipts } from "../lib/completion-receipt.js"

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "alonix-completion-"))
  return { root, api: { state: { path: { state: root } } } }
}

test("terminal receipts persist until explicit acknowledgement or replacement", () => {
  const { root, api } = fixture()
  try {
    assert.deepEqual(readCompletionReceipts(api), {})
    assert.equal(publishCompletionReceipt(api, "s1", { completedAt: 1_000 }), true)
    assert.equal(readCompletionReceipts(api).s1.completedAt, 1_000)
    assert.equal(readCompletionReceipts(api).s1.state, "completed")
    assert.equal(acknowledgeTerminalReceipt(api, "s1", { seenAt: 2_000 }), true)
    assert.equal(readCompletionReceipts(api).s1.state, "seen")
    assert.equal(publishTerminalReceipt(api, "s1", "error", { occurredAt: 3_000, detail: "failed" }), true)
    assert.equal(readCompletionReceipts(api).s1.state, "error")
    assert.equal(clearCompletionReceipt(api, "s1"), true)
    assert.deepEqual(readCompletionReceipts(api), {})
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("malformed receipt input degrades without throwing", () => {
  assert.deepEqual(readCompletionReceipts(null), {})
  assert.equal(publishCompletionReceipt(null, "s1"), false)
  assert.equal(publishTerminalReceipt(null, "s1", "error"), false)
  assert.equal(acknowledgeTerminalReceipt(null, "s1"), false)
  assert.equal(clearCompletionReceipt(null, "s1"), false)
})
