import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { formatStatus, formatStealth } from "../lib/format.js";
import { packageRoot, stealthConfig } from "../lib/config.js";
import { workerEnvironment } from "../lib/worker-client.js";

test("formats bounded stealth evidence with explicit Tor state", () => {
  const output = formatStealth("fetch", { tor: { bootstrapped: true, authenticated: true, socks_port: 19050 }, items: [{ ok: true, url: "https://example.com", content: "x".repeat(5000) }] }, 2000);
  assert.match(output, /STEALTH FETCH RESULT: SUCCESS/);
  assert.match(output, /control authentication=cookie/);
  assert.match(output, /OMITTED \d+ BYTES/);
});

test("worker environment forces a Unicode-safe JSON transport", () => {
  const env = workerEnvironment({}, { runtimeRoot: "runtime", socksPort: 19050, controlPort: 19051 });
  assert.equal(env.PYTHONIOENCODING, "utf-8");
  assert.equal(env.PYTHONUTF8, "1");
  assert.equal(env.PYTHONUNBUFFERED, "1");
});

test("Python worker emits Unicode JSON under a legacy Windows code page", async (t) => {
  const config = stealthConfig();
  assert.ok(config.python, "configured stealth Python is required for the integration test");
  const child = spawn(config.python, [resolve(packageRoot, "worker.py")], {
    cwd: packageRoot,
    env: { ...process.env, ...workerEnvironment(process.env, { runtimeRoot: resolve(packageRoot, "runtime-test"), socksPort: 19150, controlPort: 19151 }), PYTHONIOENCODING: "cp1252" },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const lines = createInterface({ input: child.stdout });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.write(`${JSON.stringify({ id: "unicode", action: "unknown-▸", payload: {} })}\n`);
  const responseLine = await Promise.race([
    once(lines, "line").then(([line]) => String(line)),
    once(child, "exit").then(([code, signal]) => { throw new Error(`worker exited before Unicode response (code=${code}, signal=${signal || "none"}): ${stderr}`); }),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`worker Unicode response timed out: ${stderr}`)), 10_000)),
  ]);
  const response = JSON.parse(responseLine);
  assert.equal(response.id, "unicode");
  assert.equal(response.ok, false);
  assert.match(response.error, /unknown-▸/);
  child.stdin.end();
  await once(child, "exit");
});

test("Python search parser handles both DuckDuckGo HTML and Lite result shapes", async () => {
  const config = stealthConfig();
  assert.ok(config.python, "configured stealth Python is required for the parser integration test");
  const script = [
    "import json, sys",
    `sys.path.insert(0, ${JSON.stringify(packageRoot.replace(/\\/g, "/"))})`,
    "import worker",
    "html = '''<div class=\"result\"><a class=\"result__a\" href=\"/l/?uddg=https%3A%2F%2Fexample.com%2Fone\">HTML result</a><a class=\"result__snippet\">First snippet</a></div><table><tr><td><a class=\"result-link\" href=\"https://example.com/two\">Lite result</a><span class=\"result-snippet\">Second snippet</span></td></tr></table>'''",
    "print(json.dumps(worker.parse_search_results(html, 5), ensure_ascii=False))",
  ].join("; ");
  const child = spawn(config.python, ["-c", script], { cwd: packageRoot, env: workerEnvironment(process.env, { runtimeRoot: resolve(packageRoot, "runtime-test"), socksPort: 19150, controlPort: 19151 }), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stdout = ""; let stderr = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [code] = await once(child, "exit");
  assert.equal(code, 0, stderr);
  const rows = JSON.parse(stdout);
  assert.equal(rows.length, 2);
  assert.match(rows[0], /https:\/\/example\.com\/one/);
  assert.match(rows[1], /Lite result/);
});

test("status distinguishes configured worker from Tor bootstrap", () => {
  const output = formatStatus({ ready: true, worker: true, tor_executable: "/tor", tor: { owned: false, bootstrapped: false, authenticated: false }, browser: false });
  assert.match(output, /STEALTH STATUS: READY/);
  assert.match(output, /Tor bootstrapped: no/);
});
