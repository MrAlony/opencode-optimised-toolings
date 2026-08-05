import test from "node:test"
import assert from "node:assert/strict"
import {
  buildProjectModel,
  containsDirectory,
  flattenProjectSessions,
  projectForSession,
  projectLabel,
  recentProjects,
  summarizeProjects,
} from "../lib/projects.js"

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0)
const HOUR = 3_600_000
const DAY = 24 * HOUR

const PROJECTS = [
  { id: "p_alpha", worktree: "C:/work/alpha", name: "Alpha" },
  { id: "p_beta", worktree: "C:/work/beta" },
]

function session(id, overrides = {}) {
  return {
    id,
    title: `Session ${id}`,
    projectID: "p_alpha",
    directory: "C:/work/alpha",
    time: { updated: NOW - HOUR },
    ...overrides,
  }
}

test("project labels prefer an explicit name and fall back to the directory", () => {
  assert.equal(projectLabel(PROJECTS[0]), "Alpha")
  assert.equal(projectLabel(PROJECTS[1]), "beta")
  assert.equal(projectLabel({ worktree: "C:/work/gamma/" }), "gamma")
  assert.equal(projectLabel({}), "project")
})

test("directory containment handles nesting, separators, and non-matches", () => {
  assert.equal(containsDirectory("C:/work/alpha", "C:/work/alpha"), true)
  assert.equal(containsDirectory("C:/work/alpha", "C:/work/alpha/src/deep"), true)
  assert.equal(containsDirectory("C:/work/alpha", "C:/work/alphabet"), false, "prefix must not imply containment")
  assert.equal(containsDirectory("C:/work/alpha", "C:/work/beta"), false)
  assert.equal(containsDirectory("", "C:/work"), false)
  // Backslashes and trailing separators normalize.
  assert.equal(containsDirectory("C:\\work\\alpha\\", "C:/work/alpha/src"), true)
})

test("sessions attribute by id first, then by the most specific directory", () => {
  assert.equal(projectForSession(session("a"), PROJECTS).id, "p_alpha")
  // No projectID: fall back to containment.
  const orphan = session("b", { projectID: undefined, directory: "C:/work/beta/pkg" })
  assert.equal(projectForSession(orphan, PROJECTS).id, "p_beta")
  // Nested projects: the longest matching worktree wins.
  const nested = [...PROJECTS, { id: "p_nested", worktree: "C:/work/alpha/packages/inner" }]
  const deep = session("c", { projectID: undefined, directory: "C:/work/alpha/packages/inner/src" })
  assert.equal(projectForSession(deep, nested).id, "p_nested")
  assert.equal(projectForSession(session("d", { projectID: undefined, directory: "D:/other" }), PROJECTS), null)
})

test("the model groups sessions under projects and keeps empty projects openable", () => {
  const rows = buildProjectModel({
    now: NOW,
    projects: PROJECTS,
    sessions: [session("a"), session("b", { projectID: "p_beta", directory: "C:/work/beta" })],
  })
  assert.equal(rows.length, 2)
  const alpha = rows.find((row) => row.id === "p_alpha")
  assert.equal(alpha.sessionCount, 1)
  assert.equal(alpha.known, true)

  // A project with no sessions still appears.
  const empty = buildProjectModel({ now: NOW, projects: PROJECTS, sessions: [] })
  assert.equal(empty.length, 2)
  assert.equal(empty[0].sessionCount, 0)
})

test("sessions from unknown projects are retained, never dropped", () => {
  const rows = buildProjectModel({
    now: NOW,
    projects: PROJECTS,
    sessions: [session("x", { projectID: "p_ghost", directory: "D:/elsewhere/ghost" })],
  })
  const ghost = rows.find((row) => row.worktree === "D:/elsewhere/ghost")
  assert.ok(ghost, "an unattributable session must still be reachable")
  assert.equal(ghost.known, false)
  assert.equal(ghost.sessionCount, 1)
})

test("child sessions never appear in the project model", () => {
  const rows = buildProjectModel({
    now: NOW,
    projects: PROJECTS,
    sessions: [session("a"), session("kid", { parentID: "a" })],
  })
  assert.equal(rows.find((row) => row.id === "p_alpha").sessionCount, 1)
})

test("ordering puts the current project first, then pinned, running, and recency", () => {
  const rows = buildProjectModel({
    now: NOW,
    activeDirectory: "C:/work/beta/src",
    pinnedProjects: ["p_gamma"],
    statuses: { d: { type: "busy" } },
    projects: [...PROJECTS, { id: "p_gamma", worktree: "C:/work/gamma" }, { id: "p_delta", worktree: "C:/work/delta" }],
    sessions: [
      session("a", { time: { updated: NOW } }),
      session("b", { projectID: "p_beta", directory: "C:/work/beta", time: { updated: NOW - 5 * DAY } }),
      session("c", { projectID: "p_gamma", directory: "C:/work/gamma", time: { updated: NOW - 6 * DAY } }),
      session("d", { projectID: "p_delta", directory: "C:/work/delta", time: { updated: NOW - 7 * DAY } }),
    ],
  })
  assert.deepEqual(rows.map((row) => row.id), ["p_beta", "p_gamma", "p_delta", "p_alpha"])
  assert.equal(rows[0].current, true)
  assert.equal(rows[1].pinned, true)
  assert.equal(rows[2].running, 1)
})

test("within a project the active session leads, then running, then recency", () => {
  const rows = buildProjectModel({
    now: NOW,
    projects: PROJECTS,
    activeSessionID: "c",
    statuses: { b: { type: "busy" } },
    sessions: [
      session("a", { time: { updated: NOW } }),
      session("b", { time: { updated: NOW - 3 * DAY } }),
      session("c", { time: { updated: NOW - 9 * DAY } }),
    ],
  })
  assert.deepEqual(rows.find((row) => row.id === "p_alpha").sessions.map((s) => s.id), ["c", "b", "a"])
})

test("aggregates and flattening expose portfolio-wide totals", () => {
  const rows = buildProjectModel({
    now: NOW,
    projects: PROJECTS,
    statuses: { a: { type: "busy" } },
    sessions: [
      session("a", { summary: { files: 3, additions: 10, deletions: 2 } }),
      session("b", { projectID: "p_beta", directory: "C:/work/beta" }),
    ],
  })
  const summary = summarizeProjects(rows)
  assert.equal(summary.projects, 2)
  assert.equal(summary.sessions, 2)
  assert.equal(summary.running, 1)
  assert.equal(summary.changedFiles, 3)
  assert.equal(summary.withWork, 1)

  const flat = flattenProjectSessions(rows)
  assert.equal(flat.length, 2)
  assert.ok(flat.every((item) => item.projectID && item.projectName))
})

test("recent projects are ordered by activity and bounded", () => {
  const rows = buildProjectModel({
    now: NOW,
    projects: PROJECTS,
    sessions: [
      session("a", { time: { updated: NOW - 5 * DAY } }),
      session("b", { projectID: "p_beta", directory: "C:/work/beta", time: { updated: NOW } }),
    ],
  })
  assert.deepEqual(recentProjects(rows).map((row) => row.id), ["p_beta", "p_alpha"])
  assert.equal(recentProjects(rows, 1).length, 1)
})

test("malformed input never throws", () => {
  for (const input of [undefined, {}, { projects: null, sessions: null }, { projects: [null], sessions: [null, {}] }]) {
    assert.doesNotThrow(() => buildProjectModel(input))
  }
  assert.deepEqual(summarizeProjects(null), { projects: 0, sessions: 0, running: 0, changedFiles: 0, withWork: 0 })
  assert.deepEqual(flattenProjectSessions(null), [])
})
