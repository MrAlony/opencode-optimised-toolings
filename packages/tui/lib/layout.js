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
 * Host dialog widths. `ui/dialog.tsx` renders a fixed-width panel, so any
 * surface inside a dialog must budget against these numbers rather than the
 * terminal width. Sizing against the terminal overflows the panel and lets the
 * renderer shrink labels to a few characters.
 */
export const DIALOG_WIDTHS = { medium: 60, large: 88, xlarge: 116 }

/** Horizontal padding the palette applies inside the dialog panel. */
export const PALETTE_PADDING = 2

/**
 * Palette geometry with exact column arithmetic.
 *
 * Every column is resolved to a whole number of cells that sums to the list
 * width, so rows can be rendered as fixed-width text and clipped predictably
 * instead of being shrunk by flex layout.
 */
export function paletteLayout(options = {}) {
  const size = DIALOG_WIDTHS[options.size] ? options.size : "xlarge"
  const terminalWidth = Math.max(20, Math.floor(Number(options.width) || 80))
  const terminalHeight = Math.max(8, Math.floor(Number(options.height) || 24))

  // The dialog is fixed width but still clamped to the terminal.
  const outer = Math.max(24, Math.min(DIALOG_WIDTHS[size], terminalWidth - 2))
  const inner = Math.max(20, outer - PALETTE_PADDING * 2)

  const showPreview = inner >= 92
  const preview = showPreview ? Math.max(26, Math.min(38, Math.round(inner * 0.32))) : 0
  const list = Math.max(18, inner - preview - (showPreview ? 2 : 0))

  // Leading cells: selection bar, kind glyph, quick-jump slot, plus the single
  // space that separates each of them from the next.
  const gutter = 1
  const glyph = 1
  const slot = 1
  const gaps = 3
  const meta = list >= 54 ? 9 : 0
  const body = Math.max(8, list - gutter - glyph - slot - gaps - meta)
  const subtitle = body >= 42 ? Math.round(body * 0.36) : 0
  const title = Math.max(6, body - subtitle - (subtitle ? 1 : 0))

  return {
    size,
    outer,
    inner,
    list,
    preview,
    showPreview,
    rows: Math.max(3, Math.min(16, terminalHeight - 14)),
    columns: { gutter, glyph, slot, gaps, meta, body, title, subtitle },
  }
}

/**
 * Switcher geometry for surfaces rendered inside a host dialog.
 *
 * Delegates to `paletteLayout` so dialog-hosted surfaces share one panel-aware
 * sizing model. Sizing against the terminal instead of the dialog panel
 * overflows the fixed-width container and lets the renderer shrink labels to a
 * few characters, so the dialog size is the authority here.
 */
export function switcherLayout(dimensions = {}, size = "xlarge") {
  const width = Math.max(20, Math.floor(Number(dimensions.width) || 80))
  const height = Math.max(8, Math.floor(Number(dimensions.height) || 24))
  const layout = paletteLayout({ size, width, height })
  return {
    density: densityOf(width),
    inner: layout.inner,
    list: layout.list,
    preview: layout.preview,
    showPreview: layout.showPreview,
    rows: layout.rows,
    columns: layout.columns,
  }
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
