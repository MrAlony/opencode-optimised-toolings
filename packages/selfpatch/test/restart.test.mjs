import test from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installPatchedBinary } from "../lib/restart.js"
import { isDedicatedOpenCodeServer, reconcileHostRuntime } from "../lib/host-recovery.js"
import { installPending } from "../lib/pipeline.js"
import { patchedBinaryPath } from "../lib/state.js"

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "alonix-toolings-install-"))
  return {
    dir,
    official: join(dir, "opencode.exe"),
    patched: join(dir, "patched.exe"),
  }
}

test("installPatchedBinary replaces the official binary in place and keeps the original backup", async () => {
  const f = fixture()
  try {
    writeFileSync(f.official, "ORIGINAL-OFFICIAL")
    writeFileSync(f.patched, "PATCHED-BINARY")
    const result = await installPatchedBinary({ officialPath: f.official, patchedPath: f.patched })
    assert.equal(result.installed, true)
    assert.equal(result.alreadyPatched, false)
    assert.equal(readFileSync(f.official, "utf8"), "PATCHED-BINARY")
    assert.equal(readFileSync(`${f.official}.alonix-toolings-backup`, "utf8"), "ORIGINAL-OFFICIAL")
  } finally {
    rmSync(f.dir, { recursive: true, force: true })
  }
})

test("installPatchedBinary never touches running processes (pure file replacement)", async () => {
  const f = fixture()
  try {
    writeFileSync(f.official, "A")
    writeFileSync(f.patched, "B")
    const result = await installPatchedBinary({ officialPath: f.official, patchedPath: f.patched })
    assert.ok(result.installed)
    assert.ok(!("kill" in result) && !("restart" in result))
    assert.equal(readFileSync(f.official, "utf8"), "B")
  } finally {
    rmSync(f.dir, { recursive: true, force: true })
  }
})

test("installPatchedBinary is idempotent: an already-patched binary is reported without a second swap", async () => {
  const f = fixture()
  try {
    writeFileSync(f.official, "PATCHED")
    writeFileSync(f.patched, "PATCHED")
    const result = await installPatchedBinary({ officialPath: f.official, patchedPath: f.patched })
    assert.equal(result.installed, false)
    assert.equal(result.alreadyPatched, true)
    assert.equal(existsSync(`${f.official}.alonix-toolings-backup`), false)
  } finally {
    rmSync(f.dir, { recursive: true, force: true })
  }
})

test("installPending treats a fresh install as pending and stale records as retryable", () => {
  const now = Date.now()
  assert.equal(installPending({ status: "idle" }), false)
  assert.equal(installPending({ status: "building", updatedAt: now }), false)
  assert.equal(installPending({ status: "built", updatedAt: now - 10_000 }), true)
  assert.equal(installPending({ status: "built", updatedAt: now - 5 * 60 * 1000 }), false)
  assert.equal(installPending({ status: "built" }), true)
})

test("dedicated-server detection never selects interactive OpenCode processes", () => {
  const binaryPath = "C:/tools/opencode.exe"
  assert.equal(isDedicatedOpenCodeServer({ pid: 41, executablePath: binaryPath, commandLine: '"C:/tools/opencode.exe" serve --port 4096' }, { binaryPath, currentPid: 99 }), true)
  assert.equal(isDedicatedOpenCodeServer({ pid: 42, executablePath: binaryPath, commandLine: '"C:/tools/opencode.exe"' }, { binaryPath, currentPid: 99 }), false)
  assert.equal(isDedicatedOpenCodeServer({ pid: 99, executablePath: binaryPath, commandLine: '"C:/tools/opencode.exe" serve' }, { binaryPath, currentPid: 99 }), false)
  assert.equal(isDedicatedOpenCodeServer({ pid: 43, executablePath: "C:/other/opencode.exe", commandLine: '"C:/other/opencode.exe" serve' }, { binaryPath, currentPid: 99 }), false)
})

test("host recovery quarantines a withdrawn artifact and retires only its dedicated server", async () => {
  const root = mkdtempSync(join(tmpdir(), "alonix-host-recovery-"))
  try {
    mkdirSync(join(root, "runtime", "patched"), { recursive: true })
    const binaryPath = join(root, "official", "opencode.exe")
    const artifact = patchedBinaryPath(root, "1.18.15")
    const marker = `${artifact}.manifest.json`
    writeFileSync(artifact, "WITHDRAWN")
    writeFileSync(marker, JSON.stringify({ manifestSha256: "withdrawn", binarySha256: "old" }))
    const terminated = []
    const result = await reconcileHostRuntime(root, {
      version: "1.18.15",
      manifestSha256: "supported",
      binaryPath,
    }, {
      currentPid: 999,
      listProcesses: () => [
        { pid: 100, executablePath: binaryPath, commandLine: `"${binaryPath}" serve --port 60510` },
        { pid: 101, executablePath: binaryPath, commandLine: `"${binaryPath}"` },
      ],
      terminate: (pid) => { terminated.push(pid); return true },
    })
    assert.equal(result.artifact.quarantined, true)
    assert.deepEqual(result.retired, [100])
    assert.deepEqual(terminated, [100])
    assert.equal(existsSync(artifact), false)
    assert.equal(existsSync(marker), false)
    assert.ok(existsSync(join(result.artifact.directory, "recovery.json")))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("host controller transitions retire stale servers once and matching launches are no-ops", async () => {
  const root = mkdtempSync(join(tmpdir(), "alonix-host-controller-"))
  try {
    const binaryPath = join(root, "opencode.exe")
    const controllerFile = join(root, "controller.json")
    const terminated = []
    const options = {
      controllerFile,
      currentPid: 999,
      listProcesses: () => [{ pid: 200, executablePath: binaryPath, commandLine: `"${binaryPath}" serve` }],
      terminate: (pid) => { terminated.push(pid); return true },
    }
    const first = await reconcileHostRuntime(root, { version: "1.18.15", manifestSha256: "old", binaryPath }, options)
    assert.equal(first.firstClaim, true)
    assert.deepEqual(terminated, [200], "the first controller claim must retire one potentially pre-controller server")
    const changed = await reconcileHostRuntime(root, { version: "1.18.15", manifestSha256: "new", binaryPath }, options)
    assert.equal(changed.controllerChanged, true)
    assert.deepEqual(terminated, [200, 200])
    const stable = await reconcileHostRuntime(root, { version: "1.18.15", manifestSha256: "new", binaryPath }, options)
    assert.equal(stable.controllerChanged, false)
    assert.deepEqual(terminated, [200, 200])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
