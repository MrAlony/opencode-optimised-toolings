// Keyboard interpretation for the Alonix IDE.
//
// Key handling is expressed as pure reducers so navigation and editing
// semantics can be verified without a terminal.

function keyName(event) {
  return String(event?.name ?? event?.key ?? "").toLowerCase()
}

function printable(event) {
  if (event?.ctrl || event?.meta) return ""
  const sequence = typeof event?.sequence === "string" ? event.sequence : ""
  const candidate = sequence || (keyName(event).length === 1 ? String(event.name) : "")
  if (candidate.length !== 1) return ""
  const code = candidate.codePointAt(0)
  if (code < 0x20 || code === 0x7f) return ""
  return event?.shift && candidate.length === 1 && sequence === "" ? candidate.toUpperCase() : candidate
}

/** Normalise a key event into a stable action name for the IDE surfaces. */
export function classifyKey(event) {
  const name = keyName(event)
  if (name === "escape") return "dismiss"
  if (name === "return" || name === "enter") return "confirm"
  if (name === "tab") return event?.shift ? "prev-pane" : "next-pane"
  if (name === "up" || (event?.ctrl && name === "p")) return "up"
  if (name === "down" || (event?.ctrl && name === "n")) return "down"
  if (name === "left") return "left"
  if (name === "right") return "right"
  if (name === "pageup") return "page-up"
  if (name === "pagedown") return "page-down"
  if (name === "home") return "first"
  if (name === "end") return "last"
  if (name === "backspace") return "delete-back"
  if (name === "delete") return "delete-forward"
  if (event?.ctrl && name === "u") return "clear"
  if (event?.ctrl && name === "w") return "delete-word"
  if (event?.ctrl && name === "d") return "remove"
  if (printable(event)) return "insert"
  return "ignore"
}

/** Apply an editing key to a query string. Returns the same string when inert. */
export function applyKeyToQuery(query, event) {
  const value = String(query ?? "")
  switch (classifyKey(event)) {
    case "insert":
      return value + printable(event)
    case "delete-back":
      return value.slice(0, -1)
    case "clear":
      return ""
    case "delete-word":
      return value.replace(/\s*\S+\s*$/, "")
    default:
      return value
  }
}

/** Move a selection index within `length`, wrapping at both ends. */
export function moveIndex(index, length, action, page = 5) {
  const size = Math.max(0, Math.floor(Number(length) || 0))
  if (size === 0) return 0
  const current = Math.max(0, Math.min(size - 1, Math.floor(Number(index) || 0)))
  switch (action) {
    case "up":
      return (current - 1 + size) % size
    case "down":
      return (current + 1) % size
    case "page-up":
      return Math.max(0, current - page)
    case "page-down":
      return Math.min(size - 1, current + page)
    case "first":
      return 0
    case "last":
      return size - 1
    default:
      return current
  }
}

/**
 * Keep the selected row inside a scrolling viewport, returning the new scroll
 * offset. Used so long session lists follow the cursor without jumping.
 */
export function scrollWindow(offset, index, visible, total) {
  const size = Math.max(1, Math.floor(Number(visible) || 1))
  const count = Math.max(0, Math.floor(Number(total) || 0))
  const cursor = Math.max(0, Math.min(Math.max(0, count - 1), Math.floor(Number(index) || 0)))
  let start = Math.max(0, Math.min(Math.floor(Number(offset) || 0), Math.max(0, count - size)))
  if (cursor < start) start = cursor
  if (cursor >= start + size) start = cursor - size + 1
  return Math.max(0, Math.min(start, Math.max(0, count - size)))
}
