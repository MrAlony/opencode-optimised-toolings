import test from "node:test"
import assert from "node:assert/strict"
import { stripTypeScriptTypes } from "node:module"
import { manifest } from "../patches/1.18.13/manifest.mjs"

async function loadBuffer() {
  const source = manifest.create.find((item) => item.path.endsWith("part-delta-buffer.ts"))?.content
  assert.ok(source, "generated part delta buffer must exist")
  const javascript = stripTypeScriptTypes(source, { mode: "transform" })
  return import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`)
}

function harness(createPartDeltaBuffer) {
  const scheduled = []
  const cancelled = []
  const commits = []
  const buffer = createPartDeltaBuffer((entries) => commits.push(entries), {
    frameMs: 16,
    schedule(callback, delay) {
      const handle = { callback, delay }
      scheduled.push(handle)
      return handle
    },
    cancel(handle) {
      cancelled.push(handle)
    },
  })
  return { buffer, scheduled, cancelled, commits }
}

test("part delta buffer preserves every byte and schedules one commit per burst", async () => {
  const { createPartDeltaBuffer } = await loadBuffer()
  const { buffer, scheduled, commits } = harness(createPartDeltaBuffer)
  const base = { sessionID: "s1", messageID: "m1", partID: "p1", field: "text" }

  for (const delta of ["Hel", "lo", " ", "🌍", "!"]) buffer.queue({ ...base, delta })
  assert.equal(scheduled.length, 1)
  assert.equal(scheduled[0].delay, 16)
  assert.equal(commits.length, 0)

  scheduled[0].callback()
  assert.equal(commits.length, 1)
  assert.equal(commits[0].length, 1)
  assert.equal(commits[0][0].delta, "Hello 🌍!")
  assert.equal(buffer.size, 0)
})

test("part delta buffer bounds sustained multi-part streaming commits with exact final content", async () => {
  const { createPartDeltaBuffer } = await loadBuffer()
  const scheduled = []
  const content = new Map()
  let commitCount = 0
  const buffer = createPartDeltaBuffer((entries) => {
    commitCount += 1
    for (const entry of entries) {
      const key = `${entry.messageID}:${entry.partID}:${entry.field}`
      content.set(key, (content.get(key) ?? "") + entry.delta)
    }
  }, {
    schedule(callback) {
      scheduled.push(callback)
      return callback
    },
    cancel() {},
  })

  const parts = 20
  const frames = 200
  const deltasPerPartPerFrame = 5
  for (let frame = 0; frame < frames; frame += 1) {
    for (let part = 0; part < parts; part += 1) {
      for (let delta = 0; delta < deltasPerPartPerFrame; delta += 1) {
        buffer.queue({
          sessionID: "s1",
          messageID: `m${part}`,
          partID: `p${part}`,
          field: "text",
          delta: `${frame}:${part}:${delta}|`,
        })
      }
    }
    assert.equal(scheduled.length, frame + 1, "one callback should represent one simulated display frame")
    scheduled[frame]()
  }

  assert.equal(commitCount, frames, "20,000 provider deltas must collapse to 200 frame commits")
  for (let part = 0; part < parts; part += 1) {
    let expected = ""
    for (let frame = 0; frame < frames; frame += 1) {
      for (let delta = 0; delta < deltasPerPartPerFrame; delta += 1) expected += `${frame}:${part}:${delta}|`
    }
    assert.equal(content.get(`m${part}:p${part}:text`), expected)
  }
})

test("part delta buffer keeps fields isolated and flushes authoritative boundaries selectively", async () => {
  const { createPartDeltaBuffer } = await loadBuffer()
  const { buffer, commits } = harness(createPartDeltaBuffer)
  buffer.queue({ sessionID: "s1", messageID: "m1", partID: "p1", field: "text", delta: "A" })
  buffer.queue({ sessionID: "s1", messageID: "m1", partID: "p1", field: "reasoning", delta: "B" })
  buffer.queue({ sessionID: "s2", messageID: "m2", partID: "p2", field: "text", delta: "C" })

  assert.equal(buffer.flush((entry) => entry.sessionID === "s1"), 2)
  assert.deepEqual(commits[0].map((entry) => [entry.field, entry.delta]), [["text", "A"], ["reasoning", "B"]])
  assert.equal(buffer.size, 1)

  buffer.dispose()
  assert.equal(commits.length, 2)
  assert.equal(commits[1][0].delta, "C")
  assert.equal(buffer.size, 0)
})
