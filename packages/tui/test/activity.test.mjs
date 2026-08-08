import test from "node:test"
import assert from "node:assert/strict"
import { describeTool, liveActivity, sessionActivity } from "../lib/activity.js"

function toolPart(id, tool, input, status, time = 0) {
  return { id, type: "tool", tool, state: { input, status, time: { start: time } } }
}

test("tool descriptions read as plain language", () => {
  assert.equal(describeTool("read", { filePath: "C:/work/app/src/index.ts" }), "Reading index.ts")
  assert.equal(describeTool("edit", { path: "src/App.tsx" }), "Editing App.tsx")
  assert.equal(describeTool("bash", { command: "npm test --watch" }), "Running npm")
  assert.equal(describeTool("grep", { pattern: "TODO" }), "Searching TODO")
  assert.equal(describeTool("todowrite", {}), "Planning")
  // Unknown tools still produce something meaningful.
  assert.equal(describeTool("mystery", {}), "mystery")
  assert.equal(describeTool(undefined, undefined), "Working")
})

test("the feed is newest-first and bounded", () => {
  const messages = [{ id: "m1", role: "assistant" }]
  const parts = [
    toolPart("p1", "read", { filePath: "a.ts" }, "completed", 1),
    toolPart("p2", "edit", { filePath: "b.ts" }, "completed", 2),
    toolPart("p3", "bash", { command: "npm test" }, "running", 3),
  ]
  const activity = sessionActivity({ messages, getParts: () => parts, limit: 2 })
  assert.equal(activity.events.length, 2, "the limit is respected")
  assert.equal(activity.events[0].id, "p3", "newest event leads")
  assert.equal(activity.events[0].running, true)
})

test("the headline names the running tool", () => {
  const activity = sessionActivity({
    messages: [{ id: "m1", role: "assistant" }],
    getParts: () => [toolPart("p1", "read", { filePath: "server.ts" }, "running")],
  })
  assert.equal(activity.headline, "Reading server.ts")
  assert.equal(activity.runningCount, 1)
})

test("concurrent tools collapse into one summary headline", () => {
  const activity = sessionActivity({
    messages: [{ id: "m1", role: "assistant" }],
    getParts: () => [
      toolPart("p1", "read", { filePath: "a.ts" }, "running", 1),
      toolPart("p2", "read", { filePath: "b.ts" }, "running", 2),
      toolPart("p3", "read", { filePath: "c.ts" }, "running", 3),
    ],
  })
  assert.match(activity.headline, /\+2 more$/)
  assert.equal(activity.runningCount, 3)
})

test("a busy session with no running tool distinguishes thinking from responding", () => {
  const thinking = sessionActivity({ messages: [{ id: "m1", role: "user" }], getParts: () => [], busy: true })
  assert.equal(thinking.headline, "Thinking")

  const responding = sessionActivity({
    messages: [{ id: "m1", role: "assistant" }],
    getParts: () => [],
    busy: true,
  })
  assert.equal(responding.headline, "Responding")
})

test("failures surface in the headline and are counted", () => {
  const activity = sessionActivity({
    messages: [{ id: "m1", role: "assistant" }],
    getParts: () => [toolPart("p1", "bash", { command: "npm test" }, "error")],
  })
  assert.equal(activity.failedCount, 1)
  assert.match(activity.headline, /failed$/)
})

test("a newer successful tool clears an older failure from current health", () => {
  const activity = sessionActivity({
    messages: [{ id: "m1", role: "assistant" }],
    getParts: () => [
      toolPart("failed", "edit", { filePath: "broken.ts" }, "error", 1),
      toolPart("recovered", "edit", { filePath: "fixed.ts" }, "completed", 2),
    ],
  })
  assert.equal(activity.failedCount, 1, "history still records the failed call")
  assert.equal(activity.latestTool.id, "recovered")
  assert.equal(activity.latestToolFailed, false)
  assert.equal(activity.headline, "Waiting for you", "an old failure must not become the current headline")
})

test("a newer running or queued tool clears an older failure while work continues", () => {
  for (const status of ["pending", "running"]) {
    const activity = sessionActivity({
      messages: [{ id: "m1", role: "assistant" }],
      busy: true,
      getParts: () => [
        toolPart("failed", "edit", {}, "error", 1),
        toolPart("next", "read", {}, status, 2),
      ],
    })
    assert.equal(activity.latestTool.id, "next")
    assert.equal(activity.latestToolFailed, false)
  }
})

test("the newest failed tool remains an unresolved current error", () => {
  const activity = sessionActivity({
    messages: [{ id: "m1", role: "assistant" }],
    getParts: () => [
      toolPart("success", "read", {}, "completed", 1),
      toolPart("failed", "edit", {}, "error", 2),
    ],
  })
  assert.equal(activity.latestTool.id, "failed")
  assert.equal(activity.latestToolFailed, true)
  assert.match(activity.headline, /failed$/)
})

test("an idle session falls back to the assistant's last words", () => {
  const activity = sessionActivity({
    messages: [{ id: "m1", role: "assistant" }],
    getParts: () => [{ type: "text", text: "  All tests pass.\nDetails follow.  " }],
  })
  assert.equal(activity.headline, "All tests pass.", "the first meaningful line is used")
  assert.equal(activity.assistantText, "All tests pass.\nDetails follow.")
})

test("a long assistant reply is truncated for the headline", () => {
  const activity = sessionActivity({
    messages: [{ id: "m1", role: "assistant" }],
    getParts: () => [{ type: "text", text: "x".repeat(400) }],
  })
  assert.ok(activity.headline.length <= 80)
  assert.ok(activity.headline.endsWith("\u2026"))
})

test("an empty session is idle, not broken", () => {
  const activity = sessionActivity({ messages: [], getParts: () => [] })
  assert.equal(activity.headline, "Idle")
  assert.deepEqual(activity.events, [])
})

test("tool status is inferred when the host omits it", () => {
  const activity = sessionActivity({
    messages: [{ id: "m1", role: "assistant" }],
    // Output present but no explicit status: the call has finished.
    getParts: () => [{ id: "p1", type: "tool", tool: "read", state: { input: {}, output: "done" } }],
  })
  assert.equal(activity.events[0].state, "completed")
})

test("a throwing part lookup cannot break the feed", () => {
  assert.doesNotThrow(() => {
    const activity = sessionActivity({
      messages: [{ id: "m1", role: "assistant" }],
      getParts: () => {
        throw new Error("not synced")
      },
    })
    assert.deepEqual(activity.events, [])
  })
})

test("malformed input never throws", () => {
  for (const input of [undefined, {}, { messages: null }, { messages: [null, {}], getParts: null }]) {
    assert.doesNotThrow(() => sessionActivity(input))
  }
})

test("liveActivity reads host state and degrades safely", () => {
  const api = {
    state: {
      session: {
        messages: () => [{ id: "m1", role: "assistant" }],
        status: () => ({ type: "busy" }),
      },
      part: () => [toolPart("p1", "edit", { filePath: "main.rs" }, "running")],
    },
  }
  const activity = liveActivity(api, "s1")
  assert.equal(activity.busy, true)
  assert.equal(activity.headline, "Editing main.rs")
  assert.equal(activity.latestToolFailed, false)

  // Missing api, missing session, and throwing host state all degrade to idle.
  assert.equal(liveActivity(null, "s1").headline, "Idle")
  assert.equal(liveActivity(api, "").headline, "Idle")
  const broken = {
    state: {
      session: {
        messages: () => {
          throw new Error("unsynced")
        },
      },
    },
  }
  assert.equal(liveActivity(broken, "s1").headline, "Idle")
})
