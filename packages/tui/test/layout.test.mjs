import test from "node:test"
import assert from "node:assert/strict"
import { densityOf, fit, fitLeft, homeLayout, inspectorLayout, pad, switcherLayout, workbenchLayout } from "../lib/layout.js"

test("density thresholds classify terminal widths", () => {
  assert.equal(densityOf(60), "compact")
  assert.equal(densityOf(90), "standard")
  assert.equal(densityOf(120), "wide")
  assert.equal(densityOf(200), "panoramic")
})

test("workbench geometry never overflows and drops panels as width shrinks", () => {
  for (const width of [40, 60, 80, 100, 120, 160, 240]) {
    const layout = workbenchLayout({ width, height: 40 })
    const total = layout.rail + layout.explorer + layout.detail + layout.main
    assert.ok(total <= width, `columns must fit at ${width} (got ${total})`)
    assert.ok(layout.main >= 20, `main column must stay usable at ${width}`)
    assert.ok(layout.bodyHeight >= 3)
  }
  assert.equal(workbenchLayout({ width: 50, height: 30 }).showExplorer, false)
  assert.equal(workbenchLayout({ width: 50, height: 30 }).showDetail, false)
  assert.equal(workbenchLayout({ width: 160, height: 40 }).showDetail, true)
})

test("workbench geometry survives missing or absurd dimensions", () => {
  for (const dimensions of [undefined, {}, { width: 0, height: 0 }, { width: -50, height: -2 }]) {
    const layout = workbenchLayout(dimensions)
    assert.ok(layout.main >= 20)
    assert.ok(layout.height >= 8)
  }
})

test("switcher geometry only shows a preview when there is room", () => {
  // A narrow terminal clamps the dialog panel, leaving no room beside the list.
  const narrow = switcherLayout({ width: 80, height: 30 })
  assert.equal(narrow.showPreview, false)
  assert.equal(narrow.preview, 0)
  assert.ok(narrow.list >= 16)

  const wide = switcherLayout({ width: 180, height: 50 })
  assert.equal(wide.showPreview, true)
  assert.ok(wide.preview >= 26)
  assert.ok(wide.list + wide.preview <= wide.inner)
  assert.ok(wide.rows >= 3 && wide.rows <= 16)
})

test("switcher geometry is bounded by the dialog panel, not the terminal", () => {
  // Regression: sizing from the terminal overflowed the fixed-width host dialog
  // and let the renderer shrink labels to a few characters.
  const huge = switcherLayout({ width: 400, height: 60 })
  assert.ok(huge.inner <= 116, `panel width must stay bounded, got ${huge.inner}`)
  assert.ok(huge.list + huge.preview <= huge.inner + 1)
  assert.ok(huge.columns.title >= 24, "titles must remain readable")

  // A smaller dialog yields a smaller panel.
  const large = switcherLayout({ width: 400, height: 60 }, "large")
  assert.ok(large.inner < huge.inner)
  assert.ok(large.list + large.preview <= large.inner + 1)
})

test("inspector and home geometry stay within their host containers", () => {
  const inspector = inspectorLayout(42)
  assert.ok(inspector.usable <= 38)
  assert.ok(inspector.gauge >= 6)

  const home = homeLayout({ width: 120, height: 40 })
  assert.ok(home.deck <= 75)
  assert.ok(home.columns >= 1 && home.columns <= 3)
  assert.ok(home.cardWidth * home.columns <= home.deck)
  assert.equal(homeLayout({ width: 60, height: 30 }).columns, 1)
})

test("text fitting is exact and never exceeds the requested cells", () => {
  assert.equal(fit("hello", 10), "hello")
  assert.equal(fit("hello world", 8), "hello w…")
  assert.equal([...fit("hello world", 8)].length, 8)
  assert.equal(fit("hello", 1), "…")
  assert.equal(fitLeft("src/a/b/file.ts", 8), "…file.ts")
  assert.equal([...fitLeft("src/a/b/file.ts", 8)].length, 8)
  assert.equal(fitLeft("short", 20), "short")
  assert.equal(fitLeft("anything", 1), "…")
  assert.equal(pad("ab", 5), "ab   ")
  assert.equal(pad("ab", 5, "right"), "   ab")
  assert.equal(pad("ab", 6, "center"), "  ab  ")
  assert.equal([...pad("abcdefgh", 4)].length, 4)
})
