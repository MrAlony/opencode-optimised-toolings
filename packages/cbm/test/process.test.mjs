import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { invokeCbm, runProcess } from "../dist/cbm.js";
import { assessIndexedFreshness, getGitRoot, getProjectRoot, isGitRepo, projectNameFromRoot, recordIndexedFingerprint } from "../dist/state.js";
import { buildToolDefs } from "../dist/tools/index.js";

/**
 * Creates a temporary Git repository for integration tests.
 * Params: None.
 * Returns: string absolute repository path.
 * Side effects: Creates files and initializes a local Git repository.
 * Assumptions: Git is installed and available on PATH.
 */
function createRepo() {
  const repo = mkdtempSync(join(tmpdir(), "oc-cbm-test-"));
  execFileSync("git", ["init", "-q", repo], { timeout: 5_000 });
  writeFileSync(join(repo, ".gitignore"), "ignored/\n");
  writeFileSync(join(repo, "main.c"), "int main(void) { return 0; }\n");
  mkdirSync(join(repo, "ignored"));
  for (let index = 0; index < 200; index += 1) {
    writeFileSync(join(repo, "ignored", `generated-${index}.c`), `int generated_${index}(void) { return ${index}; }\n`);
  }
  return repo;
}

test("runProcess enforces its deadline", async () => {
  const started = Date.now();
  await assert.rejects(
    runProcess(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], 150),
    /timed out after 150ms/,
  );
  assert.ok(Date.now() - started < 5_000, "deadline should return promptly");
});

test("runProcess forwards cancellation deterministically even when child close races termination", async () => {
  const controller = new AbortController();
  const started = Date.now();
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(
    runProcess(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], 30_000, controller.signal),
    /cancelled by OpenCode/,
  );
  assert.ok(Date.now() - started < 5_000, "cancellation should return promptly");
});

test("Git validation canonicalizes nested worktree paths", () => {
  const repo = createRepo();
  try {
    assert.equal(isGitRepo(join(repo, "ignored")), true);
    assert.equal(getGitRoot(join(repo, "ignored")).toLowerCase(), repo.replace(/\\/g, "/").toLowerCase());
    assert.equal(isGitRepo(tmpdir()), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("non-Git project roots are accepted and freshness changes are detected", () => {
  const directory = mkdtempSync(join(tmpdir(), "oc-cbm-non-git-"));
  try {
    writeFileSync(join(directory, "main.ts"), "export const value = 1;\n");
    assert.equal(getProjectRoot(directory).toLowerCase(), directory.replace(/\\/g, "/").toLowerCase());
    assert.equal(isGitRepo(directory), false);
    const recorded = recordIndexedFingerprint(directory);
    assert.equal(recorded.complete, true);
    assert.equal(assessIndexedFreshness(directory).status, "fresh");
    writeFileSync(join(directory, "main.ts"), "export const value = 2;\n");
    assert.equal(assessIndexedFreshness(directory).status, "stale");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Git freshness changes when an already-dirty tracked file changes again", () => {
  const repo = createRepo();
  try {
    execFileSync("git", ["-C", repo, "add", "."], { timeout: 5_000 });
    execFileSync("git", ["-C", repo, "-c", "user.name=CBM Test", "-c", "user.email=cbm@example.invalid", "commit", "-qm", "initial"], { timeout: 5_000 });
    writeFileSync(join(repo, "main.c"), "int main(void) { return 1; }\n");
    recordIndexedFingerprint(repo);
    assert.equal(assessIndexedFreshness(repo).status, "fresh");
    writeFileSync(join(repo, "main.c"), "int main(void) { return 2; }\n");
    assert.equal(assessIndexedFreshness(repo).status, "stale");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("four consolidated high-information CBM tools are registered", () => {
  const tools = buildToolDefs();
  assert.deepEqual(Object.keys(tools).sort(), [
    "cbm_context",
    "cbm_investigate",
    "cbm_memory",
    "cbm_project",
  ]);
  for (const [name, definition] of Object.entries(tools)) {
    assert.equal(typeof definition.execute, "function", `${name} must expose execute`);
    assert.equal(typeof definition.description, "string", `${name} must expose a description`);
  }
});

test("project names preserve canonical path casing expected by the backend", () => {
  const root = process.platform === "win32" ? "C:\\Users\\Example\\Project" : "/Users/Example/Project";
  const expected = process.platform === "win32" ? "C-Users-Example-Project" : "Users-Example-Project";
  const directory = mkdtempSync(join(tmpdir(), "oc-cbm-name-"));
  try {
    const derived = projectNameFromRoot(directory);
    assert.equal(derived, directory.replace(/\\/g, "/").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, ""));
    assert.equal(root.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, ""), expected);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("real CBM fast indexing honors .gitignore and removes its temporary index", { timeout: 30_000 }, async () => {
  const repo = createRepo();
  const project = projectNameFromRoot(repo);
  try {
    const output = await invokeCbm("index_repository", { repo_path: repo, mode: "fast" }, { timeoutMs: 20_000 });
    const result = JSON.parse(output);
    assert.ok(result.excluded?.dirs?.includes("ignored"), `ignored directory was not reported as excluded: ${output}`);
    assert.equal(result.excluded?.count, 2, `expected .git and ignored exclusions: ${output}`);
    assert.ok(result.nodes < 20, `ignored generated sources appear to have been indexed: ${output}`);
  } finally {
    try { await invokeCbm("delete_project", { project }, { timeoutMs: 20_000 }); } catch { /* The test still removes its source fixture if backend cleanup fails. */ }
    rmSync(repo, { recursive: true, force: true });
  }
});
