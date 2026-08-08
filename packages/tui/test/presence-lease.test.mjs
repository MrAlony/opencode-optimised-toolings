import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { spawnSync } from "node:child_process"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { clearPresenceLease, publishPresenceLease, readPresenceLeases } from "../lib/presence-lease.js"

const modulePath = fileURLToPath(new URL("../lib/presence-lease.js", import.meta.url))

function fixture() {
  const state = mkdtempSync(path.join(os.tmpdir(), "alonix-presence-"))
  return { state, api: { state: { path: { state } } }, dispose: () => rmSync(state, { recursive: true, force: true }) }
}

test("independent processes publish without overwriting each other", () => {
  const fx = fixture()
  try {
    const moduleUrl = pathToFileURL(modulePath).href
    for (const [sessionID, type] of [["session-a", "busy"], ["session-b", "retry"]]) {
      const script = `import { publishPresenceLease } from ${JSON.stringify(moduleUrl)}; const ok=publishPresenceLease({state:{path:{state:${JSON.stringify(fx.state)}}}},${JSON.stringify(sessionID)},{type:${JSON.stringify(type)}}); process.exit(ok?0:1)`
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" })
      assert.equal(child.status, 0, child.stderr)
    }
    const statuses = readPresenceLeases(fx.api)
    assert.equal(statuses["session-a"].type, "busy")
    assert.equal(statuses["session-b"].type, "retry")
  } finally { fx.dispose() }
})

test("a fresh consumer reads working state and session metadata synchronously", async () => {
  const fx = fixture()
  try {
    const { readPresenceSnapshot } = await import("../lib/presence-lease.js")
    assert.equal(publishPresenceLease(fx.api, "session-a", { type: "busy" }, { session: { id: "session-a", title: "Active work", directory: "C:/work/alpha", projectID: "p1", time: { updated: 123 } } }), true)
    const snapshot = readPresenceSnapshot(fx.api)
    assert.equal(snapshot.statuses["session-a"].type, "busy")
    assert.deepEqual(snapshot.sessions[0], { id: "session-a", title: "Active work", directory: "C:/work/alpha", projectID: "p1", parentID: undefined, time: { updated: 123 }, alonixPresenceOnly: true })
  } finally { fx.dispose() }
})

test("explicit idle cleanup removes every producer record for the session", () => {
  const fx = fixture()
  try {
    publishPresenceLease(fx.api, "session-a", { type: "busy" }, { owner: "one" })
    publishPresenceLease(fx.api, "session-a", { type: "retry" }, { owner: "two" })
    assert.equal(readPresenceLeases(fx.api)["session-a"].type, "retry")
    assert.equal(clearPresenceLease(fx.api, "session-a"), true)
    assert.equal(readPresenceLeases(fx.api)["session-a"], undefined)
  } finally { fx.dispose() }
})

test("expired and malformed records are ignored and pruned", () => {
  const fx = fixture()
  try {
    publishPresenceLease(fx.api, "session-old", { type: "busy" }, { now: 1 })
    assert.equal(readPresenceLeases(fx.api, { now: 30_000, ttlMs: 20_000 })["session-old"], undefined)
  } finally { fx.dispose() }
})
