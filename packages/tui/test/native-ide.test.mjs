import test from "node:test"
import assert from "node:assert/strict"
import { compactPath, contextLine, healthTone, projectLabel, sessionSnapshot } from "../lib/native-ide.js"

function apiFixture() {
  return {
    state: {
      path: { directory: "C:/work/alpha" },
      vcs: { branch: "main" },
      session: {
        count: () => 7,
        status: () => ({ type: "busy" }),
        diff: () => [{ file: "src/a.js", additions: 4, deletions: 2 }, { file: "src/b.js", additions: 1, deletions: 0 }],
        todo: () => [{ content: "Implement", status: "in_progress" }, { content: "Verify", status: "completed" }],
      },
      lsp: () => [{ id: "ts", status: "connected" }],
      mcp: () => [{ name: "one", status: "connected" }, { name: "two", status: "failed" }],
    },
  }
}

test("native IDE snapshot derives bounded presentation data without owning state", () => {
  const snapshot = sessionSnapshot(apiFixture(), "ses_1")
  assert.equal(snapshot.project, "alpha")
  assert.equal(snapshot.sessionCount, 7)
  assert.equal(snapshot.changedFiles, 2)
  assert.equal(snapshot.additions, 5)
  assert.equal(snapshot.deletions, 2)
  assert.equal(snapshot.activeTodos, 1)
  assert.equal(snapshot.completedTodos, 1)
  assert.equal(snapshot.mcpFailed, 1)
  assert.equal(healthTone(snapshot), "error")
  assert.equal(contextLine(snapshot), "alpha  ·   main  ·  working")
})

test("native IDE labels are compact and preserve useful path tails", () => {
  assert.equal(projectLabel("C:/work/alpha"), "alpha")
  assert.equal(compactPath("src/a.js", 20), "src/a.js")
  assert.match(compactPath("C:/very/long/project/path/to/important/file.ts", 24), /^…\/.*file\.ts$/)
})
