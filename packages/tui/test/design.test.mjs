import test from "node:test"
import assert from "node:assert/strict"
import { GLYPH, contrast, createTokens, elevate, ensureContrast, isDark, luminance, mix, toHex, toRgb, tonePalette, toneOf } from "../lib/design.js"

test("colour parsing accepts hex, RGBA-style floats, and byte records", () => {
  assert.deepEqual(toRgb("#ff8800"), { r: 255, g: 136, b: 0 })
  assert.deepEqual(toRgb("#f80"), { r: 255, g: 136, b: 0 })
  assert.deepEqual(toRgb({ r: 1, g: 0, b: 0.5 }), { r: 255, g: 0, b: 128 })
  assert.deepEqual(toRgb({ r: 255, g: 136, b: 0 }), { r: 255, g: 136, b: 0 })
  assert.equal(toRgb("not-a-colour"), null)
  assert.equal(toRgb(undefined), null)
  assert.equal(toHex("nope", "#123456"), "#123456")
})

test("mix interpolates and clamps the ratio", () => {
  assert.equal(mix("#000000", "#ffffff", 0), "#000000")
  assert.equal(mix("#000000", "#ffffff", 1), "#ffffff")
  assert.equal(mix("#000000", "#ffffff", 0.5), "#808080")
  assert.equal(mix("#000000", "#ffffff", 5), "#ffffff")
})

test("luminance and contrast follow WCAG expectations", () => {
  assert.equal(Math.round(luminance("#000000") * 100), 0)
  assert.equal(Math.round(luminance("#ffffff") * 100), 100)
  assert.equal(Math.round(contrast("#000000", "#ffffff")), 21)
  assert.ok(isDark("#101014"))
  assert.ok(!isDark("#f4f6fb"))
})

test("ensureContrast lifts unreadable pairings to the requested ratio", () => {
  const fixed = ensureContrast("#202020", "#101010", 4)
  assert.ok(contrast(fixed, "#101010") >= 4, `expected >=4, got ${contrast(fixed, "#101010")}`)
  const light = ensureContrast("#eeeeee", "#ffffff", 4)
  assert.ok(contrast(light, "#ffffff") >= 4)
  // Already-compliant colours are preserved.
  assert.equal(ensureContrast("#ffffff", "#000000", 4), "#ffffff")
})

test("elevate moves away from the canvas in both modes", () => {
  assert.ok(luminance(elevate("#000000", 2)) > luminance("#000000"))
  assert.ok(luminance(elevate("#ffffff", 2)) < luminance("#ffffff"))
})

test("tokens derive a complete contrast-safe palette from a theme", () => {
  const tokens = createTokens({
    background: "#0b0d12",
    backgroundPanel: "#12151d",
    text: "#e6e9f0",
    textMuted: "#7f8798",
    primary: "#6d8cff",
    success: "#3fae6a",
    warning: "#c9973f",
    error: "#d9455a",
  })
  assert.equal(tokens.mode, "dark")
  for (const key of ["canvas", "panel", "surface", "text", "muted", "accent", "success", "warning", "error", "info"]) {
    assert.match(tokens[key], /^#[0-9a-f]{6}$/, `${key} must be a hex token`)
  }
  for (const tone of ["success", "warning", "error", "info"]) {
    assert.ok(contrast(tokens[tone], tokens.canvas) >= 3, `${tone} must be readable on the canvas`)
    assert.ok(contrast(tokens[`${tone}On`], tokens[`${tone}Surface`]) >= 3, `${tone} must be readable on its surface`)
  }
  assert.ok(contrast(tokens.accent, tokens.canvas) >= 3)
})

test("tokens survive an empty or hostile theme without throwing", () => {
  for (const theme of [undefined, null, {}, { background: "garbage", text: 42 }]) {
    const tokens = createTokens(theme)
    assert.match(tokens.canvas, /^#[0-9a-f]{6}$/)
    assert.match(tokens.text, /^#[0-9a-f]{6}$/)
  }
})

test("light themes are detected and keep readable foregrounds", () => {
  const tokens = createTokens({ background: "#fbfcfe", text: "#1d2230", primary: "#2f6bff" })
  assert.equal(tokens.mode, "light")
  assert.ok(contrast(tokens.text, tokens.canvas) >= 4)
  assert.ok(luminance(tokens.panel) < luminance(tokens.canvas) + 0.01)
})

test("tone mapping resolves status names to palettes", () => {
  assert.equal(toneOf("SUCCESS"), "success")
  assert.equal(toneOf("FAILED"), "error")
  assert.equal(toneOf("RUNNING"), "accent")
  assert.equal(toneOf("busy"), "accent")
  const tokens = createTokens({ background: "#0b0d12" })
  const palette = tonePalette(tokens, "success")
  assert.ok(palette.fg && palette.surface && palette.border)
  const neutral = tonePalette(tokens, "neutral")
  assert.equal(neutral.fg, tokens.muted)
})

test("glyph vocabulary stays single-cell for terminal alignment", () => {
  for (const [name, glyph] of Object.entries(GLYPH)) {
    assert.equal([...glyph].length, 1, `${name} must be one code point`)
  }
})
