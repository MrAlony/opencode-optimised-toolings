import test from "node:test"
import assert from "node:assert/strict"
import { DIALOG_WIDTHS, PALETTE_PADDING, paletteLayout, pad } from "../lib/layout.js"

/** Every leading cell, gap, and column must sum to exactly the list width. */
function assertColumnsFit(layout, label) {
  const c = layout.columns
  const used = c.gutter + c.glyph + c.slot + c.gaps + c.meta + c.title + (c.subtitle ? c.subtitle + 1 : 0)
  assert.ok(
    used <= layout.list,
    `${label}: columns (${used}) must not exceed the list width (${layout.list})`,
  )
}

test("the palette budgets against the dialog panel, never the terminal", () => {
  // A very wide terminal must not widen the fixed-width dialog.
  const wide = paletteLayout({ size: "xlarge", width: 400, height: 60 })
  assert.equal(wide.outer, DIALOG_WIDTHS.xlarge, "the panel stays at its fixed width")
  assert.equal(wide.inner, DIALOG_WIDTHS.xlarge - PALETTE_PADDING * 2)

  const large = paletteLayout({ size: "large", width: 400, height: 60 })
  assert.equal(large.outer, DIALOG_WIDTHS.large)
  assert.ok(large.inner < wide.inner, "a smaller dialog has less usable width")
  // The large panel is too narrow for a preview, so its list reclaims that
  // space and is legitimately wider than the xlarge list.
  assert.equal(large.showPreview, false)
  assert.ok(large.list + large.preview <= large.inner)
})

test("a narrow terminal clamps the panel instead of overflowing it", () => {
  const layout = paletteLayout({ size: "xlarge", width: 60, height: 30 })
  assert.ok(layout.outer <= 58, "the panel must fit inside the terminal")
  assert.ok(layout.list <= layout.inner)
  assertColumnsFit(layout, "narrow")
})

test("columns always fit the list across the full size range", () => {
  for (let width = 24; width <= 400; width += 1) {
    for (const size of ["medium", "large", "xlarge"]) {
      const layout = paletteLayout({ size, width, height: 40 })
      assertColumnsFit(layout, `${size}@${width}`)
      assert.ok(layout.columns.title >= 6, `${size}@${width}: the title must stay readable`)
      assert.ok(layout.list >= 18)
      assert.equal(layout.panelHeight, layout.rows + 10)
      assert.ok(layout.panelHeight <= Math.max(13, 40 - 4), `${size}@${width}: panel body must remain bounded`)
    }
  }
})

test("titles keep a usable width at the sizes the palette actually uses", () => {
  // This is the regression: titles were collapsing to two or three characters.
  const layout = paletteLayout({ size: "xlarge", width: 140, height: 44 })
  assert.ok(
    layout.columns.title >= 24,
    `expected a readable title column, got ${layout.columns.title}`,
  )
  assert.ok(layout.columns.subtitle >= 12, "the subtitle must stay meaningful")
})

test("the preview only appears when the panel and finder mode can afford it", () => {
  assert.equal(paletteLayout({ size: "medium", width: 200, height: 40 }).showPreview, false)
  assert.equal(paletteLayout({ size: "xlarge", width: 200, height: 40 }).showPreview, true)
  assert.equal(paletteLayout({ size: "xlarge", width: 200, height: 40, preview: false }).showPreview, false, "folder destination mode reclaims the whole list width")
  // When hidden it must consume no width.
  assert.equal(paletteLayout({ size: "medium", width: 200, height: 40 }).preview, 0)
  assert.equal(paletteLayout({ size: "xlarge", width: 200, height: 40, preview: false }).preview, 0)
})

test("list and preview never exceed the inner panel width", () => {
  for (const size of ["medium", "large", "xlarge"]) {
    for (const width of [40, 80, 120, 200]) {
      const layout = paletteLayout({ size, width, height: 40 })
      const used = layout.list + layout.preview + layout.gap
      assert.equal(used, layout.inner, `${size}@${width}: ${used} must exactly equal inner ${layout.inner}`)
    }
  }
})

test("row height budget responds to the terminal height", () => {
  assert.ok(paletteLayout({ size: "xlarge", width: 120, height: 20 }).rows >= 3)
  assert.ok(
    paletteLayout({ size: "xlarge", width: 120, height: 60 }).rows >
      paletteLayout({ size: "xlarge", width: 120, height: 24 }).rows,
  )
  assert.ok(paletteLayout({ size: "xlarge", width: 120, height: 400 }).rows <= 16, "rows stay bounded")
})

test("the complete chooser panel owns one bounded rectangle", () => {
  for (const dimensions of [{ width: 120, height: 24 }, { width: 187, height: 50 }, { width: 60, height: 20 }]) {
    const layout = paletteLayout({ size: "xlarge", ...dimensions })
    assert.equal(layout.list + layout.preview + layout.gap, layout.inner)
    assert.equal(layout.outer - PALETTE_PADDING * 2, layout.inner)
    assert.equal(layout.panelHeight, layout.rows + 10)
    assert.ok(layout.panelHeight <= Math.max(13, dimensions.height - 4))
  }
})

test("padded columns render at exactly their declared width", () => {
  const layout = paletteLayout({ size: "xlarge", width: 140, height: 40 })
  const { title, subtitle, meta } = layout.columns
  // Short, exact, and overlong values must all occupy the same cell count.
  for (const value of ["", "short", "x".repeat(title), "y".repeat(title * 3)]) {
    assert.equal(pad(value, title).length, title, `title cell drifted for ${value.length} chars`)
  }
  assert.equal(pad("a".repeat(99), subtitle).length, subtitle)
  assert.equal(pad("12345678901234", meta, "right").length, meta)
})

test("unknown sizes fall back to a valid layout", () => {
  const layout = paletteLayout({ size: "nonsense", width: 120, height: 40 })
  assert.equal(layout.size, "xlarge")
  assertColumnsFit(layout, "fallback")
})

test("malformed input never throws", () => {
  for (const input of [undefined, {}, { width: NaN, height: null }, { width: -5, height: -5 }]) {
    assert.doesNotThrow(() => {
      const layout = paletteLayout(input)
      assertColumnsFit(layout, "malformed")
    })
  }
})
