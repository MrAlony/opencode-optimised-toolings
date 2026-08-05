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
  assert.match(kit, /paddingTop=\{1\}/)
  assert.match(kit, /paddingBottom=\{1\}/)
  assert.match(kit, /backgroundColor=\{statusSurface\(props\.status, props\.skin, active\(\)\)\}/)
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
    assert.ok(body.includes("details={() =>") || body.includes("details={details}"), `missing details factory in ${file}`)
    assert.doesNotMatch(body, /<box\s+border/)
  }
})

test("expanded inspectors lead with understandable outcomes before technical provenance", async () => {
  const kit = await source("components/kit.jsx")
  assert.match(kit, /export function OutcomeOverview/)
  assert.match(kit, /What this means/)
  for (const file of ["read-many.jsx", "edit-many.jsx", "shell.jsx", "background.jsx", "discovery.jsx", "web.jsx", "stealth.jsx", "cbm.jsx", "report.jsx"]) {
    const body = await source(`components/${file}`)
    assert.match(body, /<OutcomeOverview/)
  }
  const read = await source("components/read-many.jsx")
  assert.match(read, /What you received/)
  assert.match(read, /What could not be read/)
  assert.match(read, /Not returned/)
  assert.match(read, /Technical provenance/)
  assert.match(read, /Request an exact omitted range/)
})

test("expanded inspectors use separated status-aware cards and bounded content panes", async () => {
  const kit = await source("components/kit.jsx")
  assert.match(kit, /export function InspectorCard/)
  assert.match(kit, /export function ContentPane/)
  assert.match(kit, /props\.nested \? props\.skin\.surface : props\.skin\.inset/)
  assert.match(kit, /pending=\{props\.pending === true\}/)
  assert.doesNotMatch(kit.slice(kit.indexOf("export function InspectorCard"), kit.indexOf("export function ContentPane")), /tone === "RUNNING"/)
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
  assert.match(web, /Useful content returned/)
  assert.match(web, /<InspectorCard/)
  assert.match(web, /nested>/)
  const editNested = await source("components/edit-many.jsx")
  assert.match(editNested, /Exact replacement.*nested>/s)
  for (const file of ["read-many.jsx", "edit-many.jsx", "shell.jsx", "background.jsx", "discovery.jsx", "web.jsx", "stealth.jsx", "cbm.jsx"]) {
    const body = await source(`components/${file}`)
    assert.match(body, /<InspectorCard/)
  }
})

test("status surfaces remain subtle theme-aware secondary cues", async () => {
  const index = await source("index.tsx")
  for (const token of ["successSurface", "errorSurface", "warningSurface", "accentSurface", "inset"]) assert.match(index, new RegExp(token))
  const kit = await source("components/kit.jsx")
  assert.match(kit, /statusSurface/)
  assert.match(kit, /StatusGlyph/)
  assert.match(kit, /statusLabel/)
})

test("plugin renderer host participates in native transcript layout", async () => {
  const manifest = await readFile(new URL("../selfpatch/patches/1.18.13/manifest.mjs", root), "utf8")
  assert.match(manifest, /alwaysSeparate\.add\(el\)/)
  assert.match(manifest, /flexShrink=\{0\}/)
})
