import test from "node:test"
import assert from "node:assert/strict"
import { register } from "node:module"
import { pathToFileURL } from "node:url"

// Must run before the harness so Solid resolves to its real client build.
register("./solid-client-loader.mjs", pathToFileURL(import.meta.filename))

const { createProjectStore } = await import("./project-store-harness.mjs")
const { createRoot, createEffect } = await import("solid-js")

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
  const listeners = new Map()
  const calls = { projectList: 0, sessionList: 0, statusList: 0, messageList: 0 }
  const api = {
    calls,
    listeners,
    kvStore: kv,
    kv: {
      get: (key, fallback) => (kv.has(key) ? kv.get(key) : fallback),
      set: (key, value) => kv.set(key, value),
    },
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

test("the store loads projects and sessions across every directory", async () => {
  const api = createApi()
  await withStore(api, (store) => {
    assert.equal(api.calls.projectList, 1)
    // One request per project worktree, plus the launch directory.
    assert.equal(api.calls.sessionList, 3)
    assert.equal(store.projects.length, 2)
    assert.equal(store.sessions.length, 2)
    assert.ok(store.loadedAt > 0)

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

test("explicit selection changes the highlighted project", async () => {
  const api = createApi()
  await withStore(api, (store) => {
    store.selectProject(store.projectRows().find((row) => row.id === "p2"))
    assert.equal(store.projectRows().find((row) => row.id === "p2").current, true)
    assert.equal(store.projectRows().find((row) => row.id === "p1").current, false)
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

test("the portfolio store never creates sessions", async () => {
  const api = createApi()
  await withStore(api, (store) => {
    assert.equal(store.createSession, undefined, "session creation belongs to the native prompt submit path")
    assert.equal(api.client.session.create, undefined, "loading and navigation must not need a creation endpoint")
  })
})

test("pinned projects persist and toggle", async () => {
  const api = createApi()
  await withStore(api, (store) => {
    store.togglePinProject("p2")
    assert.deepEqual(store.pinnedProjects, ["p2"])
    assert.ok(store.projectRows().find((row) => row.id === "p2").pinned)
    store.togglePinProject("p2")
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
