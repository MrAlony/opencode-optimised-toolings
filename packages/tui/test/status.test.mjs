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
  isStale,
  readStateSync,
  rootFromModule,
  statePathForRoot,
  toastForTransition,
} from "../lib/status.js"

test("custom tool registry has 16 unique names covering every family", () => {
  assert.equal(customTools.length, 16)
  assert.equal(new Set(customTools).size, 16)
  assert.ok(customTools.every((name) => name.startsWith("alonix-")))
  for (const family of ["alonix-read-", "alonix-edit-", "alonix-index-", "alonix-web-", "alonix-stealth-"]) {
    assert.ok(customTools.some((name) => name.startsWith(family)), `missing ${family} tool`)
  }
  assert.ok(customTools.includes("alonix-shell"))
  assert.ok(customTools.includes("alonix-background-process"))
})

test("indicatorFor maps statuses to visible levels", () => {
  assert.equal(indicatorFor({ status: "ok" }).level, "ok")
  assert.equal(indicatorFor({ status: "ok" }).detail, "Rich tool renderers active")
  assert.equal(indicatorFor({ status: "error", lastError: "boom" }).level, "error")
  assert.equal(indicatorFor({ status: "unsupported-version" }).level, "warn")
  assert.equal(indicatorFor({ status: "idle" }).level, "info")
  assert.equal(indicatorFor({ status: "dev-mode" }).level, "info")
  assert.equal(indicatorFor({ status: "no-opencode" }).level, "warn")
  assert.equal(indicatorFor({ status: "building", progressPercent: 40, stepLabel: "Rebuilding" }).level, "warn")
  assert.equal(indicatorFor({ status: "built" }).level, "info")
  assert.match(indicatorFor({ status: "built" }).text, /restart OpenCode/i)
})

test("live renderer registration outranks a stale or dev-host state record", () => {
  // Renderers can only register through the patched core's registry, so a
  // positive count proves the patched binary is running. The state file is
  // written by another process and must not contradict that evidence.
  const evidence = { renderersRegistered: 16 }
  for (const status of ["dev-mode", "no-opencode", "idle", "unsupported-version", "ok"]) {
    const indicator = indicatorFor({ status }, evidence)
    assert.equal(indicator.level, "ok", `${status} must report active when renderers are registered`)
    assert.match(indicator.text, /Patched binary active/)
  }
  // Genuine failures and pending restarts still win; they are actionable.
  assert.equal(indicatorFor({ status: "error", lastError: "boom" }, evidence).level, "error")
  assert.match(indicatorFor({ status: "built" }, evidence).text, /restart OpenCode/i)
  // With no renderers the state file remains authoritative.
  assert.equal(indicatorFor({ status: "dev-mode" }, { renderersRegistered: 0 }).level, "info")
  assert.equal(indicatorFor({ status: "dev-mode" }).level, "info")
})

test("dev-mode and no-opencode explain themselves instead of saying 'not applicable'", () => {
  const dev = indicatorFor({ status: "dev-mode" })
  assert.match(dev.text, /dev runtime/i)
  assert.doesNotMatch(dev.text, /not applicable/i)
  assert.ok(dev.detail, "dev-mode must explain why the binary was left alone")

  // A missing binary means renderers cannot activate, so it is a warning.
  const missing = indicatorFor({ status: "no-opencode" })
  assert.equal(missing.level, "warn")
  assert.match(missing.text, /No OpenCode binary/i)
  assert.doesNotMatch(missing.text, /not applicable/i)
})

test("indicatorFor reports stale records as checking instead of misleading states", () => {
  const stale = { status: "dev-mode", updatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() }
  const fresh = { status: "dev-mode", updatedAt: new Date().toISOString() }
  assert.equal(isStale(stale), true)
  assert.equal(isStale(fresh), false)
  assert.equal(isStale({ status: "idle" }), false)
  assert.match(indicatorFor(stale).text, /checking/)
  assert.match(indicatorFor(fresh).text, /dev runtime/i)
  assert.equal(indicatorFor({ status: "idle" }).text, "Tooling self-patch pending")
  assert.equal(indicatorFor({ status: "ok", updatedAt: stale.updatedAt }).level, "ok")
})

test("toastForTransition only fires on meaningful transitions", () => {
  assert.equal(toastForTransition(null, { status: "building" }), null)
  assert.equal(toastForTransition({ status: "building" }, { status: "building" }), null)
  assert.ok(toastForTransition({ status: "building" }, { status: "built" }))
  assert.match(toastForTransition({ status: "building" }, { status: "built" }).message, /restart OpenCode/i)
  assert.equal(toastForTransition({ status: "built" }, { status: "built" }), null)
  assert.ok(toastForTransition({ status: "built" }, { status: "ok" }))
  assert.ok(toastForTransition({ status: "building" }, { status: "error", lastError: "x" }))
  assert.equal(toastForTransition({ status: "error" }, { status: "error", lastError: "y" }), null)
  assert.equal(toastForTransition({ status: "building" }, { status: "restarting" }), null)
})

test("root discovery climbs to the tooling package.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "alonix-toolings-root-"))
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
