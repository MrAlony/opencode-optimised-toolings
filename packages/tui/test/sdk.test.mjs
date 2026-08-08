import test from "node:test"
import assert from "node:assert/strict"
import { listDiff, listDirectory, listMessages, listProjects, listSessions, listStatuses, listTodos } from "../lib/sdk.js"

test("the adapter uses the generated v2 client's flat parameter contract", async () => {
  const calls = { list: [], files: [], projects: [], statuses: [], messages: [], todos: [], diffs: [] }
  const client = {
    project: { list: async (args) => (calls.projects.push(args), { data: [{ id: "p" }] }) },
    session: {
      list: async (args) => (calls.list.push(args), { data: [{ id: "s" }] }),
      status: async (args) => (calls.statuses.push(args), { data: { s: { type: "busy" } } }),
      messages: async (args) => (calls.messages.push(args), { data: [{ info: { role: "user" } }] }),
      todo: async (args) => (calls.todos.push(args), { data: [{ content: "Ship", status: "pending" }] }),
      diff: async (args) => (calls.diffs.push(args), { data: [{ file: "src/app.ts", additions: 1, deletions: 0 }] }),
    },
    file: { list: async (args) => (calls.files.push(args), { data: [{ name: "src", type: "directory" }] }) },
  }

  assert.deepEqual(await listProjects(client), [{ id: "p" }])
  assert.deepEqual(await listSessions(client, { directory: "C:/work/beta", roots: true, limit: 25 }), [{ id: "s" }])
  assert.deepEqual(await listDirectory(client, "C:/work/beta"), [{ name: "src", type: "directory" }])
  assert.deepEqual(await listStatuses(client, "C:/work/beta"), { s: { type: "busy" } })
  assert.deepEqual(await listMessages(client, { id: "s", directory: "C:/work/beta" }, 1), [{ info: { role: "user" } }])
  assert.deepEqual(await listTodos(client, { id: "s", directory: "C:/work/beta" }), [{ content: "Ship", status: "pending" }])
  assert.deepEqual(await listDiff(client, { id: "s", directory: "C:/work/beta" }), [{ file: "src/app.ts", additions: 1, deletions: 0 }])

  assert.deepEqual(calls.projects[0], {})
  assert.deepEqual(calls.list[0], { directory: "C:/work/beta", roots: true, limit: 25 })
  assert.deepEqual(calls.files[0], { path: "C:/work/beta", directory: "C:/work/beta" })
  assert.deepEqual(calls.statuses[0], { directory: "C:/work/beta" })
  assert.deepEqual(calls.messages[0], { sessionID: "s", directory: "C:/work/beta", limit: 1 })
  assert.deepEqual(calls.todos[0], { sessionID: "s", directory: "C:/work/beta" })
  assert.deepEqual(calls.diffs[0], { sessionID: "s", directory: "C:/work/beta" })
  for (const args of [...calls.list, ...calls.files]) {
    assert.equal("query" in args, false)
    assert.equal("body" in args, false)
  }
})

test("request options propagate cancellation to every generated SDK call", async () => {
  const signal = new AbortController().signal
  const seen = []
  const capture = async (_args, request) => { seen.push(request); return { data: [] } }
  const client = {
    project: { list: capture },
    session: { list: capture, status: capture, messages: capture, todo: capture, diff: capture },
    file: { list: capture },
  }
  await listProjects(client, { signal })
  await listSessions(client, {}, { signal })
  await listStatuses(client, "", { signal })
  await listMessages(client, "s", 1, { signal })
  await listTodos(client, "s", { signal })
  await listDiff(client, "s", { signal })
  await listDirectory(client, "C:/work", { signal })
  assert.equal(seen.length, 7)
  assert.ok(seen.every((request) => request?.signal === signal))
})

test("listing without a directory leaves the generated client on its launch scope", async () => {
  let args
  const client = { session: { list: async (input) => ((args = input), { data: [] }) } }
  await listSessions(client, { directory: "", roots: true })
  assert.deepEqual(args, { roots: true, limit: 400 })
})

test("SDK result errors become actionable exceptions", async () => {
  const client = {
    project: { list: async () => ({ error: { message: "project failure" } }) },
    session: {
      list: async () => ({ error: { message: "session failure" } }),
      status: async () => ({ error: { message: "status failure" } }),
      messages: async () => ({ error: { message: "message failure" } }),
      todo: async () => ({ error: { message: "todo failure" } }),
      diff: async () => ({ error: { message: "diff failure" } }),
    },
    file: { list: async () => ({ error: { message: "file failure" } }) },
  }
  await assert.rejects(() => listProjects(client), /project failure/)
  await assert.rejects(() => listSessions(client), /session failure/)
  await assert.rejects(() => listDirectory(client, "C:/work"), /file failure/)
  await assert.rejects(() => listStatuses(client), /status failure/)
  await assert.rejects(() => listMessages(client, "s"), /message failure/)
  await assert.rejects(() => listTodos(client, "s"), /todo failure/)
  await assert.rejects(() => listDiff(client, "s"), /diff failure/)
})

test("the TUI SDK adapter exposes no eager session creation helper", async () => {
  const sdk = await import("../lib/sdk.js")
  assert.equal(sdk.createSession, undefined)
  assert.equal(sdk.comparableDirectory, undefined)
})
