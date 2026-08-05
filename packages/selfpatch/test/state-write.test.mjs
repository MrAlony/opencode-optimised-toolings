import test from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { readState, writeState } from "../lib/state.js"

async function tempRoot() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "alonix-state-"))
}

test("state round-trips through an atomic write", async () => {
  const root = await tempRoot()
  try {
    assert.equal(await writeState(root, { status: "building", progressPercent: 40 }), true)
    const state = await readState(root)
    assert.equal(state.status, "building")
    assert.equal(state.progressPercent, 40)
    assert.ok(state.updatedAt, "every write stamps a time")
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("a missing runtime directory is recreated rather than failing", async () => {
  const root = await tempRoot()
  try {
    // Nothing exists yet: the very first write must still succeed.
    assert.equal(await writeState(root, { status: "detecting" }), true)
    assert.equal((await readState(root)).status, "detecting")
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

// Regression: the runtime directory disappearing between mkdir and rename
// produced `ENOENT ... rename '.selfpatch-state-<pid>.tmp'`, which surfaced to
// the user as "Self-patch failed" even though only a status write had failed.
test("a directory removed mid-write is recovered on retry", async () => {
  const root = await tempRoot()
  try {
    await writeState(root, { status: "detecting" })
    const runtime = path.join(root, "runtime")
    assert.ok(
      await fs
        .stat(runtime)
        .then(() => true)
        .catch(() => false),
      "the runtime directory should exist after a write",
    )

    // Simulate a concurrent clean wiping the directory.
    await fs.rm(runtime, { recursive: true, force: true })
    assert.equal(await writeState(root, { status: "building" }), true, "the write must recover")
    assert.equal((await readState(root)).status, "building")
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("a stale temp file from a previous crash does not block a write", async () => {
  const root = await tempRoot()
  try {
    await writeState(root, { status: "detecting" })
    const runtime = path.join(root, "runtime")
    // Leave a temp file behind, as an interrupted process would.
    await fs.writeFile(path.join(runtime, `.selfpatch-state-${process.pid}.tmp`), "garbage", "utf8")
    assert.equal(await writeState(root, { status: "built" }), true)
    assert.equal((await readState(root)).status, "built")
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("concurrent writers do not corrupt the document", async () => {
  const root = await tempRoot()
  try {
    await Promise.all(
      Array.from({ length: 12 }, (_, index) => writeState(root, { status: "building", progressPercent: index })),
    )
    // Whichever write landed last, the file must still be valid JSON.
    const state = await readState(root)
    assert.equal(state.status, "building")
    assert.ok(Number.isFinite(state.progressPercent))
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("an unwritable location reports failure instead of throwing", async () => {
  // A path whose parent is a file cannot hold a directory. The write must
  // report false rather than escaping as a self-patch error.
  const root = await tempRoot()
  try {
    const blocker = path.join(root, "blocked")
    await fs.writeFile(blocker, "not a directory", "utf8")
    let result
    await assert.doesNotReject(async () => {
      result = await writeState(blocker, { status: "error" })
    })
    assert.equal(result, false, "failure is reported through the return value")
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("reading absent or corrupt state falls back to defaults", async () => {
  const root = await tempRoot()
  try {
    const missing = await readState(root)
    assert.ok(missing.status, "a default state is always available")

    await writeState(root, { status: "built" })
    const file = path.join(root, "runtime", "selfpatch-state.json")
    await fs.writeFile(file, "{ not valid json", "utf8")
    const corrupt = await readState(root)
    assert.ok(corrupt.status, "corrupt state must not throw")
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
