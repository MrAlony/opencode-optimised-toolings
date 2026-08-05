import test from "node:test"
import assert from "node:assert/strict"
import {
  EASING,
  SPINNERS,
  marquee,
  phase,
  progress,
  progressBar,
  pulse,
  slideIn,
  sparkline,
  spinnerFrame,
  stagger,
  sweepBar,
  typewriter,
} from "../lib/motion.js"

test("easing functions stay inside the unit interval at the endpoints", () => {
  for (const [name, ease] of Object.entries(EASING)) {
    assert.ok(Math.abs(ease(0)) < 0.001, `${name}(0) should be ~0`)
    assert.ok(Math.abs(ease(1) - 1) < 0.001, `${name}(1) should be ~1`)
  }
})

test("phase wraps a looping period and handles negatives", () => {
  assert.equal(phase(0, 1000), 0)
  assert.equal(phase(500, 1000), 0.5)
  assert.equal(phase(1500, 1000), 0.5)
  assert.equal(phase(-500, 1000), 0.5)
})

test("pulse produces a smooth 0..1..0 triangle", () => {
  assert.ok(pulse(0, 1000) < 0.01)
  assert.ok(pulse(500, 1000) > 0.99)
  assert.ok(pulse(1000, 1000) < 0.01)
})

test("progress completes and clamps", () => {
  assert.equal(progress(0, 200), 0)
  assert.equal(progress(200, 200), 1)
  assert.equal(progress(9999, 200), 1)
  assert.equal(progress(50, 0), 1)
})

test("spinner frames advance and freeze when motion is disabled", () => {
  const first = spinnerFrame(0, SPINNERS.braille, 90, true)
  const later = spinnerFrame(90, SPINNERS.braille, 90, true)
  assert.notEqual(first, later)
  assert.equal(spinnerFrame(9999, SPINNERS.braille, 90, false), SPINNERS.braille[0])
  assert.equal(spinnerFrame(0, [], 90, true), SPINNERS.braille[0])
})

test("progressBar renders exact widths at every fill level", () => {
  for (const percent of [0, 1, 33, 50, 99, 100, 150, -20]) {
    assert.equal([...progressBar(percent, 20)].length, 20, `width must hold at ${percent}%`)
  }
  assert.equal(progressBar(100, 5), "█████")
  assert.equal(progressBar(0, 5), "░░░░░")
})

test("sweepBar keeps an exact width and moves over time", () => {
  assert.equal([...sweepBar(0, 24, true)].length, 24)
  assert.equal([...sweepBar(700, 24, true)].length, 24)
  assert.notEqual(sweepBar(0, 24, true), sweepBar(700, 24, true))
  assert.equal(sweepBar(0, 10, false), "─".repeat(10))
})

test("sparkline pads to the requested width and scales samples", () => {
  assert.equal([...sparkline([1, 2, 3], 8)].length, 8)
  assert.equal([...sparkline([], 6)].length, 6)
  const rendered = sparkline([0, 10], 2)
  assert.equal([...rendered].length, 2)
  assert.notEqual([...rendered][0], [...rendered][1])
})

test("typewriter reveals progressively and completes instantly without motion", () => {
  assert.equal(typewriter("hello", 0, 42, true), "")
  assert.equal(typewriter("hello", 10_000, 42, true), "hello")
  assert.equal(typewriter("hello", 0, 42, false), "hello")
})

test("marquee only scrolls overflowing text and never exceeds the width", () => {
  assert.equal(marquee("short", 20, 0, true), "short")
  const long = "a-really-long-session-title-that-overflows"
  for (const elapsed of [0, 400, 1200, 2600, 4000]) {
    assert.ok([...marquee(long, 12, elapsed, true)].length <= 12)
  }
  assert.ok(marquee(long, 12, 0, false).endsWith("…"))
})

test("stagger delays later rows and slideIn converts progress to indent", () => {
  assert.ok(stagger(0, 0) >= stagger(0, 3))
  assert.equal(stagger(10_000, 5), 1)
  assert.equal(slideIn(1, 2), 0)
  assert.equal(slideIn(0, 2), 2)
})
