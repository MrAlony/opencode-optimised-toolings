// Design system for the Alonix IDE surfaces.
//
// Pure colour mathematics and token derivation. No renderer, Solid, or OpenTUI
// imports so the whole visual contract stays unit-testable and so tokens can be
// derived from any OpenCode theme (RGBA objects) or plain hex strings.

const HEX_PATTERN = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/

function clampByte(value) {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(255, Math.round(value)))
}

function channelToByte(value) {
  if (!Number.isFinite(value)) return null
  // OpenTUI RGBA stores normalised floats; hand-written colours may use 0-255.
  return value <= 1.0000001 ? clampByte(value * 255) : clampByte(value)
}

function fromHexString(text) {
  const match = HEX_PATTERN.exec(text.trim())
  if (!match) return null
  let body = match[1]
  if (body.length === 3) body = body[0] + body[0] + body[1] + body[1] + body[2] + body[2]
  return {
    r: Number.parseInt(body.slice(0, 2), 16),
    g: Number.parseInt(body.slice(2, 4), 16),
    b: Number.parseInt(body.slice(4, 6), 16),
  }
}

/**
 * Normalise any supported colour representation to `{ r, g, b }` byte channels.
 * Accepts hex strings, OpenTUI `RGBA` instances, and `{ r, g, b }` records in
 * either the 0-1 or 0-255 scale. Returns `null` when the value is unusable so
 * callers can fall back deliberately instead of rendering a wrong colour.
 */
export function toRgb(value) {
  if (value === null || value === undefined) return null
  if (typeof value === "string") return fromHexString(value)
  if (typeof value === "object") {
    const r = channelToByte(Number(value.r))
    const g = channelToByte(Number(value.g))
    const b = channelToByte(Number(value.b))
    if (r === null || g === null || b === null) {
      const text = typeof value.toString === "function" ? String(value) : ""
      return text.startsWith("#") ? fromHexString(text) : null
    }
    return { r, g, b }
  }
  return null
}

function hex2(value) {
  return clampByte(value).toString(16).padStart(2, "0")
}

/** Convert any supported colour to `#rrggbb`, or `fallback` when unusable. */
export function toHex(value, fallback = "#000000") {
  const rgb = toRgb(value)
  if (!rgb) return fallback
  return `#${hex2(rgb.r)}${hex2(rgb.g)}${hex2(rgb.b)}`
}

/** Linear blend: `t = 0` returns `from`, `t = 1` returns `to`. */
export function mix(from, to, t, fallback = "#000000") {
  const a = toRgb(from)
  const b = toRgb(to)
  if (!a) return toHex(to, fallback)
  if (!b) return toHex(from, fallback)
  const ratio = Math.max(0, Math.min(1, Number(t) || 0))
  return toHex({
    r: a.r + (b.r - a.r) * ratio,
    g: a.g + (b.g - a.g) * ratio,
    b: a.b + (b.b - a.b) * ratio,
  })
}

function linearChannel(byte) {
  const channel = byte / 255
  return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
}

/** WCAG relative luminance in the 0-1 range. */
export function luminance(value) {
  const rgb = toRgb(value)
  if (!rgb) return 0
  return 0.2126 * linearChannel(rgb.r) + 0.7152 * linearChannel(rgb.g) + 0.0722 * linearChannel(rgb.b)
}

/** WCAG contrast ratio between two colours (1 to 21). */
export function contrast(a, b) {
  const first = luminance(a)
  const second = luminance(b)
  const lighter = Math.max(first, second)
  const darker = Math.min(first, second)
  return (lighter + 0.05) / (darker + 0.05)
}

export function isDark(value) {
  return luminance(value) < 0.35
}

/**
 * Push `foreground` toward `ink` until it reaches `min` contrast against
 * `background`. Terminal themes vary wildly, so every semantic pairing we emit
 * runs through this instead of trusting the raw theme colour.
 */
export function ensureContrast(foreground, background, min = 3, ink = null) {
  const target = ink ?? (isDark(background) ? "#ffffff" : "#000000")
  let current = toHex(foreground, target)
  if (contrast(current, background) >= min) return current
  for (let step = 1; step <= 10; step += 1) {
    current = mix(foreground, target, step / 10)
    if (contrast(current, background) >= min) return current
  }
  return toHex(target)
}

/**
 * Surface elevation ladder. Higher levels move away from the canvas toward the
 * ink colour, which reads as "raised" in both dark and light terminals.
 */
export function elevate(base, level = 1, ink = null) {
  const target = ink ?? (isDark(base) ? "#ffffff" : "#000000")
  return mix(base, target, Math.max(0, level) * 0.045)
}

/** Simulate `alpha` transparency of `foreground` composited over `background`. */
export function overlay(background, foreground, alpha) {
  return mix(background, foreground, alpha)
}

export const GLYPH = {
  ok: "✓",
  fail: "✕",
  partial: "◐",
  pending: "◌",
  dot: "●",
  ring: "◇",
  diamond: "◆",
  square: "▪",
  caretRight: "›",
  caretDown: "▾",
  pointer: "▸",
  bullet: "•",
  arrow: "→",
  ellipsis: "…",
  branch: "⑂",
  plus: "+",
  minus: "-",
  bar: "│",
  rule: "─",
  cornerTopLeft: "╭",
  cornerTopRight: "╮",
  cornerBottomLeft: "╰",
  cornerBottomRight: "╯",
  blockFull: "█",
  blockEmpty: "░",
  // Close affordance for tabs and dismissible chips.
  close: "\u00d7",
  blockHalf: "▌",
  caret: "▌",
}

/** Vertical bar ramp used by gauges and sparklines, ascending by weight. */
export const RAMP = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"]

export const SPACING = {
  gutter: 1,
  panel: 1,
  section: 1,
  railWidth: 3,
}

const FALLBACK_THEME = {
  background: "#0f1115",
  backgroundPanel: "#161920",
  backgroundElement: "#1c202a",
  text: "#e7ebf3",
  textMuted: "#8b93a7",
  border: "#2b3140",
  borderActive: "#3d4459",
  primary: "#6d8cff",
  secondary: "#9d7bff",
  accent: "#4fd6be",
  success: "#63d18a",
  warning: "#e2b45e",
  error: "#f2707d",
  info: "#63b3ed",
}

function pick(theme, name, fallback) {
  const value = theme?.[name]
  const hex = toHex(value, "")
  return hex || fallback
}

function semantic(name, colour, canvas, panel, ink) {
  const surface = mix(panel, colour, 0.16)
  const surfaceHover = mix(panel, colour, 0.26)
  return {
    [name]: ensureContrast(colour, canvas, 3.2, ink),
    [`${name}On`]: ensureContrast(colour, surface, 3.2, ink),
    [`${name}Surface`]: surface,
    [`${name}SurfaceHover`]: surfaceHover,
    [`${name}Border`]: mix(panel, colour, 0.42),
  }
}

/**
 * Derive the complete IDE token set from an OpenCode theme map.
 *
 * Every token is a plain `#rrggbb` string so it can be handed directly to
 * OpenTUI props, and every foreground/background pairing is contrast-checked
 * against the actual theme rather than assumed.
 */
export function createTokens(theme, options = {}) {
  const source = theme && typeof theme === "object" ? theme : {}
  const canvas = pick(source, "background", FALLBACK_THEME.background)
  const ink = isDark(canvas) ? "#ffffff" : "#000000"
  const panel = pick(source, "backgroundPanel", elevate(canvas, 1, ink))
  const element = pick(source, "backgroundElement", elevate(panel, 1, ink))
  const menu = pick(source, "backgroundMenu", elevate(element, 1, ink))
  const text = pick(source, "text", FALLBACK_THEME.text)
  const muted = pick(source, "textMuted", mix(text, canvas, 0.42))
  const border = pick(source, "border", mix(panel, ink, 0.14))
  const borderActive = pick(source, "borderActive", mix(panel, ink, 0.3))
  const accent = pick(source, "primary", FALLBACK_THEME.primary)
  const secondary = pick(source, "secondary", accent)
  const highlight = pick(source, "accent", secondary)

  const tokens = {
    mode: isDark(canvas) ? "dark" : "light",
    ink,

    canvas,
    panel,
    surface: element,
    raised: menu,
    overlay: elevate(menu, 1, ink),
    inset: mix(canvas, ink, isDark(canvas) ? 0.02 : 0.05),
    rail: mix(canvas, panel, 0.7),

    text,
    muted,
    faint: mix(muted, canvas, 0.42),
    inverse: isDark(canvas) ? "#0b0d12" : "#f7f9fc",

    border,
    borderStrong: borderActive,
    borderFaint: mix(border, canvas, 0.5),

    accent: ensureContrast(accent, canvas, 3.2, ink),
    accentOn: ensureContrast(accent, mix(panel, accent, 0.16), 3.2, ink),
    accentSurface: mix(panel, accent, 0.16),
    accentSurfaceHover: mix(panel, accent, 0.28),
    accentBorder: mix(panel, accent, 0.45),
    accentInk: ensureContrast(isDark(accent) ? "#ffffff" : "#000000", accent, 4, null),

    secondary: ensureContrast(secondary, canvas, 3.2, ink),
    highlight: ensureContrast(highlight, canvas, 3.2, ink),

    selection: mix(panel, accent, 0.22),
    selectionStrong: mix(panel, accent, 0.34),
    hover: elevate(element, 1, ink),
    scrim: mix(canvas, isDark(canvas) ? "#000000" : "#ffffff", 0.35),

    added: pick(source, "diffAdded", pick(source, "success", FALLBACK_THEME.success)),
    removed: pick(source, "diffRemoved", pick(source, "error", FALLBACK_THEME.error)),
  }

  Object.assign(tokens, semantic("success", pick(source, "success", FALLBACK_THEME.success), canvas, panel, ink))
  Object.assign(tokens, semantic("warning", pick(source, "warning", FALLBACK_THEME.warning), canvas, panel, ink))
  Object.assign(tokens, semantic("error", pick(source, "error", FALLBACK_THEME.error), canvas, panel, ink))
  Object.assign(tokens, semantic("info", pick(source, "info", FALLBACK_THEME.info), canvas, panel, ink))

  tokens.motion = options.motion !== false
  tokens.section = tokens.faint
  return tokens
}

/** Status name -> token family used across activities, rails, and badges. */
export function toneOf(status) {
  if (status === "SUCCESS" || status === "ready" || status === "connected" || status === "completed") return "success"
  if (status === "FAILED" || status === "error" || status === "failed") return "error"
  if (status === "RUNNING" || status === "PENDING" || status === "busy" || status === "active" || status === "retry")
    return "accent"
  if (status === "warning" || status === "degraded") return "warning"
  return "warning"
}

/** Resolve a tone family to concrete `{ fg, surface, surfaceHover, border }`. */
export function tonePalette(tokens, tone) {
  if (tone === "accent") {
    return {
      fg: tokens.accent,
      on: tokens.accentOn,
      surface: tokens.accentSurface,
      surfaceHover: tokens.accentSurfaceHover,
      border: tokens.accentBorder,
    }
  }
  if (tone === "neutral") {
    return {
      fg: tokens.muted,
      on: tokens.text,
      surface: tokens.surface,
      surfaceHover: tokens.hover,
      border: tokens.border,
    }
  }
  return {
    fg: tokens[tone] ?? tokens.muted,
    on: tokens[`${tone}On`] ?? tokens.text,
    surface: tokens[`${tone}Surface`] ?? tokens.surface,
    surfaceHover: tokens[`${tone}SurfaceHover`] ?? tokens.hover,
    border: tokens[`${tone}Border`] ?? tokens.border,
  }
}
