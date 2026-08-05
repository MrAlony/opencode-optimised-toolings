import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

const root = new URL("..", import.meta.url)

async function source(path) {
  return readFile(new URL(path, root), "utf8")
}

test("activity rows are stable, focusable, keyboard operable, and motion-controllable", async () => {
  const kit = await source("components/kit.jsx")
  assert.match(kit, /flexShrink=\{0\}/)
  assert.match(kit, /focusable=\{expandable\}/)
  assert.match(kit, /onKeyDown=/)
  assert.match(kit, /return.*enter.*space/s)
  assert.match(kit, /stopPropagation/)
  assert.match(kit, /openDefault \|\| status === "FAILED"/)
  assert.match(kit, /skin\.motion === false/)
  assert.match(kit, /clearInterval/)
})

test("custom renderers use compact progressive disclosure instead of transcript cards", async () => {
  const files = ["report.jsx", "shell.jsx", "read-many.jsx", "edit-many.jsx", "background.jsx"]
  for (const file of files) {
    const body = await source(`components/${file}`)
    assert.match(body, /<Activity/)
    assert.doesNotMatch(body, /<box\s+border/)
  }
  const kit = await source("components/kit.jsx")
  assert.match(kit, /limit = 12/)
  assert.match(kit, /slice\(-limit\)/)
})

test("plugin renderer host participates in native transcript layout", async () => {
  const manifest = await readFile(new URL("../selfpatch/patches/1.18.13/manifest.mjs", root), "utf8")
  assert.match(manifest, /alwaysSeparate\.add\(el\)/)
  assert.match(manifest, /flexShrink=\{0\}/)
  assert.match(manifest, /renderer\(\)!\(\{ input:/)
})
