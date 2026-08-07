import test from "node:test"
import assert from "node:assert/strict"
import { register } from "node:module"
import { pathToFileURL } from "node:url"

// Must run before the harness so Solid resolves to its real client build.
register("./solid-client-loader.mjs", pathToFileURL(import.meta.filename))

const { createProjectStore } = await import("./project-store-harness.mjs")
const { createRoot, createEffect, createSignal } = await import("solid-js")

const PROJECTS = [
  { id: "p1", worktree: "C:/work/alpha", name: "Alpha" },
  { id: "p2", worktree: "C:/work/beta", name: "Beta" },
]
const SESSIONS = [
  { id: "s1", title: "Alpha work", projectID: "p1", directory: "C:/work/alpha", time: { updated: Date.now() } },
  { id: "s2", title: "Beta work", projectID: "p2", directory: "C:/work/beta", time: { updated: Date.now() - 1000 } },
]

function createApi(overrides = {}) {
  const kv = new Map(Object.entries(overrides.kv ?? {}))
  const [kvReady, setKvReady] = createSignal(overrides.kvReady !== false)
  const listeners = new Map()
  const calls = { projectList: 0, sessionList: 0, statusList: 0, messageList: 0, todoList: 0, diffList: 0 }
  const api = {
    calls,
    listeners,
    kvStore: kv,
    kv: {
      get ready() { return kvReady() },
      get: (key, fallback) => (kvReady() && kv.has(key) ? kv.get(key) : fallback),
      set: (key, value) => kv.set(key, value),
    },
    setKvReady,
    event: {
      on: (name, handler) => {
        listeners.set(name, handler)
        return () => listeners.delete(name)
      },
    },
    route: { current: { name: "session", params: { sessionID: "s1" } } },
    state: { path: { directory: "C:/work/alpha" }, session: { status: () => undefined } },
    client: {
      project: {
        list: async () => {
          calls.projectList += 1
          return { data: overrides.projects ?? PROJECTS }
        },
      },
      session: {
        list: async () => {
          calls.sessionList += 1
          if (overrides.failSessions) throw new Error("network down")
          return { data: overrides.sessions ?? SESSIONS }
        },
        status: async () => {
          calls.statusList += 1
          return { data: overrides.statuses ?? {} }
        },
        messages: async ({ sessionID }) => {
          calls.messageList += 1
          return { data: overrides.messages?.[sessionID] ?? [{ info: { role: "assistant", time: { completed: Date.now() } } }] }
        },
        todo: async ({ sessionID }) => {
          calls.todoList += 1
          if (overrides.failIntelligence) throw new Error("intelligence offline")
          return { data: overrides.todos?.[sessionID] ?? [] }
        },
        diff: async ({ sessionID }) => {
          calls.diffList += 1
          if (overrides.failIntelligence) throw new Error("intelligence offline")
          return { data: overrides.diffs?.[sessionID] ?? [] }
        },
      },
    },
  }
  return api
}

/** Run inside a reactive root and always dispose, so cleanup paths execute. */
async function withStore(api, fn) {
  let dispose
  const store = createRoot((d) => {
    dispose = d
    return createProjectStore(api)
  })
  try {
    // Let the initial load settle.
    await new Promise((resolve) => setTimeout(resolve, 10))
    return await fn(store)
  } finally {
    dispose()
  }
}

test("guard: solid resolves to the reactive client build, not the SSR stub", async () => {
  const { createSignal } = await import("solid-js")
  const [value, setValue] = createSignal(1)
  setValue(2)
  assert.equal(value(), 2, "signals must update; SSR builds would break every assertion below")
})

test("a persisted portfolio snapshot makes the first frame complete before network refresh", async () => {
  const savedAt = Date.now() - 1000
  const api = createApi({
    kv: {
      alonix_registered_projects: ["C:/work/alpha", "C:/work/beta"],
      alonix_portfolio_snapshot: { version: 1, savedAt, projects: PROJECTS, sessions: SESSIONS },
    },
  })
  api.client.project.list = async () => new Promise(() => {})
  let dispose
  const store = createRoot((d) => { dispose = d; return createProjectStore(api) })
  try {
    const result = await store.waitForInitialLoad()
    assert.equal(result.ready, true)
    assert.equal(result.cached, true)
    assert.equal(store.ready, true)
    assert.equal(store.phase, "cached")
    assert.equal(store.summary().projects, 2)
    assert.equal(store.summary().sessions, 2)
    assert.equal(store.loadedAt, savedAt)
  } finally { dispose() }
})

test("successful portfolio loading refreshes the durable first-frame snapshot", async () => {
  const api = createApi()
  await withStore(api, (store) => {
    const snapshot = api.kvStore.get("alonix_portfolio_snapshot")
    assert.equal(snapshot.version, 1)
    assert.equal(snapshot.projects.length, 2)
    assert.equal(snapshot.sessions.length, 2)
    assert.equal(store.ready, true)
  })
})

test("the initial readiness barrier resolves only after an authoritative portfolio cycle", async () => {
  const api = createApi()
  let releaseProjects
  api.client.project.list = async () => new Promise((resolve) => { releaseProjects = () => resolve({ data: PROJECTS }) })
  let dispose
  const store = createRoot((d) => { dispose = d; return createProjectStore(api) })
  try {
    let settled = false
    const barrier = store.waitForInitialLoad().then((value) => { settled = true; return value })
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(settled, false)
    assert.equal(store.ready, false)
    releaseProjects()
    const result = await barrier
    assert.equal(result.ready, true)
    assert.equal(store.ready, true)
    assert.ok(store.loadedAt > 0)
  } finally { dispose() }
})

test("the initial readiness barrier is bounded when authoritative loading never settles", async () => {
  const api = createApi()
  api.client.project.list = async () => new Promise(() => {})
  let dispose
  const store = createRoot((d) => { dispose = d; return createProjectStore(api) })
  try {
    const result = await store.waitForInitialLoad(40)
    assert.equal(result.ready, false)
    assert.equal(result.phase, "timeout")
    assert.equal(store.ready, false)
  } finally { dispose() }
})

test("the store loads projects and sessions across every directory", async () => {
  const api = createApi()
  await withStore(api, (store) => {
    assert.equal(api.calls.projectList, 1)
    // One request per project worktree, plus the launch directory.
    assert.equal(api.calls.sessionList, 3)
    assert.equal(store.projects.length, 2)
    assert.equal(store.sessions.length, 2)
    assert.ok(store.loadedAt > 0)
    assert.equal(store.ready, true)
    assert.equal(store.phase, "ready")

    // The derived model spans both projects.
    const rows = store.projectRows()
    assert.equal(rows.length, 2)
    assert.equal(store.summary().sessions, 2)
  })
})

test("sessions are fetched per project directory, not just the launch one", async () => {
  // Regression: session.list answers for one directory. Listing once returned
  // the launch project's sessions no matter which project was selected, so
  // switching projects appeared to show the wrong sessions.
  const api = createApi()
  const asked = []
  api.client.session.list = async (args) => {
    asked.push(args?.directory ?? "")
    if (args?.directory === "C:/work/alpha") return { data: [SESSIONS[0]] }
    if (args?.directory === "C:/work/beta") return { data: [SESSIONS[1]] }
    return { data: [] }
  }

  await withStore(api, (store) => {
    assert.ok(asked.includes("C:/work/alpha"), "each project worktree must be queried")
    assert.ok(asked.includes("C:/work/beta"))
    assert.ok(asked.includes(""), "the launch directory must still be queried")
    assert.ok(asked.every((entry) => entry !== undefined))

    // Both projects' sessions are present, each under its own project.
    assert.equal(store.sessions.length, 2)
    const rows = store.projectRows()
    assert.equal(rows.find((row) => row.id === "p1").sessionCount, 1)
    assert.equal(rows.find((row) => row.id === "p2").sessionCount, 1)
  })
})

test("a session reachable from two directories is listed once", async () => {
  const api = createApi()
  // Every directory returns the same session, as a nested checkout would.
  api.client.session.list = async () => ({ data: [SESSIONS[0]] })
  await withStore(api, (store) => {
    assert.equal(store.sessions.length, 1, "duplicates across directories must collapse")
  })
})

test("Windows rooted-slash persisted folders recover the current drive identity", async () => {
  if (process.platform !== "win32") return
  const api = createApi({ kv: { alonix_registered_projects: ["/Users/dell/work/saved"] }, projects: [], sessions: [] })
  await withStore(api, (store) => {
    assert.match(store.registeredProjects[0], /^[A-Za-z]:\/Users\/dell\/work\/saved$/)
    assert.equal(store.projectRows()[0].stateKey, `directory:${store.registeredProjects[0].toLowerCase()}`)
    assert.deepEqual(api.kvStore.get("alonix_registered_projects"), store.registeredProjects, "repaired identity is written back once")
  })
})

test("registered folders render immediately but chat counts stay non-authoritative until loading finishes", async () => {
  const api = createApi({ kv: { alonix_registered_projects: ["C:/work/saved"] } })
  api.client.project.list = async () => new Promise(() => {})
  const previous = process.env.ALONIX_PORTFOLIO_REQUEST_TIMEOUT_MS
  process.env.ALONIX_PORTFOLIO_REQUEST_TIMEOUT_MS = "100"
  try {
    await withStore(api, (store) => {
      assert.equal(store.projects.length, 1)
      assert.equal(store.projects[0].worktree, "C:/work/saved")
      assert.equal(store.projectRows()[0].name, "saved")
      assert.equal(store.ready, false)
      assert.equal(store.phase, "loading")
    })
  } finally {
    if (previous === undefined) delete process.env.ALONIX_PORTFOLIO_REQUEST_TIMEOUT_MS
    else process.env.ALONIX_PORTFOLIO_REQUEST_TIMEOUT_MS = previous
  }
})

test("a hung SDK request times out and never leaves folders loading forever", async () => {
  const api = createApi({ kv: { alonix_registered_projects: ["C:/work/saved"] } })
  api.client.project.list = async () => new Promise(() => {})
  api.client.session.list = async () => new Promise(() => {})
  const previous = process.env.ALONIX_PORTFOLIO_REQUEST_TIMEOUT_MS
  process.env.ALONIX_PORTFOLIO_REQUEST_TIMEOUT_MS = "100"
  try {
    await withStore(api, async (store) => {
      // Project discovery times out first; only then can the bounded per-folder
      // chat listings begin, so allow both authoritative phases to settle.
      await new Promise((resolve) => setTimeout(resolve, 260))
      assert.equal(store.loading, false, "a missing SDK response must not trap the dock in loading")
      assert.equal(store.ready, false, "failed initial loading must not make zero chats authoritative")
      assert.equal(store.phase, "error")
      assert.equal(store.projects.length, 1, "persisted folders remain usable")
      assert.match(store.error, /project listing.*timed out/i)
    })
  } finally {
    if (previous === undefined) delete process.env.ALONIX_PORTFOLIO_REQUEST_TIMEOUT_MS
    else process.env.ALONIX_PORTFOLIO_REQUEST_TIMEOUT_MS = previous
  }
})

test("one unreachable project does not blank the whole portfolio", async () => {
  const api = createApi()
  api.client.session.list = async (args) => {
    if (args?.directory === "C:/work/beta") throw new Error("workspace offline")
    return { data: [SESSIONS[0]] }
  }
  await withStore(api, (store) => {
    assert.equal(store.sessions.length, 1, "the reachable project still loads")
    assert.match(store.error, /beta|offline/i, "the failure is reported, not hidden")
  })
})

test("a failed load keeps the previous portfolio instead of blanking it", async () => {
  const api = createApi()
  await withStore(api, async (store) => {
    assert.equal(store.sessions.length, 2)
    // Make the next load fail.
    api.client.session.list = async () => {
      throw new Error("network down")
    }
    await store.reload()
    assert.equal(store.sessions.length, 2, "stale data is better than an empty workbench")
    assert.match(store.error, /network down/)
  })
})

test("concurrent refreshes collapse into a single in-flight request", async () => {
  const api = createApi()
  await withStore(api, async (store) => {
    // A refresh now queries every project directory, so count refresh cycles
    // rather than raw requests.
    let cycles = 0
    const pending = []
    api.client.project.list = async () => {
      cycles += 1
      return { data: PROJECTS }
    }
    api.client.session.list = async () =>
      new Promise((resolve) => pending.push(() => resolve({ data: SESSIONS })))

    const first = store.reload()
    const second = store.reload()
    const third = store.reload()
    // Let the in-flight cycle reach its session requests, then release them.
    await new Promise((resolve) => setTimeout(resolve, 10))
    for (const release of pending.splice(0)) release()
    await new Promise((resolve) => setTimeout(resolve, 10))
    for (const release of pending.splice(0)) release()
    await Promise.all([first, second, third])

    // One in-flight cycle plus at most one queued follow-up, never three.
    assert.ok(cycles <= 2, `overlapping refreshes must not stampede the server, saw ${cycles} cycles`)
  })
})

test("session events trigger a debounced refresh", async () => {
  const api = createApi()
  await withStore(api, async (store) => {
    // project.list runs exactly once per refresh cycle, so it is the reliable
    // way to count reloads now that sessions are fetched per directory.
    const before = api.calls.projectList
    const handler = api.listeners.get("session.updated")
    assert.ok(handler, "the store must subscribe to session.updated")
    handler()
    handler()
    handler()
    await new Promise((resolve) => setTimeout(resolve, 320))
    assert.equal(api.calls.projectList, before + 1, "a burst of events collapses into one reload")
  })
})

test("streaming token events never trigger a portfolio-wide reload", async () => {
  const api = createApi()
  await withStore(api, async () => {
    const before = api.calls.projectList
    assert.equal(api.listeners.has("message.part.updated"), false, "token events must stay on the host's local reactive path")
    assert.equal(api.listeners.has("message.updated"), false)
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(api.calls.projectList, before)
  })
})

test("presence events use lightweight reconciliation instead of listing every session", async () => {
  const api = createApi()
  await withStore(api, async () => {
    const beforeProjects = api.calls.projectList
    const beforeStatuses = api.calls.statusList
    const handler = api.listeners.get("session.status")
    assert.ok(handler)
    handler()
    handler()
    handler()
    await new Promise((resolve) => setTimeout(resolve, 320))
    assert.equal(api.calls.projectList, beforeProjects, "presence changes must not reload project/session structure")
    assert.ok(api.calls.statusList > beforeStatuses)
  })
})

test("presence refresh bounds SDK fan-out and queues follow-up work through a debounce", async () => {
  const api = createApi({
    projects: Array.from({ length: 18 }, (_, index) => ({ id: `p${index}`, worktree: `C:/work/p${index}`, name: `P${index}` })),
    sessions: Array.from({ length: 100 }, (_, index) => ({ id: `s${index}`, projectID: `p${index % 18}`, directory: `C:/work/p${index % 18}`, time: { updated: Date.now() - index } })),
  })
  let active = 0
  let peak = 0
  api.client.session.status = async () => {
    active += 1
    peak = Math.max(peak, active)
    await new Promise((resolve) => setTimeout(resolve, 2))
    active -= 1
    return { data: {} }
  }
  await withStore(api, async (store) => {
    await store.refreshPresence()
    assert.ok(peak <= 4, `presence SDK concurrency must be bounded, saw ${peak}`)
  })
})

test("cleanup unsubscribes so a disposed store stops refreshing", async () => {
  const api = createApi()
  let dispose
  const store = createRoot((d) => {
    dispose = d
    return createProjectStore(api)
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  const handler = api.listeners.get("session.updated")
  const before = api.calls.projectList
  dispose()
  handler?.()
  await new Promise((resolve) => setTimeout(resolve, 220))
  assert.equal(api.calls.projectList, before, "a disposed store must not keep polling")
  assert.equal(api.listeners.size, 0, "every listener must be removed")
  void store
})

test("presence reconciliation rotates through older chats instead of permanently hiding work", async () => {
  const now = Date.now()
  const sessions = Array.from({ length: 80 }, (_, index) => ({
    id: `s${index}`,
    title: `Chat ${index}`,
    projectID: "p1",
    directory: "C:/work/alpha",
    time: { updated: now - index },
  }))
  sessions[79].time.updated = now
  const api = createApi({ sessions })
  api.client.session.messages = async ({ sessionID }) => {
    api.calls.messageList += 1
    return { data: sessionID === "s79" ? [{ info: { role: "user", time: { created: now } } }] : [{ info: { role: "assistant", time: { completed: now } } }] }
  }
  await withStore(api, async (store) => {
    for (let index = 0; index < 3; index += 1) await store.refreshPresence()
    assert.equal(store.sessionRows().find((row) => row.id === "s79")?.running, true)
  })
})

test("historical unfinished transcripts stay idle when rotation eventually reaches them", async () => {
  const old = Date.now() - 30 * 24 * 60 * 60 * 1000
  const sessions = Array.from({ length: 80 }, (_, index) => ({
    id: `old-${index}`,
    title: `Old chat ${index}`,
    projectID: "p1",
    directory: "C:/work/alpha",
    time: { updated: old - index },
  }))
  const api = createApi({ sessions })
  api.client.session.messages = async () => ({ data: [{ info: { role: "user", time: { created: old } } }] })
  await withStore(api, async (store) => {
    for (let index = 0; index < 3; index += 1) await store.refreshPresence()
    assert.equal(store.sessionRows().find((row) => row.id === "old-79")?.running, false)
  })
})

test("durable transcript state repairs false idle status from another process", async () => {
  const api = createApi({
    statuses: { s1: { type: "idle" } },
    messages: { s1: [{ info: { role: "user", time: { created: Date.now() } } }] },
  })
  await withStore(api, (store) => {
    assert.equal(store.sessionRows().find((row) => row.id === "s1").running, true)
    assert.ok(api.calls.statusList >= 1)
    assert.ok(api.calls.messageList >= 1)
  })
})

test("added folders persist immediately without creating a session", async () => {
  const api = createApi()
  await withStore(api, async (store) => {
    assert.equal(store.addProject("C:/work/new-folder"), true)
    assert.ok(store.registeredProjects.includes("C:/work/new-folder"))
    assert.ok(api.kvStore.has("alonix_registered_projects"))
    const immediate = store.projectRows().find((item) => item.worktree === "C:/work/new-folder")
    assert.ok(immediate, "the folder must appear optimistically without waiting for the SDK")
    await new Promise((resolve) => setTimeout(resolve, 20))
    const row = store.projectRows().find((item) => item.worktree === "C:/work/new-folder")
    assert.ok(row, "the manually registered folder must appear before its first chat")
    assert.equal(row.sessionCount, 0)
  })
})

test("a reload discovers folders registered by another OpenCode process", async () => {
  const api = createApi()
  await withStore(api, async (store) => {
    api.kvStore.set("alonix_registered_projects", ["C:/work/from-other-window"])
    await store.reload()
    assert.ok(store.registeredProjects.includes("C:/work/from-other-window"))
    assert.ok(store.projectRows().some((row) => row.worktree === "C:/work/from-other-window"))
  })
})

test("sidebar recents are global rather than inherited from selected-project ordering", async () => {
  const now = Date.now()
  const api = createApi({
    sessions: [
      { id: "selected-old", title: "Selected old", projectID: "p1", directory: "C:/work/alpha", time: { updated: now - 10_000 } },
      { id: "other-new", title: "Other newest", projectID: "p2", directory: "C:/work/beta", time: { updated: now } },
      { id: "other-working", title: "Other working", projectID: "p2", directory: "C:/work/beta", time: { updated: now - 20_000 } },
    ],
    statuses: { "other-working": { type: "busy" } },
  })
  await withStore(api, (store) => {
    store.selectProject(store.projectRows().find((row) => row.id === "p1"))
    assert.deepEqual(store.recentSessionRows().slice(0, 2).map((row) => row.id), ["other-working", "other-new"])
    assert.equal(store.recentSessionRows().find((row) => row.id === "other-new")?.projectID, "p2")
  })
})

test("ID-only navigation resolves and persists the owning project directory", async () => {
  const api = createApi()
  await withStore(api, (store) => {
    store.selectProject("p2")
    assert.equal(store.projectRows().find((row) => row.id === "p2").current, true)
    assert.deepEqual(api.kvStore.get("alonix_selected_project"), { id: "p2", directory: "C:/work/beta" })
  })
})

test("explicit selection changes the highlighted project", async () => {
  const api = createApi()
  await withStore(api, (store) => {
    store.selectProject(store.projectRows().find((row) => row.id === "p2"))
    assert.equal(store.projectRows().find((row) => row.id === "p2").current, true)
    assert.equal(store.projectRows().find((row) => row.id === "p1").current, false)
  })
})

test("installed-fast startup hydrates delayed host KV instead of losing opened folders and tabs", async () => {
  const saved = {
    tabs: [{ id: "s1", title: "Alpha work", projectID: "p1", directory: "C:/work/alpha" }],
    activeID: "s1",
    mru: ["s1"],
    focus: "main",
    collapsed: ["p1"],
  }
  const api = createApi({
    kvReady: false,
    kv: {
      alonix_workbench_state: saved,
      alonix_registered_projects: ["C:/work/alpha"],
      alonix_selected_project: { id: "p1", directory: "C:/work/alpha" },
    },
  })
  await withStore(api, async (store) => {
    assert.deepEqual(store.workbench.tabs, [], "state is not guessed before host KV is ready")
    api.setKvReady(true)
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.deepEqual(store.workbench.tabs.map((tab) => tab.id), ["s1"])
    assert.equal(store.selectedProjectID, "p1")
    assert.ok(store.workbench.collapsed.has("directory:c:/work/alpha"), "legacy project ID migrates to directory identity")
    assert.deepEqual(api.kvStore.get("alonix_workbench_state").collapsed, ["directory:c:/work/alpha"], "canonical identity is flushed to durable KV")
  })
})

test("an interaction before delayed KV hydration wins without overwriting saved state early", async () => {
  const api = createApi({
    kvReady: false,
    kv: { alonix_workbench_state: { tabs: [{ id: "s1" }], activeID: "s1", mru: ["s1"], collapsed: [] } },
  })
  await withStore(api, async (store) => {
    store.openTab({ id: "s2", title: "New interaction", projectID: "p2" })
    assert.deepEqual(api.kvStore.get("alonix_workbench_state").tabs.map((tab) => tab.id), ["s1"], "disk snapshot is untouched before hydration")
    api.setKvReady(true)
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.deepEqual(store.workbench.tabs.map((tab) => tab.id), ["s2"], "queued user change has precedence")
    assert.deepEqual(api.kvStore.get("alonix_workbench_state").tabs.map((tab) => tab.id), ["s2"])
  })
})

test("tabs persist across restarts through kv", async () => {
  const api = createApi()
  await withStore(api, (store) => {
    store.openTab({ id: "s1", title: "Alpha work", projectID: "p1" })
    store.openTab({ id: "s2", title: "Beta work", projectID: "p2" })
    assert.equal(store.workbench.tabs.length, 2)
    assert.ok(api.kvStore.has("alonix_workbench_state"), "workbench state must be written to kv")
  })

  // A fresh store restores what the previous one saved.
  const restored = createApi({ kv: Object.fromEntries(api.kvStore) })
  await withStore(restored, (store) => {
    assert.deepEqual(store.workbench.tabs.map((tab) => tab.id), ["s1", "s2"])
  })
})

test("tabs for deleted sessions are reconciled away once a listing arrives", async () => {
  const api = createApi()
  await withStore(api, async (store) => {
    store.openTab({ id: "s1", title: "Alpha work" })
    store.openTab({ id: "s2", title: "Beta work" })
    assert.equal(store.workbench.tabs.length, 2)

    // s2 disappears server-side.
    api.client.session.list = async () => ({ data: [SESSIONS[0]] })
    await store.reload()
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.deepEqual(store.workbench.tabs.map((tab) => tab.id), ["s1"])
  })
})

test("delivery intelligence loads persisted todos and files through a bounded SDK window", async () => {
  const sessions = Array.from({ length: 40 }, (_, index) => ({ id: `delivery-${index}`, title: `Delivery ${index}`, projectID: "p1", directory: "C:/work/alpha", time: { updated: Date.now() - index } }))
  const api = createApi({
    sessions,
    todos: { "delivery-0": [{ content: "Review architecture", status: "in_progress" }] },
    diffs: { "delivery-0": [{ file: "src/architecture.ts", additions: 4, deletions: 1 }] },
  })
  await withStore(api, (store) => {
    const row = store.sessionRows().find((item) => item.id === "delivery-0")
    assert.deepEqual(row.todos, [{ content: "Review architecture", status: "in_progress" }])
    assert.deepEqual(row.files, [{ file: "src/architecture.ts", additions: 4, deletions: 1 }])
    assert.ok(api.calls.todoList <= 12, `todo fan-out must stay bounded, saw ${api.calls.todoList}`)
    assert.ok(api.calls.diffList <= 12, `diff fan-out must stay bounded, saw ${api.calls.diffList}`)
    const snapshot = api.kvStore.get("alonix_portfolio_snapshot")
    assert.ok(snapshot.sessions.some((session) => session.id === "delivery-0" && session.alonixTodos?.length === 1))
  })
})

test("delivery intelligence failures preserve cached todos and files", async () => {
  const cached = [{ ...SESSIONS[0], alonixTodos: [{ content: "Keep me", status: "pending" }], alonixFiles: [{ file: "src/keep.ts" }] }]
  const api = createApi({ kv: { alonix_portfolio_snapshot: { version: 1, savedAt: Date.now(), projects: PROJECTS, sessions: cached } }, sessions: [SESSIONS[0]], failIntelligence: true })
  await withStore(api, (store) => {
    const row = store.sessionRows().find((item) => item.id === "s1")
    assert.equal(row.todos[0].content, "Keep me")
    assert.equal(row.files[0].file, "src/keep.ts")
  })
})

test("delivery review and decisions persist through KV including delayed hydration", async () => {
  const api = createApi({ kvReady: false, kv: { alonix_delivery_state: { reviewed: ["saved"], decisions: [{ id: "d1", text: "Keep API stable", projectID: "p1", projectName: "Alpha", createdAt: 1 }] } } })
  await withStore(api, async (store) => {
    assert.deepEqual(store.delivery.reviewed, [])
    api.setKvReady(true)
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.deepEqual(store.delivery.reviewed, ["saved"])
    assert.equal(store.delivery.decisions[0].text, "Keep API stable")
    assert.equal(store.markReviewed("s1"), true)
    assert.equal(store.markReviewed("s1"), false)
    assert.equal(store.addDecision({ text: "Use one queue", projectID: "p1", projectName: "Alpha" }), true)
    const persisted = api.kvStore.get("alonix_delivery_state")
    assert.ok(persisted.decisions.some((item) => item.text === "Use one queue"))
    assert.equal(store.removeDecision("d1"), true)
  })
})

test("the portfolio store never creates sessions", async () => {
  const api = createApi()
  await withStore(api, (store) => {
    assert.equal(store.createSession, undefined, "session creation belongs to the native prompt submit path")
    assert.equal(api.client.session.create, undefined, "loading and navigation must not need a creation endpoint")
  })
})

test("pinned projects persist by canonical directory identity", async () => {
  const api = createApi()
  await withStore(api, (store) => {
    const beta = store.projectRows().find((row) => row.id === "p2")
    store.togglePinProject(beta)
    assert.deepEqual(store.pinnedProjects, ["directory:c:/work/beta"])
    assert.ok(store.projectRows().find((row) => row.id === "p2").pinned)
    store.togglePinProject(beta)
    assert.deepEqual(store.pinnedProjects, [])
  })
})

test("derived rows react to new data without manual re-reads", async () => {
  const api = createApi()
  await withStore(api, async (store) => {
    const seen = []
    createRoot(() => createEffect(() => seen.push(store.summary().sessions)))
    await new Promise((resolve) => setTimeout(resolve, 5))

    api.client.session.list = async () => ({
      data: [...SESSIONS, { id: "s3", title: "Third", projectID: "p1", directory: "C:/work/alpha", time: {} }],
    })
    await store.reload()
    await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(store.summary().sessions, 3, "the derived summary must track the new listing")
  })
})

test("a missing client degrades to an empty portfolio without throwing", async () => {
  const api = createApi()
  api.client = undefined
  await withStore(api, (store) => {
    assert.deepEqual(store.projects, [])
    assert.deepEqual(store.sessions, [])
    assert.equal(store.error, "")
  })
})

test("corrupt persisted state does not prevent startup", async () => {
  const api = createApi({ kv: { alonix_workbench_state: { tabs: "nonsense", activeID: 42 }, alonix_pinned_projects: 7 } })
  await withStore(api, (store) => {
    assert.deepEqual(store.workbench.tabs, [])
    assert.deepEqual(store.pinnedProjects, [])
  })
})
