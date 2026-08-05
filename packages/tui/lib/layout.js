// Responsive geometry for the Alonix IDE.
//
// Terminal sizes vary far more than browser viewports, so layout decisions are
// centralised here as pure functions and verified directly.

export const BREAKPOINTS = {
  narrow: 76,
  standard: 108,
  wide: 148,
}

/** Classify the terminal width into a layout density. */
export function densityOf(width) {
  const value = Number(width) || 0
  if (value < BREAKPOINTS.narrow) return "compact"
  if (value < BREAKPOINTS.standard) return "standard"
  if (value < BREAKPOINTS.wide) return "wide"
  return "panoramic"
}

/**
 * Full-screen workbench geometry.
 *
 * Panels are dropped progressively as the terminal narrows so the primary
 * column never collapses below a usable width.
 */
export function workbenchLayout(dimensions = {}) {
  const width = Math.max(20, Math.floor(Number(dimensions.width) || 80))
  const height = Math.max(8, Math.floor(Number(dimensions.height) || 24))
  const density = densityOf(width)

  const showRail = density !== "compact"
  const rail = showRail ? 4 : 0
  const showExplorer = density !== "compact"
  const showDetail = density === "wide" || density === "panoramic"

  const explorer = showExplorer ? Math.max(24, Math.min(34, Math.round(width * 0.24))) : 0
  const detail = showDetail ? Math.max(28, Math.min(44, Math.round(width * 0.27))) : 0
  const main = Math.max(20, width - rail - explorer - detail)

  return {
    density,
    width,
    height,
    rail,
    explorer,
    detail,
    main,
    showRail,
    showExplorer,
    showDetail,
    // Rows reserved for the header and footer chrome of the workbench.
    headerHeight: density === "compact" ? 2 : 3,
    footerHeight: 1,
    bodyHeight: Math.max(3, height - (density === "compact" ? 2 : 3) - 1),
  }
}

/**
 * Command-palette style switcher geometry. The preview pane only appears when
 * there is genuinely room for it beside the list.
 */
export function switcherLayout(dimensions = {}) {
  const width = Math.max(20, Math.floor(Number(dimensions.width) || 80))
  const height = Math.max(8, Math.floor(Number(dimensions.height) || 24))
  const density = densityOf(width)
  const showPreview = density === "wide" || density === "panoramic"
  const inner = Math.max(18, Math.min(width - 8, 118))
  const preview = showPreview ? Math.max(30, Math.round(inner * 0.36)) : 0
  const list = Math.max(16, inner - preview - (showPreview ? 2 : 0))
  const rows = Math.max(3, Math.min(14, height - 12))
  return { density, inner, list, preview, showPreview, rows }
}

/** Sidebar panel geometry; the host reserves a fixed 42-column sidebar. */
export function inspectorLayout(width = 42) {
  const usable = Math.max(16, Math.floor(Number(width) || 42) - 4)
  return {
    usable,
    label: Math.max(10, usable - 12),
    gauge: Math.max(6, Math.min(18, usable - 14)),
    listRows: 6,
  }
}

/** Home deck geometry, matching the host prompt's 75-column comfort width. */
export function homeLayout(dimensions = {}) {
  const width = Math.max(20, Math.floor(Number(dimensions.width) || 80))
  const density = densityOf(width)
  const deck = Math.max(28, Math.min(width - 4, 75))
  const columns = density === "compact" ? 1 : density === "standard" ? 2 : 3
  return { density, deck, columns, cardWidth: Math.max(16, Math.floor((deck - (columns - 1) * 2) / columns)) }
}

/** Truncate to `width` cells with a trailing ellipsis. */
export function fit(text, width) {
  const value = String(text ?? "")
  const cells = Math.max(1, Math.floor(Number(width) || 1))
  if (value.length <= cells) return value
  if (cells === 1) return "…"
  return `${value.slice(0, cells - 1)}…`
}

/** Truncate from the left, keeping the meaningful tail of a path. */
export function fitLeft(text, width) {
  const value = String(text ?? "")
  const cells = Math.max(1, Math.floor(Number(width) || 1))
  if (value.length <= cells) return value
  if (cells === 1) return "…"
  return `…${value.slice(-(cells - 1))}`
}

/** Pad to an exact cell count so columns align in a monospace grid. */
export function pad(text, width, align = "left") {
  const cells = Math.max(0, Math.floor(Number(width) || 0))
  const value = fit(text, Math.max(1, cells))
  const missing = Math.max(0, cells - value.length)
  if (align === "right") return " ".repeat(missing) + value
  if (align === "center") {
    const left = Math.floor(missing / 2)
    return " ".repeat(left) + value + " ".repeat(missing - left)
  }
  return value + " ".repeat(missing)
}
