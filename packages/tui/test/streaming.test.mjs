import test from "node:test"
import assert from "node:assert/strict"
import {
  DEFAULT_STREAMING_SETTINGS,
  advanceRevealState,
  createRevealState,
  createStreamingController,
  createStreamingScheduler,
  normalizeStreamingSettings,
  readStreamingSettings,
  revealBudget,
  revealPending,
  segmentGraphemes,
  updateRevealState,
  visibleText,
  writeStreamingSettings,
} from "../lib/streaming.js"

test("grapheme segmentation never splits emoji or combining sequences", () => {
  assert.deepEqual(segmentGraphemes("A👨‍👩‍👧‍👦e\u0301🇮🇳"), ["A", "👨‍👩‍👧‍👦", "e\u0301", "🇮🇳"])
})

test("historical first observation is instant while an unfinished live part can animate its first provider chunk", () => {
  const historical = updateRevealState(createRevealState(), "Already here", { active: true, settings: DEFAULT_STREAMING_SETTINGS, now: 0 })
  assert.equal(visibleText(historical), "Already here")
  assert.equal(revealPending(historical), false)
  const live = updateRevealState(createRevealState(), "First provider chunk", { active: true, animateInitial: true, settings: DEFAULT_STREAMING_SETTINGS, now: 0 })
  assert.equal(visibleText(live), "")
  assert.equal(revealPending(live), true)
})

test("compatible appends animate while incompatible replacements flush", () => {
  let state = updateRevealState(createRevealState(), "Hello", { active: true, settings: DEFAULT_STREAMING_SETTINGS, now: 0 })
  state = updateRevealState(state, "Hello world", { active: true, settings: DEFAULT_STREAMING_SETTINGS, now: 10 })
  assert.equal(visibleText(state), "Hello")
  assert.equal(revealPending(state), true)
  state = updateRevealState(state, "Corrected", { active: true, settings: DEFAULT_STREAMING_SETTINGS, now: 20 })
  assert.equal(visibleText(state), "Corrected")
  assert.equal(state.replacement, true)
})

test("instant style, reduced motion, disabled mode, and abort flush immediately", () => {
  for (const settings of [
    { ...DEFAULT_STREAMING_SETTINGS, style: "instant" },
    { ...DEFAULT_STREAMING_SETTINGS, motion: "reduced" },
    { ...DEFAULT_STREAMING_SETTINGS, enabled: false },
  ]) {
    let state = updateRevealState(createRevealState(), "a", { active: true, settings, now: 0 })
    state = updateRevealState(state, "abcdef", { active: true, settings, now: 10 })
    assert.equal(visibleText(state), "abcdef")
  }
  let state = updateRevealState(createRevealState(), "a", { active: true, settings: DEFAULT_STREAMING_SETTINGS, now: 0 })
  state = updateRevealState(state, "abcdef", { active: true, settings: DEFAULT_STREAMING_SETTINGS, now: 10 })
  state = updateRevealState(state, "abcdef", { active: false, drain: false, settings: DEFAULT_STREAMING_SETTINGS, now: 11 })
  assert.equal(visibleText(state), "abcdef")
})

test("natural completion drains buffered text instead of erasing the animation before the first frame", () => {
  let state = updateRevealState(createRevealState(), "", { active: true, settings: DEFAULT_STREAMING_SETTINGS, now: 0 })
  state = updateRevealState(state, "A complete fast provider response.", { active: true, settings: DEFAULT_STREAMING_SETTINGS, now: 1 })
  assert.equal(visibleText(state), "")
  state = updateRevealState(state, "A complete fast provider response.", { active: false, drain: true, settings: DEFAULT_STREAMING_SETTINGS, now: 2 })
  assert.equal(visibleText(state), "")
  assert.equal(revealPending(state), true)
  state = advanceRevealState(state, { settings: DEFAULT_STREAMING_SETTINGS, now: 35, deltaMs: 33 })
  assert.ok(visibleText(state).length > 0)
  assert.ok(visibleText(state).length < state.source.length)
  state = advanceRevealState(state, { settings: DEFAULT_STREAMING_SETTINGS, now: 220, deltaMs: 33 })
  assert.equal(visibleText(state), state.source)
})

test("adaptive and cinematic budgets remain bounded by maximum visual delay", () => {
  let state = updateRevealState(createRevealState(), "a", { active: true, settings: DEFAULT_STREAMING_SETTINGS, now: 0 })
  state = updateRevealState(state, `a${"x".repeat(100)}`, { active: true, settings: DEFAULT_STREAMING_SETTINGS, now: 10 })
  assert.ok(revealBudget(state, { settings: DEFAULT_STREAMING_SETTINGS, now: 20, deltaMs: 33 }) >= 2)
  assert.equal(revealBudget(state, { settings: DEFAULT_STREAMING_SETTINGS, now: 200, deltaMs: 33 }), 100)
  const cinematic = normalizeStreamingSettings({ style: "cinematic", maxDelayMs: 400 })
  assert.ok(revealBudget(state, { settings: cinematic, now: 20, deltaMs: 33 }) >= 1)
})

test("cinematic mode adds a bounded punctuation beat without violating catch-up", () => {
  const settings = normalizeStreamingSettings({ style: "cinematic", maxDelayMs: 250 })
  let state = updateRevealState(createRevealState(), "Hi", { active: true, settings, now: 0 })
  state = updateRevealState(state, "Hi. Next", { active: true, settings, now: 1 })
  state = advanceRevealState(state, { settings, now: 2, deltaMs: 33 })
  while (visibleText(state) !== "Hi." && revealPending(state)) state = advanceRevealState(state, { settings, now: 3, deltaMs: 33 })
  const paused = advanceRevealState(state, { settings, now: 10, deltaMs: 33 })
  assert.equal(visibleText(paused), "Hi.")
  const resumed = advanceRevealState(paused, { settings, now: 100, deltaMs: 33 })
  assert.ok(visibleText(resumed).length > 3)
})

test("large fenced-code bursts accelerate instead of repainting one character forever", () => {
  let state = updateRevealState(createRevealState(), "```js\n", { active: true, settings: DEFAULT_STREAMING_SETTINGS, now: 0 })
  state = updateRevealState(state, `\`\`\`js\n${"const x = 1;\n".repeat(1000)}`, { active: true, settings: DEFAULT_STREAMING_SETTINGS, now: 10 })
  assert.ok(revealBudget(state, { settings: DEFAULT_STREAMING_SETTINGS, now: 20, deltaMs: 33 }) >= 8)
})

test("advance reaches the exact authoritative source with no grapheme loss", () => {
  const source = "Hello 👋🏽 world e\u0301"
  let state = updateRevealState(createRevealState(), "Hello", { active: true, settings: DEFAULT_STREAMING_SETTINGS, now: 0 })
  state = updateRevealState(state, source, { active: true, settings: DEFAULT_STREAMING_SETTINGS, now: 1 })
  for (let frame = 0; revealPending(state) && frame < 100; frame++) {
    state = advanceRevealState(state, { settings: DEFAULT_STREAMING_SETTINGS, now: frame * 33 + 2, deltaMs: 33 })
  }
  assert.equal(visibleText(state), source)
})

test("repeated provider chunks remain visibly progressive between arrivals", async () => {
  const frames = []
  const renderer = {
    setFrameCallback(callback) { frames.push(callback) },
    removeFrameCallback() {},
    requestLive() {},
    dropLive() {},
  }
  const scheduler = createStreamingScheduler(renderer, { watchdogMs: 500 })
  const seen = []
  let now = 0
  const controller = createStreamingController(scheduler, (text) => seen.push(text), { initial: "", now: () => now })
  controller.update("Hel", { active: true, settings: DEFAULT_STREAMING_SETTINGS, now: 0 })
  controller.update("Hello wor", { active: true, settings: DEFAULT_STREAMING_SETTINGS, now: 10 })
  assert.equal(seen.at(-1), "Hel")
  now = 33
  await frames[0](33)
  const betweenChunks = seen.at(-1)
  assert.ok(betweenChunks.length > 3 && betweenChunks.length < 9)
  controller.update("Hello world!", { active: true, settings: DEFAULT_STREAMING_SETTINGS, now: 43 })
  assert.equal(seen.at(-1), betweenChunks)
  controller.update("Hello world!", { active: false, drain: true, settings: DEFAULT_STREAMING_SETTINGS, now: 44 })
  assert.equal(seen.at(-1), betweenChunks)
  now = 77
  await frames[0](33)
  assert.ok(seen.at(-1).length > betweenChunks.length)
  assert.ok(seen.at(-1).length < "Hello world!".length)
  controller.flush()
  assert.equal(seen.at(-1), "Hello world!")
  controller.dispose()
  scheduler.dispose()
})

test("a complete short response received before mount still animates its first visible frame", () => {
  const settings = DEFAULT_STREAMING_SETTINGS
  let state = updateRevealState(createRevealState(), "Short answer.", { active: true, animateInitial: true, settings, now: 0 })
  state = updateRevealState(state, "Short answer.", { active: false, drain: true, settings, now: 1 })
  assert.equal(visibleText(state), "")
  state = advanceRevealState(state, { settings, now: 34, deltaMs: 33 })
  assert.ok(visibleText(state).length > 0)
  assert.ok(visibleText(state).length < "Short answer.".length)
})

test("shared scheduler owns one frame callback, one live lease, cleanup, and watchdog flush", async () => {
  const frames = []
  const renderer = {
    live: 0,
    setFrameCallback(callback) { frames.push(callback) },
    removeFrameCallback(callback) { assert.equal(frames[0], callback) },
    requestLive() { this.live++ },
    dropLive() { this.live-- },
  }
  const scheduler = createStreamingScheduler(renderer, { watchdogMs: 20 })
  const seen = []
  const controller = createStreamingController(scheduler, (text) => seen.push(text), { initial: "a" })
  controller.update("a", { active: true, settings: DEFAULT_STREAMING_SETTINGS, now: 0 })
  controller.update("abcdef", { active: true, settings: DEFAULT_STREAMING_SETTINGS, now: 1 })
  assert.equal(renderer.live, 1)
  await frames[0](33)
  assert.ok(seen.at(-1).length > 1)
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(seen.at(-1), "abcdef")
  controller.dispose()
  scheduler.dispose()
  assert.equal(renderer.live, 0)
})

test("scheduler failures degrade to exact instant text without throwing", () => {
  const scheduler = createStreamingScheduler({
    setFrameCallback() {},
    requestLive() { throw new Error("renderer unavailable") },
    dropLive() {},
  })
  let visible = ""
  const controller = createStreamingController(scheduler, (text) => { visible = text }, { initial: "a" })
  controller.update("a", { active: true, settings: DEFAULT_STREAMING_SETTINGS })
  controller.update("authoritative", { active: true, settings: DEFAULT_STREAMING_SETTINGS })
  assert.equal(visible, "authoritative")
  controller.dispose()
  scheduler.dispose()
})

test("a 100k-character answer remains exact and catches up in bounded frames", () => {
  const source = `start ${"x".repeat(100_000)} 👨‍👩‍👧‍👦 end`
  let state = updateRevealState(createRevealState(), "start ", { active: true, settings: DEFAULT_STREAMING_SETTINGS, now: 0 })
  state = updateRevealState(state, source, { active: true, settings: DEFAULT_STREAMING_SETTINGS, now: 1 })
  let frames = 0
  while (revealPending(state) && frames < 20) {
    frames++
    state = advanceRevealState(state, { settings: DEFAULT_STREAMING_SETTINGS, now: frames * 33, deltaMs: 33 })
  }
  assert.equal(visibleText(state), source)
  assert.ok(frames <= 7)
})

test("streaming settings are normalized and persisted through the shared KV boundary", () => {
  const store = new Map()
  const kv = { get: (key, fallback) => store.has(key) ? store.get(key) : fallback, set: (key, value) => store.set(key, value) }
  assert.deepEqual(readStreamingSettings(kv), DEFAULT_STREAMING_SETTINGS)
  const saved = writeStreamingSettings(kv, { style: "cinematic", maxDelayMs: 900, reasoning: true, tail: "off" })
  assert.equal(saved.changed, true)
  assert.equal(saved.value.maxDelayMs, 500)
  assert.equal(readStreamingSettings(kv).reasoning, true)
  assert.equal(writeStreamingSettings(kv, saved.value).changed, false)
})
