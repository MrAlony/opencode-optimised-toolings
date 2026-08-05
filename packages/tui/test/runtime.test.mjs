// Runtime reactivity tests.
//
// Node resolves `solid-js` to its SSR build, where signals and stores never
// update, so these tests register a resolver that pins the real client builds
// for the entire module graph before any Solid code is imported.
import test from "node:test"
import assert from "node:assert/strict"
import { register } from "node:module"

register("./solid-client-loader.mjs", import.meta.url)

const { createRoot, createSignal } = await import("solid-js")
const { activeSessionID, createClock, createSessionStore, createSkin, openSession } = await import(
  "./runtime-harness.mjs"
)

// Guard: if resolution ever regresses to the SSR build these tests would pass
// vacuously, so prove reactivity works before asserting anything else.
test("the test environment provides genuinely reactive Solid primitives", () => {
  createRoot((dispose) => {
    const [value, setValue] = createSignal(1)
    assert.equal(value(), 1)
    setValue(2)
    assert.equal(value(), 2, "SSR Solid detected: reactive assertions would be meaningless")
    dispose()
  })
})

function tick(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function themeApi() {
  const [theme, setTheme] = createSignal({ background: "#0b0d12", text: "#e6e9f0", primary: "#6d8cff" })
  return {
    api: {
      theme: {
        get current() {
          return theme()
        },
      },
    },
    setTheme,
  }
}

test("design tokens recompute when the host theme changes", () => {
  createRoot((dispose) => {
    const { api, setTheme } = themeApi()
    const tokens = createSkin(api)
    assert.equal(tokens().mode, "dark")
    const darkText = tokens().text

    setTheme({ background: "#fdfdff", text: "#11141c", primary: "#2f6bff" })
    assert.equal(tokens().mode, "light")
    assert.notEqual(tokens().text, darkText)
    dispose()
  })
})

test("a broken theme accessor never breaks token derivation", () => {
  createRoot((dispose) => {
    const tokens = createSkin({
      theme: {
        get current() {
          throw new Error("theme not ready")
        },
      },
    })
    assert.match(tokens().canvas, /^#[0-9a-f]{6}$/)
    dispose()
  })
})

test("motion can be disabled at the token level", () => {
  createRoot((dispose) => {
    const { api } = themeApi()
    assert.equal(createSkin(api, { motion: false })().motion, false)
    assert.equal(createSkin(api, { motion: true })().motion, true)
    dispose()
  })
})

test("the clock stays idle until a surface subscribes and stops on dispose", async () => {
  await createRoot(async (dispose) => {
    const clock = createClock(true)
    await tick(120)
    assert.equal(clock.elapsed(), 0, "no subscribers means no ticking")

    createRoot((inner) => {
      clock.subscribe()
      return inner
    })
    await tick(220)
    assert.ok(clock.elapsed() > 0, "a subscriber starts the shared clock")
    dispose()
  })
})

test("a disabled clock never ticks even with subscribers", async () => {
  await createRoot(async (dispose) => {
    const clock = createClock(false)
    clock.subscribe()
    await tick(200)
    assert.equal(clock.elapsed(), 0)
    assert.equal(clock.enabled(), false)
    dispose()
  })
})

function storeApi(overrides = {}) {
  const handlers = new Map()
  const calls = { list: 0 }
  return {
    handlers,
    calls,
    api: {
      kv: { get: (_key, fallback) => fallback, set() {} },
      event: {
        on(name, handler) {
          handlers.set(name, handler)
          return () => handlers.delete(name)
        },
      },
      client: {
        session: {
          async list() {
            calls.list += 1
            return { data: [{ id: "a", title: "Alpha", time: { updated: Date.now() } }] }
          },
        },
      },
      state: { session: { status: () => undefined, diff: () => [] } },
      ...overrides,
    },
  }
}

test("the session store loads once and exposes a ranked model", async () => {
  await createRoot(async (dispose) => {
    const { api, calls } = storeApi()
    const store = createSessionStore(api)
    await tick(50)
    assert.equal(calls.list, 1)
    assert.equal(store.sessions.length, 1)
    const model = store.model(null, "")
    assert.equal(model[0].id, "a")
    assert.equal(model[0].title, "Alpha")
    dispose()
  })
})

test("host session events trigger a debounced single refresh", async () => {
  await createRoot(async (dispose) => {
    const { api, handlers, calls } = storeApi()
    createSessionStore(api)
    await tick(50)
    assert.equal(calls.list, 1)

    handlers.get("session.updated")?.()
    handlers.get("session.updated")?.()
    handlers.get("session.deleted")?.()
    await tick(250)
    assert.equal(calls.list, 2, "bursts must collapse into one refresh")
    dispose()
  })
})

test("a failed listing preserves the last good sessions", async () => {
  await createRoot(async (dispose) => {
    let shouldFail = false
    const { api, handlers } = storeApi()
    api.client.session.list = async () => {
      if (shouldFail) throw new Error("backend down")
      return { data: [{ id: "a", title: "Alpha", time: { updated: Date.now() } }] }
    }
    const store = createSessionStore(api)
    await tick(50)
    assert.equal(store.sessions.length, 1)

    shouldFail = true
    handlers.get("session.updated")?.()
    await tick(250)
    assert.equal(store.sessions.length, 1, "the previous list must survive a failure")
    assert.match(store.error, /backend down/)
    dispose()
  })
})

test("the store survives a host with no client or event bus", async () => {
  await createRoot(async (dispose) => {
    const store = createSessionStore({})
    await tick(50)
    assert.deepEqual(store.sessions, [])
    assert.deepEqual(store.model(null, ""), [])
    dispose()
  })
})

test("pins persist through KV and toggle idempotently", async () => {
  await createRoot(async (dispose) => {
    const saved = {}
    const { api } = storeApi()
    api.kv = { get: (_key, fallback) => fallback, set: (key, value) => { saved[key] = value } }
    const store = createSessionStore(api)
    await tick(50)

    store.togglePin("a")
    assert.deepEqual(store.pinned, ["a"])
    assert.deepEqual(saved.alonix_ide_pinned_sessions, ["a"])
    assert.equal(store.model(null, "")[0].pinned, true)

    store.togglePin("a")
    assert.deepEqual(store.pinned, [])
    dispose()
  })
})

test("route helpers read the active session and delegate navigation", () => {
  assert.equal(activeSessionID({ route: { current: { name: "home" } } }), null)
  assert.equal(activeSessionID({ route: { current: { name: "session", params: { sessionID: "x" } } } }), "x")
  assert.equal(activeSessionID({}), null)
  assert.equal(
    activeSessionID({
      route: {
        get current() {
          throw new Error("not ready")
        },
      },
    }),
    null,
  )

  const calls = []
  const api = {
    route: { navigate: (name, params) => calls.push([name, params]) },
    ui: { dialog: { clear: () => calls.push(["clear"]) } },
  }
  assert.equal(openSession(api, "ses_1"), true)
  assert.deepEqual(calls[0], ["session", { sessionID: "ses_1" }])
  assert.deepEqual(calls[1], ["clear"])
  assert.equal(openSession(api, ""), false)
  assert.equal(openSession({}, "ses_1"), false)
})
