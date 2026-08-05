import test from "node:test"
import assert from "node:assert/strict"
import {
  compactPath,
  contextLine,
  contextUsage,
  fileKind,
  healthLabel,
  healthTone,
  projectLabel,
  splitPath,
  workspaceMetrics,
  workspaceSnapshot,
} from "../lib/workspace.js"

function apiFixture(overrides = {}) {
  return {
    app: { version: "1.18.13" },
    theme: { selected: "opencode" },
    state: {
      ready: true,
      path: { directory: "C:/work/alpha", worktree: "C:/work/alpha" },
      vcs: { branch: "main", default_branch: "main" },
      provider: [{ id: "anthropic", models: { opus: { limit: { context: 1000 } } } }],
      session: {
        count: () => 7,
        get: () => ({ title: "Rebuild the TUI", cost: 1.25 }),
        status: () => ({ type: "busy" }),
        diff: () => [
          { file: "src/a.js", additions: 4, deletions: 2 },
          { file: "src/b.js", additions: 1, deletions: 0 },
        ],
        todo: () => [
          { content: "Implement", status: "in_progress" },
          { content: "Verify", status: "completed" },
        ],
        permission: () => [{ id: "p1" }],
        question: () => [],
        messages: () => [
          {
            role: "assistant",
            providerID: "anthropic",
            modelID: "opus",
            tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 50, write: 0 } },
          },
        ],
      },
      lsp: () => [{ id: "ts", status: "connected" }],
      mcp: () => [
        { name: "one", status: "connected" },
        { name: "two", status: "failed" },
      ],
    },
    ...overrides,
  }
}

test("snapshot derives complete presentation data without mutating host state", () => {
  const snapshot = workspaceSnapshot(apiFixture(), "ses_1")
  assert.equal(snapshot.project, "alpha")
  assert.equal(snapshot.branch, "main")
  assert.equal(snapshot.sessionCount, 7)
  assert.equal(snapshot.changedFiles, 2)
  assert.equal(snapshot.additions, 5)
  assert.equal(snapshot.deletions, 2)
  assert.equal(snapshot.activeTodos, 1)
  assert.equal(snapshot.completedTodos, 1)
  assert.equal(snapshot.currentTodo.content, "Implement")
  assert.equal(snapshot.permissions, 1)
  assert.equal(snapshot.attention, 1)
  assert.equal(snapshot.mcpFailed, 1)
  assert.equal(snapshot.busy, true)
  assert.equal(snapshot.context.tokens, 200)
  assert.equal(snapshot.context.percent, 20)
  assert.equal(snapshot.context.cost, 1.25)
})

test("snapshot degrades safely before the host state is populated", () => {
  for (const api of [undefined, {}, { state: {} }, { state: { session: {} } }]) {
    const snapshot = workspaceSnapshot(api, "ses_1")
    assert.equal(snapshot.changedFiles, 0)
    assert.equal(snapshot.project, "workspace")
    assert.equal(snapshot.context.tokens, 0)
  }
  const throwing = { state: { session: { diff: () => { throw new Error("not ready") } } } }
  assert.equal(workspaceSnapshot(throwing, "x").changedFiles, 0)
})

test("a home route snapshot reports no session-scoped data", () => {
  const snapshot = workspaceSnapshot(apiFixture(), null)
  assert.equal(snapshot.sessionID, null)
  assert.equal(snapshot.changedFiles, 0)
  assert.equal(snapshot.attention, 0)
  assert.equal(snapshot.sessionCount, 7)
})

test("context usage returns nulls when no assistant message has tokens", () => {
  const api = apiFixture()
  api.state.session.messages = () => [{ role: "user" }]
  const usage = contextUsage(api, "ses_1")
  assert.equal(usage.tokens, 0)
  assert.equal(usage.percent, null)
})

test("health prioritises blocking attention over tooling failures", () => {
  const snapshot = workspaceSnapshot(apiFixture(), "ses_1")
  assert.equal(healthTone(snapshot), "warning")
  assert.equal(healthLabel(snapshot), "needs approval")

  const calm = { ...snapshot, attention: 0, permissions: 0, questions: 0, mcpFailed: 0, busy: false, lspReady: 1, lspTotal: 1, ready: true }
  assert.equal(healthTone(calm), "success")
  assert.equal(healthLabel(calm), "ready")

  assert.equal(healthTone({ ...calm, mcpFailed: 1 }), "error")
  assert.equal(healthTone({ ...calm, busy: true }), "accent")
  assert.equal(healthTone(null), "neutral")
})

test("context line stays compact and omits noise when healthy", () => {
  const snapshot = workspaceSnapshot(apiFixture(), "ses_1")
  const line = contextLine(snapshot)
  assert.match(line, /alpha/)
  assert.match(line, /main/)
  assert.match(line, /±2/)
  assert.equal(contextLine(null), "")
})

test("metrics expose the six workbench counters with tones", () => {
  const metrics = workspaceMetrics(workspaceSnapshot(apiFixture(), "ses_1"))
  assert.deepEqual(metrics.map((metric) => metric.key), ["sessions", "files", "added", "removed", "lsp", "mcp"])
  assert.equal(metrics.find((metric) => metric.key === "mcp").tone, "error")
  assert.deepEqual(workspaceMetrics(null), [])
})

test("path helpers keep meaningful tails and classify file kinds", () => {
  assert.equal(projectLabel("C:/work/alpha"), "alpha")
  assert.equal(projectLabel(""), "workspace")
  assert.equal(compactPath("src/a.js", 20), "src/a.js")
  assert.match(compactPath("C:/very/long/project/path/to/important/file.ts", 24), /^…\/.*file\.ts$/)
  assert.deepEqual(splitPath("src/lib/file.ts", 40), { name: "file.ts", dir: "src/lib" })
  assert.deepEqual(splitPath("file.ts", 40), { name: "file.ts", dir: "" })
  assert.equal(fileKind("a.tsx"), "code")
  assert.equal(fileKind("a.json"), "config")
  assert.equal(fileKind("README.md"), "doc")
  assert.equal(fileKind("a.png"), "asset")
  assert.equal(fileKind("LICENSE"), "file")
})
