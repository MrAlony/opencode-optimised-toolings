#!/usr/bin/env node
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import process from "node:process"

const root = resolve(new URL("..", import.meta.url).pathname.replace(/^\/(?:([A-Za-z]):)/, "$1:"))
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 90_000

export function redactSecrets(value) {
  return String(value ?? "")
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, "[REDACTED_API_KEY]")
    .replace(/\b(gh[opsu]_[A-Za-z0-9]{20,})\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/("(?:key|token|password|authorization)"\s*:\s*")[^"]+("?)/gi, "$1[REDACTED]$2")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, "$1[REDACTED]")
}

function appendBounded(current, chunk) {
  const next = current + String(chunk ?? "")
  if (Buffer.byteLength(next) <= MAX_CAPTURE_BYTES) return next
  return next.slice(-MAX_CAPTURE_BYTES)
}

export function buildKiloArgs(prompt, options = {}) {
  const args = ["run", prompt, "--pure", "--agent", "ask", "--auto", "--format", "default", "--no-replay"]
  if (options.title) args.push("--title", options.title)
  for (const file of options.files ?? []) args.push(`--file=${file}`)
  return args
}

export function auditSeverity(report) {
  const counts = report?.metadata?.vulnerabilities ?? {}
  if ((counts.critical ?? 0) > 0) return "critical"
  if ((counts.high ?? 0) > 0) return "high"
  if ((counts.moderate ?? 0) > 0) return "moderate"
  if ((counts.low ?? 0) > 0) return "low"
  return "none"
}

export function forbiddenPackageEntries(files) {
  return (files ?? [])
    .map((entry) => String(entry?.path ?? entry))
    .filter((path) => /(^|\/)(test|tests|runtime|\.github|backups?)(\/|$)|worker\.py$|requirements\.txt$/i.test(path))
}

export function spawnPlan(command, args, env = process.env) {
  if (process.platform !== "win32") return { command, args }
  if (command === "npm") {
    const cli = env.npm_execpath || join(env.APPDATA ?? "", "npm", "node_modules", "npm", "bin", "npm-cli.js")
    if (cli && existsSync(cli)) return { command: process.execPath, args: [cli, ...args] }
  }
  if (command === "kilo") {
    const cli = join(env.APPDATA ?? "", "npm", "node_modules", "@kilocode", "cli", "bin", "kilo")
    if (existsSync(cli)) return { command: process.execPath, args: [cli, ...args] }
  }
  return { command, args }
}

export async function runFinite(command, args, options = {}) {
  const timeoutMs = Math.max(1_000, Number(options.timeoutMs ?? DEFAULT_TIMEOUT_MS))
  return await new Promise((done) => {
    const plan = spawnPlan(command, args, options.env ?? process.env)
    let child
    let timer
    try {
      child = spawn(plan.command, plan.args, {
      cwd: options.cwd ?? root,
      env: options.env ?? process.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      })
    } catch (error) {
      done({ code: null, signal: null, timedOut: false, error: error.message, stdout: "", stderr: "" })
      return
    }
    let stdout = ""
    let stderr = ""
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      done({ ...result, stdout: redactSecrets(stdout), stderr: redactSecrets(stderr) })
    }
    child.stdout?.on("data", (chunk) => { stdout = appendBounded(stdout, chunk) })
    child.stderr?.on("data", (chunk) => { stderr = appendBounded(stderr, chunk) })
    child.once("error", (error) => finish({ code: null, signal: null, timedOut: false, error: error.message }))
    child.once("close", (code, signal) => finish({ code, signal, timedOut: false, error: null }))
    timer = setTimeout(() => {
      if (process.platform === "win32" && child.pid) {
        spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).unref()
      } else {
        try { child.kill("SIGTERM") } catch {}
      }
      finish({ code: null, signal: "TIMEOUT", timedOut: true, error: `deadline exceeded after ${timeoutMs}ms` })
    }, timeoutMs)
    timer.unref?.()
  })
}

function parseJsonOutput(result, label) {
  const source = result.stdout.trim() || result.stderr.trim()
  try {
    return JSON.parse(source)
  } catch {
    throw new Error(`${label} did not return valid JSON: ${source.slice(0, 500)}`)
  }
}

async function gate(name, command, args, options = {}) {
  const startedAt = Date.now()
  const result = await runFinite(command, args, options)
  return {
    name,
    ok: result.code === 0 && !result.timedOut,
    durationMs: Date.now() - startedAt,
    ...result,
  }
}

async function deterministicAudit() {
  const checks = []
  checks.push(await gate("syntax", process.execPath, ["--check", "index.js"], { timeoutMs: 30_000 }))
  checks.push(await gate("diff", "git", ["diff", "--check"], { timeoutMs: 30_000 }))
  checks.push(await gate("build", "npm", ["run", "build"], { timeoutMs: 90_000 }))
  checks.push(await gate("shareability", "npm", ["run", "verify:shareable"], { timeoutMs: 90_000 }))
  checks.push(await gate("tui-regression", "npm", ["run", "test", "-w", "packages/tui"], { timeoutMs: 90_000 }))
  checks.push(await gate("tui-parity", process.execPath, ["--test", "test/tui-runtime-parity.test.mjs"], { timeoutMs: 30_000 }))

  const pack = await gate("package", "npm", ["pack", "--dry-run", "--json"], { timeoutMs: 90_000 })
  if (pack.ok) {
    const data = parseJsonOutput(pack, "npm pack")?.[0]
    const forbidden = forbiddenPackageEntries(data?.files)
    pack.details = { version: data?.version, files: data?.entryCount ?? data?.files?.length, forbidden }
    pack.ok = forbidden.length === 0
  }
  checks.push(pack)

  const dependencies = await gate("dependencies", "npm", ["audit", "--omit=dev", "--json"], { timeoutMs: 90_000 })
  try {
    const data = parseJsonOutput(dependencies, "npm audit")
    const severity = auditSeverity(data)
    dependencies.details = { severity, vulnerabilities: data?.metadata?.vulnerabilities ?? {} }
    dependencies.ok = !["critical", "high", "moderate"].includes(severity)
  } catch (error) {
    dependencies.ok = false
    dependencies.error = error.message
  }
  checks.push(dependencies)
  return checks
}

async function modelAudit() {
  const prompt = "Read-only production audit. Inspect the current repository and uncommitted diff. Report at most five evidence-backed correctness, security, lifecycle, concurrency, release-integrity, or test-gap findings with severity, exact paths/lines, deterministic failure sequence, and minimal fix. Do not edit files or run long commands. Output NO_ACTIONABLE_FINDINGS if none are provable."
  const files = [
    "packages/tui/index.tsx",
    "packages/tui/components/project-store.jsx",
    "packages/tui/lib/presence-lease.js",
    "scripts/release-local.mjs",
    "test/tui-runtime-parity.test.mjs",
  ]
  return await gate("kilo-review", "kilo", buildKiloArgs(prompt, { title: "Alonix finite engine audit", files }), { timeoutMs: 60_000 })
}

export function summarize(checks, review) {
  const failed = checks.filter((item) => !item.ok)
  const modelStatus = !review ? "skipped" : review.ok ? "passed" : "degraded"
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    root,
    deterministic: checks.map(({ stdout, stderr, ...item }) => ({
      ...item,
      stdout: stdout.trim().slice(-4_000),
      stderr: stderr.trim().slice(-4_000),
    })),
    modelReview: review ? {
      status: modelStatus,
      ok: review.ok,
      timedOut: review.timedOut,
      durationMs: review.durationMs,
      output: (review.stdout.trim() || review.stderr.trim()).slice(-16_000),
      error: review.error,
    } : { status: modelStatus, skipped: true },
    outcome: failed.length ? "failed" : modelStatus === "degraded" ? "degraded" : "passed",
    failed: failed.map((item) => item.name),
  }
}

async function main() {
  const noModel = process.argv.includes("--no-model")
  const checks = await deterministicAudit()
  const review = noModel ? null : await modelAudit()
  const report = summarize(checks, review)
  console.log(JSON.stringify(report, null, 2))
  if (report.outcome === "failed") process.exitCode = 1
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/(?:([A-Za-z]):)/, "$1:"))) {
  await main()
}
