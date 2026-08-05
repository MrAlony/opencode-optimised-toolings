import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import pluginFactory from "../index.js";

const root = resolve(new URL("..", import.meta.url).pathname.replace(/^\/(.:)/, "$1"));
const fixture = mkdtempSync(join(tmpdir(), "opencode-tools-live-"));
const plugin = await pluginFactory({});
const results = [];
let cbmProject = "";
const context = (sessionID) => ({ sessionID, directory: root, abort: new AbortController().signal });
const projectNameFromPath = (value) => resolve(value).replace(/\\/g, "/").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");

function summary(text) { return String(text).replace(/\r/g, "").split("\n").filter(Boolean).slice(0, 5).join(" | ").slice(0, 800); }
async function check(name, execute, accept) {
  const started = Date.now();
  try {
    const output = await execute();
    const passed = accept(output);
    results.push({ name, passed, durationMs: Date.now() - started, evidence: summary(output) });
    if (!passed) console.error(`LIVE TOOL FAILED: ${name}\n${output}`);
    return output;
  } catch (error) {
    results.push({ name, passed: false, durationMs: Date.now() - started, evidence: error?.stack || String(error) });
    return "";
  }
}

try {
  const editOutput = await check("alonix-edit-many", () => plugin.tool["alonix-edit-many"].execute({
    base_dir: fixture,
    actions: [
      { path: "alpha.txt", operation: "create", content: "alpha one\n" },
      { path: "alpha.txt", operation: "patch", replacements: [{ search: "one", replace: "two", expected_count: 1, allow_already_applied: false }] },
      { path: "nested/beta.txt", operation: "create", content: "beta searchable\n" },
      { path: "live-cbm.js", operation: "create", content: "export function deriveLiveValue(input) { return input * 2; }\nexport function useLiveValue() { return deriveLiveValue(21); }\n" },
    ],
  }, context("live-fs-edit")), (output) => /EDIT RESULT: SUCCESS/.test(output) && /APPLIED \(3\)/.test(output));
  if (!editOutput) throw new Error("filesystem fixture creation failed");

  await check("alonix-read-many", () => plugin.tool["alonix-read-many"].execute({
    base_dir: fixture,
    paths: ["alpha.txt", "nested/beta.txt"],
    requests: [{ path: "alpha.txt", ranges: [{ start_line: 1, end_line: 1 }] }],
  }, context("live-fs-read")), (output) => /READ RESULT: SUCCESS/.test(output) && /alpha two/.test(output) && /beta searchable/.test(output));

  await check("alonix-search", () => plugin.tool["alonix-search"].execute({
    base_dir: fixture,
    file_pattern: "**/*.txt",
    query: "searchable",
  }, context("live-fs-search")), (output) => /SEARCH RESULT: SUCCESS/.test(output) && /beta\.txt/.test(output) && /searchable/.test(output));

  await check("alonix-explore", () => plugin.tool["alonix-explore"].execute({
    base_dir: fixture,
    query: "searchable",
    file_pattern: "**/*.txt",
  }, context("live-fs-explore")), (output) => /EXPLORE RESULT: SUCCESS|EXPLORE RESULT: PARTIAL SUCCESS/.test(output) && /beta\.txt/.test(output));

  await check("shell", () => plugin.tool.shell.execute({
    commands: [
      { command: `& ${JSON.stringify(process.execPath)} -e \"console.log('shell-live-ok')\"`, cwd: root, timeout_ms: 10_000, label: "live shell" },
      { command: `& ${JSON.stringify(process.execPath)} -e \"console.log(6*7)\"`, cwd: root, timeout_ms: 10_000, label: "parallel arithmetic" },
    ],
    mode: "parallel",
    stop_on_error: true,
    max_concurrency: 2,
  }, context("live-shell")), (output) => /TERMINAL RESULT: SUCCESS/.test(output) && /shell-live-ok/.test(output) && /42/.test(output));

  const backgroundStart = await check("alonix-background-process", () => plugin.tool["alonix-background-process"].execute({
    operations: [{ action: "start", command: `& ${JSON.stringify(process.execPath)} -e \"console.log('background-live-ok');setInterval(()=>{},1000)\"`, cwd: root, label: "live background", ready_output: "background-live-ok", startup_timeout_ms: 5_000 }],
  }, context("live-background")), (output) => /PROCESS READY/.test(output) && /captured output contains "background-live-ok"/.test(output) && /ID: bgp_/.test(output));
  const backgroundId = /ID: (bgp_[A-Za-z0-9]+)/.exec(backgroundStart)?.[1];
  if (backgroundId) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 600));
    const lifecycle = await plugin.tool["alonix-background-process"].execute({ operations: [{ action: "status", id: backgroundId }, { action: "logs", id: backgroundId }, { action: "stop", id: backgroundId }, { action: "cleanup" }] }, context("live-background-lifecycle"));
    const record = results.find((item) => item.name === "alonix-background-process");
    record.evidence += ` | ${summary(lifecycle)}`;
    record.passed &&= /PROCESS STATUS/.test(lifecycle) && /background-live-ok/.test(lifecycle) && /termination confirmed|already exited/.test(lifecycle);
  } else results.find((item) => item.name === "alonix-background-process").passed = false;

  cbmProject = projectNameFromPath(fixture);
  await check("alonix-index-project", async () => {
    const indexed = await plugin.tool["alonix-index-project"].execute({ action: "index", project: "", repo_path: fixture, mode: "fast", user_authorized: true }, context("live-cbm-project-index"));
    const status = await plugin.tool["alonix-index-project"].execute({ action: "status", project: cbmProject, repo_path: "", mode: "fast" }, context("live-cbm-project-status"));
    return `${indexed}\n\n${status}`;
  }, (output) => /INDEX READINESS/.test(output) && /CBM INDEX RESULT/.test(output) && /CBM INDEX STATUS/.test(output) && !/INDEX REFRESH FAILED/.test(output));
  await check("alonix-index-context", () => plugin.tool["alonix-index-context"].execute({ project: cbmProject }, context("live-cbm-context")), (output) => /INDEX READINESS/.test(output) && /ARCHITECTURE/.test(output) && !/^CBM CONTEXT FAILED/m.test(output));
  await check("alonix-index-investigate", () => plugin.tool["alonix-index-investigate"].execute({
    project: cbmProject,
    query: "trace deriveLiveValue into useLiveValue and return the exact source",
    function_name: "deriveLiveValue",
    label: "Function",
    file_pattern: "**/live-cbm.js",
    cypher: "MATCH (f:Function) WHERE f.name = 'deriveLiveValue' RETURN f.name AS name, f.file_path AS file_path LIMIT 5",
  }, context("live-cbm-investigate")), (output) => /INDEX READINESS/.test(output) && /deriveLiveValue/.test(output) && !/^CBM INVESTIGATION FAILED/m.test(output));
  await check("alonix-index-memory", () => plugin.tool["alonix-index-memory"].execute({
    action: "adr_list", project: cbmProject, id: "", title: "", status: "proposed", context: "", decision: "", consequences: "", traces: [],
  }, context("live-cbm-memory")), (output) => /INDEX READINESS/.test(output) && /ADR RESULT/.test(output) && !/^CBM MEMORY OPERATION FAILED/m.test(output));

  await check("alonix-web-fetch-many", () => plugin.tool["alonix-web-fetch-many"].execute({
    requests: [{ url: "https://example.com", format: "markdown", extract: "main", timeout_ms: 15_000, retries: 1, allow_private: false }],
    max_concurrency: 1, cache_ttl_seconds: 0, output_budget_bytes: 16_384,
  }, context("live-web-fetch")), (output) => /WEB FETCH RESULT: SUCCESS/.test(output) && /Example Domain/.test(output));
  await check("alonix-web-search", () => plugin.tool["alonix-web-search"].execute({
    queries: [{ query: "OpenCode official documentation", max_results: 3, backend: "duckduckgo" }],
    strategy: "fallback", backends: ["duckduckgo"], max_concurrency: 1, cache_ttl_seconds: 0,
  }, context("live-web-search")), (output) => /WEB SEARCH RESULT: SUCCESS/.test(output) && /opencode\.ai/.test(output));

  await check("alonix-stealth-status", () => plugin.tool["alonix-stealth-status"].execute({}, context("live-stealth-status")), (output) => /STEALTH STATUS: READY/.test(output) && /Python worker: running/.test(output));
  await check("alonix-stealth-fetch-many", () => plugin.tool["alonix-stealth-fetch-many"].execute({
    requests: [{ url: "https://example.com", render_js: true, format: "markdown", timeout_ms: 30_000, allow_private: false }], max_concurrency: 1, output_budget_bytes: 8192,
  }, context("live-stealth-fetch")), (output) => /STEALTH FETCH RESULT: SUCCESS/.test(output) && /control authentication=cookie/.test(output) && /Example Domain/.test(output));
  await check("alonix-stealth-search-many", () => plugin.tool["alonix-stealth-search-many"].execute({
    queries: [{ query: "OpenCode official documentation", max_results: 3 }], max_concurrency: 1, output_budget_bytes: 16_384,
  }, context("live-stealth-search")), (output) => /STEALTH SEARCH RESULT: SUCCESS/.test(output) && /https?:\/\//.test(output));
  await check("alonix-stealth-rotate-tor", () => plugin.tool["alonix-stealth-rotate-tor"].execute({}, context("live-stealth-rotate")), (output) => /STEALTH TOR ROTATION: SUCCESS/.test(output) && /250 OK/.test(output) && /Browser context rebuilt: yes/.test(output));
  await check("alonix-toolings", () => plugin.tool["alonix-toolings"].execute({ action: "status" }, context("live-alonix-toolings")), (output) => /Self-patch status: (dev-mode|no-opencode|idle|ok|unsupported-version|error)/.test(output) && /OpenCode version:/.test(output));
} finally {
  if (cbmProject) {
    try { await plugin.tool["alonix-index-project"].execute({ action: "delete", project: cbmProject, repo_path: "", mode: "fast" }, context("live-cbm-project-delete")); } catch {}
  }
  await plugin.dispose?.();
  rmSync(fixture, { recursive: true, force: true });
}

const passed = results.filter((item) => item.passed).length;
console.log(`\nALL TOOLS LIVE ACCEPTANCE: ${passed === results.length ? "SUCCESS" : "FAILED"}`);
for (const item of results) console.log(`- [${item.passed ? "PASS" : "FAIL"}] ${item.name} (${item.durationMs}ms): ${item.evidence}`);
console.log(`SUMMARY: passed=${passed}; failed=${results.length - passed}; total=${results.length}; fixture_cleaned=true`);
if (passed !== results.length) process.exitCode = 1;
