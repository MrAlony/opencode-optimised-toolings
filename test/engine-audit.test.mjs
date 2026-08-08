import test from "node:test"
import assert from "node:assert/strict"
import { auditSeverity, buildKiloArgs, forbiddenPackageEntries, redactSecrets, spawnPlan, summarize } from "../scripts/engine-audit.mjs"

test("engine audit redacts credentials from failed CLI diagnostics", () => {
  const source = 'params: {"key":"sk-example_SUPER_SECRET_123456789","authorization":"Bearer abc.def.ghi"} ghp_abcdefghijklmnopqrstuvwxyz123456'
  const redacted = redactSecrets(source)
  assert.doesNotMatch(redacted, /SUPER_SECRET|abc\.def|ghp_abcdefghijklmnopqrstuvwxyz/)
  assert.match(redacted, /REDACTED/)
})

test("engine audit places the positional prompt before repeatable file options", () => {
  const args = buildKiloArgs("audit prompt", { title: "audit", files: ["a.js", "b.js"] })
  assert.deepEqual(args.slice(0, 2), ["run", "audit prompt"])
  assert.deepEqual(args.filter((value) => value.startsWith("--file=")), ["--file=a.js", "--file=b.js"])
  assert.equal(args.at(-1), "--file=b.js")
})

test("engine audit resolves Windows package shims without a command shell", () => {
  const npmCli = process.execPath
  const plan = spawnPlan("npm", ["run", "build"], { ...process.env, npm_execpath: npmCli })
  if (process.platform === "win32") {
    assert.equal(plan.command, process.execPath)
    assert.equal(plan.args[0], npmCli)
  } else {
    assert.equal(plan.command, "npm")
  }
})

test("engine audit blocks moderate or worse dependency findings", () => {
  assert.equal(auditSeverity({ metadata: { vulnerabilities: { low: 3 } } }), "low")
  assert.equal(auditSeverity({ metadata: { vulnerabilities: { low: 1, moderate: 1 } } }), "moderate")
  assert.equal(auditSeverity({ metadata: { vulnerabilities: { critical: 1 } } }), "critical")
})

test("engine audit enforces the runtime-only package allowlist", () => {
  const forbidden = forbiddenPackageEntries([
    { path: "index.js" },
    { path: "packages/tui/lib/presence-lease.js" },
    { path: "test/leak.test.mjs" },
    { path: "packages/stealth/worker.py" },
  ])
  assert.deepEqual(forbidden, ["test/leak.test.mjs", "packages/stealth/worker.py"])
})

test("engine audit reports unavailable supplemental model review as degraded", () => {
  const deterministic = [{ name: "build", ok: true, stdout: "", stderr: "" }]
  const degraded = summarize(deterministic, {
    ok: false,
    timedOut: false,
    durationMs: 10,
    stdout: "",
    stderr: "provider model not found",
    error: null,
  })
  assert.equal(degraded.outcome, "degraded")
  assert.equal(degraded.modelReview.status, "degraded")
  assert.deepEqual(degraded.failed, [])

  const failed = summarize([{ name: "build", ok: false, stdout: "", stderr: "failed" }], null)
  assert.equal(failed.outcome, "failed")
  assert.equal(failed.modelReview.status, "skipped")
})
