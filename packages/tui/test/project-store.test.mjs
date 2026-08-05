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
  const calls = { projectList: 0, sessionList: 0, sessionCreate: [] }
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
        create: async (args) => {
          calls.sessionCreate.push(args)
          return { data: { id: "new1", title: "New", directory: args?.query?.directory ?? "C:/work/alpha" } }
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
    assert.equal(api.calls.sessionList, 1)
    assert.equal(store.projects.length, 2)
    assert.equal(store.sessions.length, 2)
    assert.ok(store.loadedAt > 0)

    // The derived model spans both projects.
    const rows = store.projectRows()
    assert.equal(rows.length, 2)
    assert.equal(store.summary().sessions, 2)
  })
})

test("session listing is not scoped to a single project", async () => {
  const api = createApi()
  let seen
  api.client.session.list = async (args) => {
    seen = args
    return { data: SESSIONS }
  }
  await withStore(api, () => {
    assert.ok(seen, "session.list must be called")
    assert.equal(seen.scope, undefined, "scope must stay unset so results span projects")
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
    const before = api.calls.sessionList
    let release
    api.client.session.list = async () => {
      api.calls.sessionList += 1
      await new Promise((resolve) => {
        release = resolve
      })
      return { data: SESSIONS }
    }
    const first = store.reload()
    const second = store.reload()
    const third = store.reload()
    release()
    await Promise.all([first, second, third])
    // One in-flight call plus at most one queued follow-up, never three.
    assert.ok(api.calls.sessionList - before <= 2, "overlapping refreshes must not stampede the server")
  })
})

test("session events trigger a debounced refresh", async () => {
  const api = createApi()
  await withStore(api, async (store) => {
    const before = api.calls.sessionList
    const handler = api.listeners.get("session.updated")
    assert.ok(handler, "the store must subscribe to session.updated")
    handler()
    handler()
    handler()
    await new Promise((resolve) => setTimeout(resolve, 220))
    assert.equal(api.calls.sessionList, before + 1, "a burst of events collapses into one reload")
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
  const before = api.calls.sessionList
  dispose()
  handler?.()
  await new Promise((resolve) => setTimeout(resolve, 220))
  assert.equal(api.calls.sessionList, before, "a disposed store must not keep polling")
  assert.equal(api.listeners.size, 0, "every listener must be removed")
  void store
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

test("creating a session targets an explicit project directory", async () => {
  const api = createApi()
  await withStore(api, async (store) => {
    const created = await store.createSession({ directory: "C:/work/beta" })
    assert.equal(created.id, "new1")
    const args = api.calls.sessionCreate.at(-1)
    assert.equal(args.query.directory, "C:/work/beta", "cross-project creation requires the directory query")
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
