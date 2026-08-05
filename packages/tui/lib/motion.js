// Motion primitives for the Alonix IDE.
//
// Every animation is a pure function of elapsed milliseconds so the visual
// result is deterministic and testable, and so a single shared clock can drive
// the whole interface instead of one timer per component.

export const EASING = {
  linear: (t) => t,
  inQuad: (t) => t * t,
  outQuad: (t) => t * (2 - t),
  inOutQuad: (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
  outCubic: (t) => 1 - (1 - t) ** 3,
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  outExpo: (t) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t)),
  outBack: (t) => 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2,
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

/** Normalised 0..1 progress of a looping period. */
export function phase(elapsed, period) {
  const span = Number(period) || 1
  const time = Number(elapsed) || 0
  return ((time % span) + span) % span / span
}

/** Eased 0..1..0 triangle wave; the basis for every pulse in the UI. */
export function pulse(elapsed, period = 1600, ease = EASING.inOutQuad) {
  const value = phase(elapsed, period)
  return ease(value < 0.5 ? value * 2 : (1 - value) * 2)
}

/** Advance a one-shot 0..1 transition. */
export function progress(elapsed, duration = 240, ease = EASING.outCubic) {
  if (!Number.isFinite(duration) || duration <= 0) return 1
  return ease(clamp01((Number(elapsed) || 0) / duration))
}

export const SPINNERS = {
  orbit: ["◜", "◝", "◞", "◟"],
  moon: ["◌", "◔", "◑", "◕", "●", "◕", "◑", "◔"],
  braille: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  bar: ["▁", "▃", "▄", "▅", "▆", "▇", "▆", "▅", "▄", "▃"],
  dot: ["·", "•", "●", "•"],
}

/** Pick the spinner frame for the elapsed time, honouring reduced motion. */
export function spinnerFrame(elapsed, frames = SPINNERS.braille, interval = 90, motion = true) {
  const list = Array.isArray(frames) && frames.length ? frames : SPINNERS.braille
  if (motion === false) return list[0]
  const step = Math.max(1, Number(interval) || 90)
  const index = Math.floor((Number(elapsed) || 0) / step) % list.length
  return list[index]
}

/**
 * Determinate progress bar. `percent` is 0..100; the trailing cell uses a
 * partial block so slow builds still show sub-cell movement.
 */
export function progressBar(percent, width = 20, filled = "█", empty = "░") {
  const cells = Math.max(1, Math.floor(Number(width) || 1))
  const ratio = clamp01((Number(percent) || 0) / 100)
  const exact = ratio * cells
  const whole = Math.floor(exact)
  const remainder = exact - whole
  const partial = remainder > 0.66 ? "▊" : remainder > 0.33 ? "▌" : remainder > 0.08 ? "▎" : ""
  const head = filled.repeat(Math.min(whole, cells))
  const tail = partial && whole < cells ? partial : ""
  return (head + tail + empty.repeat(Math.max(0, cells - whole - tail.length))).slice(0, cells)
}

/**
 * Indeterminate activity bar: a lit band sweeping across the track. Used when
 * work is running but no percentage is known.
 */
export function sweepBar(elapsed, width = 20, motion = true, band = 4) {
  const cells = Math.max(1, Math.floor(Number(width) || 1))
  const size = Math.max(1, Math.min(band, cells))
  if (motion === false) return "─".repeat(cells)
  const travel = cells + size
  const head = Math.floor(phase(elapsed, 1400) * travel) - size
  let out = ""
  for (let index = 0; index < cells; index += 1) {
    const distance = index - head
    out += distance >= 0 && distance < size ? "█" : "─"
  }
  return out
}

/** Render numeric samples as a bar sparkline of exactly `width` cells. */
export function sparkline(values, width = 12, ramp = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"]) {
  const cells = Math.max(1, Math.floor(Number(width) || 1))
  const list = Array.from(values ?? [])
    .map((value) => (Number.isFinite(Number(value)) ? Number(value) : 0))
    .slice(-cells)
  if (!list.length) return ramp[0].repeat(cells)
  const max = Math.max(...list)
  const min = Math.min(...list)
  const span = max - min || 1
  const rendered = list.map((value) => ramp[Math.min(ramp.length - 1, Math.floor(((value - min) / span) * (ramp.length - 1)))])
  return ramp[0].repeat(Math.max(0, cells - rendered.length)) + rendered.join("")
}

/** Reveal `text` progressively; returns the whole string when motion is off. */
export function typewriter(text, elapsed, charsPerSecond = 42, motion = true) {
  const value = String(text ?? "")
  if (motion === false || charsPerSecond <= 0) return value
  const visible = Math.floor(((Number(elapsed) || 0) / 1000) * charsPerSecond)
  return value.slice(0, Math.max(0, Math.min(value.length, visible)))
}

/**
 * Horizontal marquee for labels wider than the available cells. Holds at the
 * start and end so the text is readable rather than permanently sliding.
 */
export function marquee(text, width, elapsed, motion = true) {
  const value = String(text ?? "")
  const cells = Math.max(1, Math.floor(Number(width) || 1))
  if (value.length <= cells) return value
  if (motion === false) return `${value.slice(0, Math.max(1, cells - 1))}…`
  const overflow = value.length - cells
  const cycle = 2200 + overflow * 130
  const point = phase(elapsed, cycle)
  const hold = 0.18
  let travel = 0
  if (point < hold) travel = 0
  else if (point < 0.5) travel = EASING.inOutQuad((point - hold) / (0.5 - hold))
  else if (point < 0.5 + hold) travel = 1
  else travel = 1 - EASING.inOutQuad((point - 0.5 - hold) / (0.5 - hold))
  const offset = Math.round(travel * overflow)
  return value.slice(offset, offset + cells)
}

/**
 * Staggered entrance progress for list items so panels cascade instead of
 * appearing all at once.
 */
export function stagger(elapsed, index, step = 45, duration = 260) {
  return progress((Number(elapsed) || 0) - index * step, duration, EASING.outCubic)
}

/** Map 0..1 entrance progress to an indent so rows slide into place. */
export function slideIn(value, distance = 2) {
  return Math.max(0, Math.round((1 - clamp01(value)) * distance))
}
