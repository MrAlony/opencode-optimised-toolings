import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

const root = new URL("..", import.meta.url)
async function source(path) { return readFile(new URL(path, root), "utf8") }

test("activity rows preserve Solid reactivity and remount details on every expansion", async () => {
  const kit = await source("components/kit.jsx")
  assert.match(kit, /export function Activity\(props\)/)
  assert.doesNotMatch(kit, /function Activity\(\{[^)]*status/)
  assert.match(kit, /typeof props\.details === "function"/)
  assert.match(kit, /open\(\).*props\.details\(\)/s)
  const activityBody = kit.slice(kit.indexOf("export function Activity"), kit.indexOf("export function ItemRow"))
  assert.doesNotMatch(activityBody, /props\.children/)
  assert.match(kit, /focusable=\{expandable\(\)\}/)
  assert.match(kit, /stopPropagation/)
  assert.match(kit, /marginTop=\{props\.compact \? 0 : 1\}/)
})

test("execution lifecycle is authoritative before result parsing", async () => {
  const kit = await source("components/kit.jsx")
  assert.match(kit, /state\.status === "error".*"FAILED"/)
  assert.match(kit, /state\.status === "running".*"RUNNING"/)
  assert.match(kit, /state\.status === "pending"|return \{ phase: "pending"/)
  assert.match(kit, /if \(lifecycle\.status\) return lifecycle\.status/)
  assert.match(kit, /return resultStatus \?\? "PARTIAL SUCCESS"/)
})

test("all tool families have dedicated inspectors and compact item previews", async () => {
  const index = await source("index.tsx")
  for (const view of ["ReadManyView", "EditManyView", "ShellView", "BackgroundView", "DiscoveryView", "WebView", "StealthView", "CbmView"]) assert.match(index, new RegExp(view))
  for (const file of ["read-many.jsx", "edit-many.jsx", "shell.jsx", "background.jsx", "discovery.jsx", "web.jsx", "stealth.jsx", "cbm.jsx"]) {
    const body = await source(`components/${file}`)
    assert.match(body, /<Activity/)
    assert.match(body, /preview=/)
    assert.match(body, /details=\{\(\) =>/)
    assert.doesNotMatch(body, /<box\s+border/)
  }
})

test("expanded inspectors bound evidence and retain structured diagnostics", async () => {
  const kit = await source("components/kit.jsx")
  assert.match(kit, /export function PreviewList/)
  assert.match(kit, /props\.limit \?\? 4/)
  assert.match(kit, /export function RawEvidence/)
  assert.match(kit, /props\.limit \?\? 24/)
  const edit = await source("components/edit-many.jsx")
  assert.match(edit, /Intended transaction/)
  assert.match(edit, /Rejected safely/)
  assert.match(edit, /Transaction safety/)
  const web = await source("components/web.jsx")
  assert.match(web, /backend attempts/)
  assert.match(web, /completeness/)
})

test("plugin renderer host participates in native transcript layout", async () => {
  const manifest = await readFile(new URL("../selfpatch/patches/1.18.13/manifest.mjs", root), "utf8")
  assert.match(manifest, /alwaysSeparate\.add\(el\)/)
  assert.match(manifest, /flexShrink=\{0\}/)
})
