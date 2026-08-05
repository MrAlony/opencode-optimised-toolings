import test from "node:test"
import assert from "node:assert/strict"
import { listDirectory, listProjects, listSessions } from "../lib/sdk.js"

test("the adapter uses the generated v2 client's flat parameter contract", async () => {
  const calls = { list: [], files: [], projects: [] }
  const client = {
    project: { list: async (args) => (calls.projects.push(args), { data: [{ id: "p" }] }) },
    session: { list: async (args) => (calls.list.push(args), { data: [{ id: "s" }] }) },
    file: { list: async (args) => (calls.files.push(args), { data: [{ name: "src", type: "directory" }] }) },
  }

  assert.deepEqual(await listProjects(client), [{ id: "p" }])
  assert.deepEqual(await listSessions(client, { directory: "C:/work/beta", roots: true, limit: 25 }), [{ id: "s" }])
  assert.deepEqual(await listDirectory(client, "C:/work/beta"), [{ name: "src", type: "directory" }])

  assert.deepEqual(calls.projects[0], {})
  assert.deepEqual(calls.list[0], { directory: "C:/work/beta", roots: true, limit: 25 })
  assert.deepEqual(calls.files[0], { path: "C:/work/beta", directory: "C:/work/beta" })
  for (const args of [...calls.list, ...calls.files]) {
    assert.equal("query" in args, false)
    assert.equal("body" in args, false)
  }
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
    session: { list: async () => ({ error: { message: "session failure" } }) },
    file: { list: async () => ({ error: { message: "file failure" } }) },
  }
  await assert.rejects(() => listProjects(client), /project failure/)
  await assert.rejects(() => listSessions(client), /session failure/)
  await assert.rejects(() => listDirectory(client, "C:/work"), /file failure/)
})

test("the TUI SDK adapter exposes no eager session creation helper", async () => {
  const sdk = await import("../lib/sdk.js")
  assert.equal(sdk.createSession, undefined)
  assert.equal(sdk.comparableDirectory, undefined)
})
