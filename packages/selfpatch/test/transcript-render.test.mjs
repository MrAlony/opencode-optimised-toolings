import test from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const bunCandidates = process.platform === "win32"
  ? [
      join(repositoryRoot, "node_modules", "@oven", "bun-windows-x64", "bin", "bun.exe"),
      join(repositoryRoot, "node_modules", "@oven", "bun-windows-x64-baseline", "bin", "bun.exe"),
      join(repositoryRoot, "node_modules", "bun", "bin", "bun.exe"),
    ]
  : [join(repositoryRoot, "node_modules", "bun", "bin", "bun")]
const bun = bunCandidates.find((file) => {
  try { return existsSync(file) && (process.platform !== "win32" || statSync(file).size > 1_000_000) } catch { return false }
}) ?? bunCandidates.at(-1)

function runProbe() {
  return new Promise((resolveProbe, reject) => {
    const child = spawn(bun, ["--conditions=browser", "packages/selfpatch/test/transcript-render-probe.tsx"], {
      cwd: repositoryRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`transcript render probe timed out\n${stderr.slice(-2000)}`))
    }, 30_000)
    timer.unref?.()
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk) => { stdout += chunk })
    child.stderr.on("data", (chunk) => { stderr += chunk })
    child.once("close", (code) => {
      clearTimeout(timer)
      if (code !== 0) return reject(new Error(`transcript render probe exited ${code}\n${stderr}\n${stdout}`))
      try {
        resolveProbe(JSON.parse(stdout.trim().split(/\r?\n/).filter(Boolean).at(-1)))
      } catch (error) {
        reject(new Error(`invalid transcript render probe output: ${error.message}\n${stderr}\n${stdout}`))
      }
    })
  })
}

test("sliding transcript window keeps sibling surfaces alive and mounted history bounded across repeated shifts", async () => {
  const result = await runProbe()
  assert.equal(result.siblingSurvival, true)
  assert.equal(result.maxMounted, 24, "window shifts must never accumulate transcript renderables")
  assert.equal(result.snapshots.length, 11)
  assert.deepEqual(result.snapshots[0], {
    prompt: true,
    plugin: true,
    earlier: true,
    later: false,
    count: 24,
    first: "message-77",
    last: "message-100",
  })
  assert.deepEqual(result.snapshots[5], {
    prompt: true,
    plugin: true,
    earlier: false,
    later: true,
    count: 24,
    first: "message-1",
    last: "message-24",
  })
  assert.deepEqual(result.snapshots.at(-1), result.snapshots[0])
  assert.ok(result.mounted < 10_000, `bounded initial mount took ${result.mounted.toFixed(0)} ms`)
  assert.ok(result.rssDelta < 256 * 1024 * 1024, `bounded shifting retained ${(result.rssDelta / 1024 / 1024).toFixed(1)} MiB`)
})
