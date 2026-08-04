import test from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import {
  customTools,
  formatStateLog,
  indicatorFor,
  readStateSync,
  rootFromModule,
  statePathForRoot,
  toastForTransition,
} from "../lib/status.js"

test("custom tool registry has 16 unique names covering every family", () => {
  assert.equal(customTools.length, 16)
  assert.equal(new Set(customTools).size, 16)
  for (const prefix of ["fs_", "cbm_", "web_", "stealth_"]) {
    assert.ok(customTools.some((name) => name.startsWith(prefix)), `missing ${prefix} tool`)
  }
  assert.ok(customTools.includes("shell"))
  assert.ok(customTools.includes("background_process"))
})

test("indicatorFor maps statuses to visible levels", () => {
  assert.equal(indicatorFor({ status: "ok" }).level, "hidden")
  assert.equal(indicatorFor({ status: "error", lastError: "boom" }).level, "error")
  assert.equal(indicatorFor({ status: "unsupported-version" }).level, "warn")
  assert.equal(indicatorFor({ status: "idle" }).level, "info")
  assert.equal(indicatorFor({ status: "building", progressPercent: 40, stepLabel: "Rebuilding" }).level, "warn")
  assert.equal(indicatorFor({ status: "restarting" }).level, "info")
})

test("toastForTransition only fires on meaningful transitions", () => {
  assert.equal(toastForTransition(null, { status: "building" }), null)
  assert.equal(toastForTransition({ status: "building" }, { status: "building" }), null)
  assert.ok(toastForTransition({ status: "building" }, { status: "built" }))
  assert.ok(toastForTransition({ status: "built" }, { status: "restarting" }))
  assert.ok(toastForTransition({ status: "built" }, { status: "ok" }))
  assert.ok(toastForTransition({ status: "building" }, { status: "error", lastError: "x" }))
  assert.equal(toastForTransition({ status: "error" }, { status: "error", lastError: "y" }), null)
})

test("root discovery climbs to the toolings package.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "toolings-root-"))
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "opencode-optimised-toolings" }))
    mkdirSync(join(dir, "deep", "down"), { recursive: true })
    const moduleUrl = pathToFileURL(join(dir, "deep", "down", "x.js")).href
    assert.equal(rootFromModule(moduleUrl), dir)
    assert.match(statePathForRoot(dir), /selfpatch-state\.json$/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("readStateSync falls back when the state file is missing", () => {
  const fallback = readStateSync(join(tmpdir(), "does-not-exist-state.json"))
  assert.equal(fallback.status, "idle")
})

test("formatStateLog renders the key fields", () => {
  const out = formatStateLog({
    status: "ok",
    version: "1.18.13",
    renderersActive: true,
    stepLabel: "done",
    patchedSha256: "abcdef0123456789",
  })
  assert.match(out, /Status: ok/)
  assert.match(out, /OpenCode version: 1\.18\.13/)
  assert.match(out, /Patched binary active: yes/)
  assert.match(out, /abcdef012345/)
})
