import test from "node:test"
import assert from "node:assert/strict"
import {
  buildSessionModel,
  flattenGroups,
  fuzzyMatch,
  groupSessions,
  isDefaultTitle,
  normalizePins,
  relativeTime,
  sessionTitle,
  summarizeSessions,
  timeBucket,
  togglePin,
} from "../lib/sessions.js"

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0)
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

function session(id, overrides = {}) {
  return {
    id,
    title: `Session ${id}`,
    time: { updated: NOW - MINUTE },
    parentID: undefined,
    ...overrides,
  }
}

test("default OpenCode titles are recognised and replaced", () => {
  assert.ok(isDefaultTitle("New session - 2026-01-15T10:00:00.000Z"))
  assert.ok(isDefaultTitle("Child session - 2026-01-15T10:00:00.000Z"))
  assert.ok(!isDefaultTitle("Rebuild the TUI"))
  assert.equal(sessionTitle({ title: "New session - 2026-01-15T10:00:00.000Z" }), "Untitled session")
  assert.equal(sessionTitle({ title: "  Rebuild the TUI  " }), "Rebuild the TUI")
  assert.equal(sessionTitle({}), "Untitled session")
})

test("relative time is compact across every scale", () => {
  assert.equal(relativeTime(NOW, NOW), "now")
  assert.equal(relativeTime(NOW - 5 * MINUTE, NOW), "5m")
  assert.equal(relativeTime(NOW - 3 * HOUR, NOW), "3h")
  assert.equal(relativeTime(NOW - 2 * DAY, NOW), "2d")
  assert.equal(relativeTime(NOW - 14 * DAY, NOW), "2w")
  assert.equal(relativeTime(0, NOW), "")
})

test("time buckets group by calendar day, not fixed offsets", () => {
  assert.equal(timeBucket(NOW, NOW), "Today")
  assert.equal(timeBucket(NOW - 1 * DAY, NOW), "Yesterday")
  assert.equal(timeBucket(NOW - 4 * DAY, NOW), "This week")
  assert.equal(timeBucket(NOW - 20 * DAY, NOW), "This month")
  assert.equal(timeBucket(NOW - 200 * DAY, NOW), "Earlier")
})

test("fuzzy matching prefers exact and word-boundary hits", () => {
  assert.equal(fuzzyMatch("anything", "").score, 0)
  assert.equal(fuzzyMatch("Rebuild the TUI", "zzz"), null)
  const exact = fuzzyMatch("Rebuild the TUI", "tui")
  const scattered = fuzzyMatch("Refactor unit indexer", "tui")
  assert.ok(exact.score > scattered.score)
  assert.deepEqual(fuzzyMatch("abc", "abc").positions, [0, 1, 2])
})

test("ranking puts the active session first, then pins, then running, then recency", () => {
  const rows = buildSessionModel({
    now: NOW,
    activeID: "c",
    pinned: ["b"],
    statuses: { d: { type: "busy" } },
    sessions: [
      session("a", { time: { updated: NOW - MINUTE } }),
      session("b", { time: { updated: NOW - 10 * DAY } }),
      session("c", { time: { updated: NOW - 5 * DAY } }),
      session("d", { time: { updated: NOW - 3 * DAY } }),
    ],
  })
  assert.deepEqual(rows.map((row) => row.id), ["c", "b", "d", "a"])
  assert.equal(rows[0].active, true)
  assert.equal(rows[1].pinned, true)
  assert.equal(rows[2].running, true)
  assert.deepEqual(rows.map((row) => row.slot), [1, 2, 3, 4])
})

test("child sessions never appear in the switcher", () => {
  const rows = buildSessionModel({
    now: NOW,
    sessions: [session("a"), session("child", { parentID: "a" })],
  })
  assert.deepEqual(rows.map((row) => row.id), ["a"])
})

test("a query re-ranks by relevance and filters non-matches", () => {
  const rows = buildSessionModel({
    now: NOW,
    query: "tui",
    sessions: [
      session("a", { title: "Fix the database", time: { updated: NOW } }),
      session("b", { title: "Rebuild the TUI", time: { updated: NOW - 5 * DAY } }),
    ],
  })
  assert.deepEqual(rows.map((row) => row.id), ["b"])
})

test("rows carry diff totals for preview and badges", () => {
  const rows = buildSessionModel({
    now: NOW,
    sessions: [session("a")],
    diffs: { a: [{ file: "x.ts", additions: 4, deletions: 1 }, { file: "y.ts", additions: 2, deletions: 0 }] },
  })
  assert.equal(rows[0].changedFiles, 2)
  assert.equal(rows[0].additions, 6)
  assert.equal(rows[0].deletions, 1)
})

test("grouping is calendar-based while browsing and flat while searching", () => {
  const rows = buildSessionModel({
    now: NOW,
    activeID: "a",
    pinned: ["b"],
    statuses: { c: { type: "busy" } },
    sessions: [session("a"), session("b"), session("c"), session("d", { time: { updated: NOW - 40 * DAY } })],
  })
  const groups = groupSessions(rows, "")
  assert.deepEqual(groups.map((group) => group.label), ["Current", "Pinned", "Working", "Earlier"])
  assert.equal(flattenGroups(groups).length, 4)

  const searched = groupSessions(rows, "session")
  assert.deepEqual(searched.map((group) => group.label), ["Best matches"])
  assert.equal(groupSessions([], "q").length, 0)
})

test("summary counts running, pinned, and touched sessions", () => {
  const rows = buildSessionModel({
    now: NOW,
    pinned: ["b"],
    statuses: { a: { type: "busy" } },
    diffs: { c: [{ file: "z.ts", additions: 1, deletions: 0 }] },
    sessions: [session("a"), session("b"), session("c")],
  })
  const summary = summarizeSessions(rows)
  assert.deepEqual(summary, { total: 3, running: 1, pinned: 1, touched: 1 })
})

test("pins are de-duplicated, bounded, and toggle correctly", () => {
  assert.deepEqual(normalizePins(["a", "a", "b", 5, null]), ["a", "b"])
  assert.deepEqual(normalizePins("nonsense"), [])
  assert.equal(normalizePins(Array.from({ length: 100 }, (_, i) => `s${i}`)).length, 24)
  assert.deepEqual(togglePin(["a"], "b"), ["b", "a"])
  assert.deepEqual(togglePin(["a", "b"], "a"), ["b"])
  assert.deepEqual(togglePin(["a"], ""), ["a"])
})

test("malformed session records never crash the model", () => {
  const rows = buildSessionModel({
    now: NOW,
    sessions: [null, undefined, {}, { id: 42 }, session("ok")],
  })
  assert.deepEqual(rows.map((row) => row.id), ["ok"])
})
