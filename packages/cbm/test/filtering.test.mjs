import assert from "node:assert/strict";
import test from "node:test";
import { compareIndexedStructure, deriveCodePattern, filterGraphSearch, formatProjectList, repairIndexIfNeeded, validateReadOnlyCypher } from "../dist/consolidated.js";

test("deriveCodePattern extracts concrete symbols instead of using a diagnostic paragraph verbatim", () => {
  const pattern = deriveCodePattern("Trace renderViewport through TemporalJitter and ReflectionCompositeFeature history reset timing", "renderViewport");
  assert.match(pattern, /renderViewport/);
  assert.match(pattern, /TemporalJitter/);
  assert.match(pattern, /ReflectionCompositeFeature/);
  assert.ok(pattern.length < 300);
});

test("filterGraphSearch removes weak semantic trash and unrelated structured results", () => {
  const raw = {
    results: [
      { name: "renderViewport", qualified_name: "project.EditorLayer.renderViewport", label: "Method", file_path: "engine/editor/src/EditorLayer.cpp" },
      { name: "beginDrag", qualified_name: "project.TranslateStrategy.beginDrag", label: "Method", file_path: "engine/editor/src/gizmos/TranslateStrategy.cpp" },
      { name: "dispatch", qualified_name: "project.FidelityFXSssrPass.dispatch", label: "Method", file_path: "engine/renderer/src/fidelityfx/FidelityFXSssrPass.cpp" },
    ],
    semantic_results: [
      { name: "beginDrag", qualified_name: "project.TranslateStrategy.beginDrag", label: "Method", file_path: "engine/editor/src/gizmos/TranslateStrategy.cpp", score: 0.082 },
      { name: "renderFrame", qualified_name: "project.SceneRenderer.renderFrame", label: "Method", file_path: "engine/renderer/src/SceneRenderer.cpp", score: 0.72 },
    ],
  };
  const filtered = filterGraphSearch(raw, "renderViewport TemporalJitter ReflectionCompositeFeature FidelityFXSssrPass dispatch", "renderViewport");
  assert.equal(filtered.structured[0].name, "renderViewport");
  assert.ok(filtered.structured.some((item) => item.name === "dispatch"));
  assert.ok(!filtered.structured.some((item) => item.name === "beginDrag"));
  assert.deepEqual(filtered.semantic.map((item) => item.name), ["renderFrame"]);
  assert.equal(filtered.omittedSemantic, 1);
});

test("project listing separates missing roots without deleting or hiding them", () => {
  const output = formatProjectList(JSON.stringify({ projects: [
    { name: "active", root_path: "C:/active", nodes: 10, edges: 20, git: { root_exists: true } },
    { name: "missing", root_path: "C:/gone", nodes: 5, edges: 4, git: { root_exists: false } },
  ] }));
  assert.match(output, /ACTIVE CBM PROJECTS/);
  assert.match(output, /MISSING-ROOT CBM PROJECTS/);
  assert.match(output, /active=1; missing_root=1; total=2; automatic_deletion=false/);
});

test("Cypher validation rejects write, procedure, admin, and oversized queries while ignoring literals", () => {
  assert.equal(validateReadOnlyCypher("MATCH (n) RETURN n LIMIT 10"), null);
  assert.equal(validateReadOnlyCypher("MATCH (n {text: 'SET is documentation'}) RETURN n LIMIT 1"), null);
  assert.match(validateReadOnlyCypher("MATCH (n) SET n.x = 1 RETURN n"), /write-capable/);
  assert.match(validateReadOnlyCypher("CALL db.labels() YIELD label RETURN label"), /allowed read-only clause|procedure/);
  assert.match(validateReadOnlyCypher(`MATCH (n) RETURN n LIMIT 1 ${" ".repeat(12000)}`), /12000-character/);
});

test("stale and unknown indexes self-repair once and concurrent callers share the refresh", async () => {
  const directory = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(`${process.env.TEMP || process.cwd()}\\oc-cbm-refresh-`));
  let refreshes = 0;
  try {
    const refresh = async () => {
      refreshes += 1;
      await new Promise((resolve) => setTimeout(resolve, 30));
      const { recordIndexedFingerprint } = await import("../dist/state.js");
      recordIndexedFingerprint(directory);
      return "indexed";
    };
    const initial = { status: "unknown", reason: "no baseline" };
    const [first, second] = await Promise.all([
      repairIndexIfNeeded(directory, initial, refresh),
      repairIndexIfNeeded(directory, initial, refresh),
    ]);
    assert.equal(refreshes, 1);
    assert.equal(first.freshness.status, "fresh");
    assert.equal(second.freshness.status, "fresh");
    assert.ok(first.shared !== second.shared);
  } finally {
    await import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true, force: true }));
  }
});

test("source inventory mirrors backend exclusions for legacy tools directories", async () => {
  const { mkdtemp, mkdir, rm, writeFile } = await import("node:fs/promises");
  const directory = await mkdtemp(`${process.env.TEMP || process.cwd()}\\oc-cbm-tools-exclusion-`);
  try {
    await mkdir(`${directory}\\src\\tools`, { recursive: true });
    await writeFile(`${directory}\\src\\active.ts`, "export const active = true;\n");
    await writeFile(`${directory}\\src\\tools\\legacy.ts`, "export const legacy = true;\n");
    const result = compareIndexedStructure(directory, ["src/active.ts"]);
    assert.equal(result.status, "consistent");
    assert.equal(result.currentCount, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Git-aware inventory remains scoped to a requested monorepo subdirectory", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtemp, mkdir, rm, writeFile } = await import("node:fs/promises");
  const directory = await mkdtemp(`${process.env.TEMP || process.cwd()}\\oc-cbm-monorepo-`);
  const packageRoot = `${directory}\\packages\\cbm`;
  try {
    execFileSync("git", ["init", "-q", directory]);
    await mkdir(`${packageRoot}\\src`, { recursive: true });
    await mkdir(`${directory}\\packages\\other`, { recursive: true });
    await writeFile(`${packageRoot}\\src\\active.ts`, "export const active = true;\n");
    await writeFile(`${directory}\\packages\\other\\outside.ts`, "export const outside = true;\n");
    const result = compareIndexedStructure(packageRoot, ["src/active.ts"]);
    assert.equal(result.status, "consistent");
    assert.equal(result.currentCount, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("source inventory excludes local environments, ignored backups, and generated settings", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtemp, mkdir, rm, writeFile } = await import("node:fs/promises");
  const directory = await mkdtemp(`${process.env.TEMP || process.cwd()}\\oc-cbm-ignore-`);
  try {
    execFileSync("git", ["init", "-q", directory]);
    await mkdir(`${directory}\\src`, { recursive: true });
    await mkdir(`${directory}\\packages\\worker\\.venv\\lib`, { recursive: true });
    await mkdir(`${directory}\\config`, { recursive: true });
    await writeFile(`${directory}\\.gitignore`, "**/.venv/\nconfig/backup-*\n**/settings.local.yml\n");
    await writeFile(`${directory}\\src\\active.ts`, "export const active = true;\n");
    await writeFile(`${directory}\\packages\\worker\\.venv\\lib\\generated.py`, "generated = True\n");
    await writeFile(`${directory}\\config\\backup-agents.md`, "ignored backup\n");
    await writeFile(`${directory}\\settings.local.yml`, "secret_key: local\n");
    const result = compareIndexedStructure(directory, ["src/active.ts"]);
    assert.equal(result.status, "consistent");
    assert.equal(result.currentCount, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("structural verification ignores data-only and minified assets but retains implementation files", async () => {
  const { mkdtemp, mkdir, rm, writeFile } = await import("node:fs/promises");
  const directory = await mkdtemp(`${process.env.TEMP || process.cwd()}\\oc-cbm-structural-content-`);
  try {
    await mkdir(`${directory}\\src`, { recursive: true });
    await mkdir(`${directory}\\static`, { recursive: true });
    await writeFile(`${directory}\\src\\implementation.ts`, "export function execute() { return true; }\n");
    await writeFile(`${directory}\\src\\currencies.py`, "CURRENCIES = {\"USD\": \"Dollar\"}\n");
    await writeFile(`${directory}\\static\\bundle.min.js`, "const generated=1;\n");
    const result = compareIndexedStructure(directory, ["src/implementation.ts"]);
    assert.equal(result.status, "consistent");
    assert.equal(result.currentCount, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("structural verification detects missing current and removed indexed files", async () => {
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const directory = await mkdtemp(`${process.env.TEMP || process.cwd()}\\oc-cbm-structure-`);
  try {
    await writeFile(`${directory}\\current.ts`, "export const current = true;\n");
    const result = compareIndexedStructure(directory, ["removed.ts"]);
    assert.equal(result.status, "inconsistent");
    assert.deepEqual(result.missingCurrentFiles, ["current.ts"]);
    assert.deepEqual(result.staleIndexedFiles, ["removed.ts"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fingerprint-fresh but structurally stale index retries twice and fails closed", async () => {
  const directory = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(`${process.env.TEMP || process.cwd()}\\oc-cbm-structural-refresh-`));
  let refreshes = 0;
  try {
    const { recordIndexedFingerprint } = await import("../dist/state.js");
    recordIndexedFingerprint(directory);
    await assert.rejects(
      repairIndexIfNeeded(
        directory,
        { status: "fresh", reason: "fingerprint matches" },
        async () => { refreshes += 1; return "indexed"; },
        async () => ({ status: "inconsistent", reason: "missing current=1", currentCount: 1, indexedCount: 0, missingCurrentFiles: ["src/current.ts"], staleIndexedFiles: [] }),
      ),
      /remained structurally inconsistent.*src\/current\.ts/s,
    );
    assert.equal(refreshes, 2);
  } finally {
    await import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true, force: true }));
  }
});

test("failed index repair rejects without claiming freshness", async () => {
  await assert.rejects(
    repairIndexIfNeeded("C:/missing-cbm-root", { status: "unverifiable", reason: "indexed root no longer exists" }, async () => "should not run"),
    /Cannot refresh index/,
  );
});

test("filterGraphSearch enforces the file pattern after backend search", () => {
  const raw = {
    results: [
      { name: "renderViewport", qualified_name: "project.EditorLayer.renderViewport", file_path: "engine/editor/src/EditorLayer.cpp" },
      { name: "renderFrame", qualified_name: "project.SceneRenderer.renderFrame", file_path: "engine/renderer/src/SceneRenderer.cpp" },
    ],
  };
  const filtered = filterGraphSearch(raw, "renderViewport renderFrame", "renderViewport", "engine/editor/**/*.{cpp,hpp,h}");
  assert.deepEqual(filtered.structured.map((item) => item.name), ["renderViewport"]);
});
