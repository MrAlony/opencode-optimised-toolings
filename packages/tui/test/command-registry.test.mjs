import test from "node:test"
import assert from "node:assert/strict"
import { MODES, buildActions, groupActions, parseQuery, workbenchCommands } from "../lib/command-registry.js"

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0)
const DAY = 86_400_000

const SESSIONS = [
  { id: "s1", title: "Rebuild the TUI", projectName: "Alpha", relative: "1h", updated: NOW - 3_600_000 },
  { id: "s2", title: "Fix database migration", projectName: "Beta", relative: "2d", updated: NOW - 2 * DAY },
]
const PROJECTS = [
  { id: "p1", name: "Alpha", worktree: "C:/work/alpha", sessionCount: 4, updated: NOW - 3_600_000 },
  { id: "p2", name: "Beta", worktree: "C:/work/beta", sessionCount: 1, updated: NOW - 2 * DAY },
]
const COMMANDS = [
  { name: "alonix.session.new", title: "New session", category: "Session" },
  { name: "alonix.tab.close", title: "Close tab", category: "Workbench", enabled: false },
]

function actions(query) {
  return buildActions({ query, sessions: SESSIONS, projects: PROJECTS, commands: COMMANDS, now: NOW })
}

test("query prefixes select an explicit search mode", () => {
  assert.deepEqual(parseQuery("tui"), { mode: "all", prefix: "", term: "tui" })
  assert.deepEqual(parseQuery(">new"), { mode: "command", prefix: ">", term: "new" })
  assert.deepEqual(parseQuery("@tui"), { mode: "session", prefix: "@", term: "tui" })
  assert.deepEqual(parseQuery("#alpha"), { mode: "project", prefix: "#", term: "alpha" })
  assert.deepEqual(parseQuery("  "), { mode: "all", prefix: "", term: "" })
  assert.deepEqual(parseQuery(undefined), { mode: "all", prefix: "", term: "" })
  assert.equal(Object.keys(MODES).length, 4)
})

test("each mode restricts results to its own kind", () => {
  assert.ok(actions("@").every((a) => a.kind === "session"))
  assert.ok(actions("#").every((a) => a.kind === "project"))
  assert.ok(actions(">").every((a) => a.kind === "command"))
  const all = actions("")
  assert.ok(new Set(all.map((a) => a.kind)).size > 1, "the default mode spans every kind")
})

test("disabled commands never appear", () => {
  assert.ok(!actions(">").some((a) => a.targetID === "alonix.tab.close"))
})

test("a search term ranks by match quality across kinds", () => {
  const results = actions("tui")
  assert.equal(results[0].targetID, "s1", "the titled match wins")
  assert.ok(!results.some((a) => a.targetID === "s2"), "non-matches are filtered out")
})

test("a strong text match outranks an intrinsically preferred kind", () => {
  // "Beta" matches the project exactly but only weakly matches any session.
  const results = buildActions({ query: "beta", sessions: SESSIONS, projects: PROJECTS, commands: [], now: NOW })
  assert.equal(results[0].kind, "project")
  assert.equal(results[0].targetID, "p2")
})

test("subtitles are searchable but rank below title hits", () => {
  const results = buildActions({
    query: "alpha",
    sessions: [{ id: "s9", title: "Unrelated work", projectName: "Alpha", updated: NOW }],
    projects: [{ id: "p1", name: "Alpha", worktree: "C:/work/alpha", updated: NOW }],
    commands: [],
    now: NOW,
  })
  assert.equal(results[0].kind, "project", "a title match beats a subtitle match")
  assert.ok(results.some((a) => a.targetID === "s9"), "the subtitle match is still reachable")
})

test("with no query the active and running items surface first", () => {
  const results = buildActions({
    query: "",
    sessions: [
      { id: "old", title: "Old", updated: NOW - 30 * DAY },
      { id: "live", title: "Live", updated: NOW - 30 * DAY, running: true },
      { id: "here", title: "Here", updated: NOW - 30 * DAY, active: true },
    ],
    projects: [],
    commands: [],
    now: NOW,
  })
  assert.equal(results[0].targetID, "here")
  assert.equal(results[1].targetID, "live")
})

test("recency boosts ranking and saturates for old items", () => {
  const results = buildActions({
    query: "",
    sessions: [
      { id: "ancient", title: "Ancient", updated: NOW - 400 * DAY },
      { id: "fresh", title: "Fresh", updated: NOW },
    ],
    projects: [],
    commands: [],
    now: NOW,
  })
  assert.equal(results[0].targetID, "fresh")
})

test("results carry quick-jump slots for the first nine rows", () => {
  const results = actions("")
  assert.equal(results[0].slot, 1)
  assert.ok(results.slice(0, 9).every((a, i) => a.slot === i + 1))
})

test("grouping preserves relevance order within each kind", () => {
  const groups = groupActions(actions(""))
  assert.deepEqual(groups.map((g) => g.kind), ["session", "project", "command"])
  assert.ok(groups.every((g) => g.rows.length > 0), "empty groups are omitted")
  assert.deepEqual(groupActions([]), [])
})

test("the workbench command set reflects the current context", () => {
  const empty = workbenchCommands({ tabCount: 0 })
  assert.equal(empty.find((c) => c.name === "alonix.tab.close").enabled, false)
  assert.equal(empty.find((c) => c.name === "alonix.tab.closeOthers").enabled, false)

  const busy = workbenchCommands({ tabCount: 3, activeSessionID: "s1" })
  assert.equal(busy.find((c) => c.name === "alonix.tab.close").enabled, true)
  assert.equal(busy.find((c) => c.name === "alonix.tab.closeOthers").enabled, true)
  assert.equal(busy.find((c) => c.name === "alonix.session.open").enabled, true)
  assert.ok(busy.every((c) => c.name && c.title && c.category), "every command is fully described")
})

test("commands dispatch through the injected controller", () => {
  const calls = []
  const api = { newSession: () => calls.push("new"), closeActiveTab: () => calls.push("close") }
  const commands = workbenchCommands({ tabCount: 1 })
  commands.find((c) => c.name === "alonix.session.new").run(api)
  commands.find((c) => c.name === "alonix.tab.close").run(api)
  assert.deepEqual(calls, ["new", "close"])
  // A controller missing a handler must not throw.
  assert.doesNotThrow(() => commands.find((c) => c.name === "alonix.project.refresh").run({}))
})

test("malformed input never throws", () => {
  for (const input of [undefined, {}, { sessions: null, projects: null, commands: null }]) {
    assert.doesNotThrow(() => buildActions(input))
  }
})
