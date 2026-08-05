import test from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installPatchedBinary } from "../lib/restart.js"
import { installPending } from "../lib/pipeline.js"

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "toolings-install-"))
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
    assert.equal(readFileSync(`${f.official}.toolings-backup`, "utf8"), "ORIGINAL-OFFICIAL")
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
    assert.equal(existsSync(`${f.official}.toolings-backup`), false)
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
