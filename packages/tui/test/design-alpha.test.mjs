import test from "node:test"
import assert from "node:assert/strict"
import { alphaOf, createTokens, isTranslucent, opaque, toHex } from "../lib/design.js"

test("alpha is read from every supported colour form", () => {
  assert.equal(alphaOf("#112233"), 1, "a plain hex colour is opaque")
  assert.equal(alphaOf("#11223300"), 0, "fully transparent")
  assert.equal(Math.round(alphaOf("#11223380") * 100), 50)
  // OpenTUI RGBA uses normalised floats.
  assert.equal(alphaOf({ r: 0.1, g: 0.2, b: 0.3, a: 0.5 }), 0.5)
  // Byte-scale alpha is normalised too.
  assert.equal(alphaOf({ r: 10, g: 20, b: 30, a: 255 }), 1)
  // Absent or unusable alpha defaults to opaque, never to invisible.
  assert.equal(alphaOf({ r: 1, g: 1, b: 1 }), 1)
  assert.equal(alphaOf(null), 1)
  assert.equal(alphaOf(undefined), 1)
  assert.equal(alphaOf("not a colour"), 1)
})

test("translucency is detected so surfaces can compensate", () => {
  assert.equal(isTranslucent("#11223300"), true)
  assert.equal(isTranslucent("#11223380"), true)
  assert.equal(isTranslucent("#112233"), false)
  assert.equal(isTranslucent({ r: 0, g: 0, b: 0, a: 1 }), false)
})

test("an opaque colour composites over the given base", () => {
  // Fully transparent resolves to the base.
  assert.equal(opaque("#ffffff00", "#000000"), "#000000")
  // Fully opaque is unchanged.
  assert.equal(opaque("#ffffff", "#000000"), "#ffffff")
  // Half transparent white over black is mid grey.
  const half = opaque("#ffffff80", "#000000")
  assert.match(half, /^#7f7f7f|#808080$/)
  // An already-opaque value round-trips.
  assert.equal(opaque("#123456", "#ffffff"), toHex("#123456"))
})

test("tokens expose opaque variants for full-screen surfaces", () => {
  // A translucent theme background must still yield a paintable colour, or a
  // full-screen route shows whatever was on the terminal behind it.
  const tokens = createTokens({ background: "#00000000", text: "#ffffff" })
  assert.equal(tokens.translucent, true)
  assert.equal(isTranslucent(tokens.canvasOpaque), false, "the opaque canvas must be paintable")
  assert.equal(isTranslucent(tokens.panelOpaque), false)
  assert.match(tokens.canvasOpaque, /^#[0-9a-f]{6}$/)
})

test("an opaque theme reports no translucency and keeps its colour", () => {
  const tokens = createTokens({ background: "#101214", text: "#ffffff" })
  assert.equal(tokens.translucent, false)
  assert.equal(tokens.canvasOpaque, "#101214")
})

test("a translucent light theme composites toward light, not black", () => {
  const tokens = createTokens({ background: "#ffffff00", text: "#000000" })
  // The fallback base must follow the theme's own polarity.
  assert.equal(tokens.mode, "light")
  assert.equal(isTranslucent(tokens.canvasOpaque), false)
})
