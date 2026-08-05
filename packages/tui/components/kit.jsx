/** @jsxImportSource @opentui/solid */
import { createSignal } from "solid-js"

export function displayPath(path, max = 64) {
  const text = String(path ?? "")
  if (text.length <= max) return text
  return `…${text.slice(-(max - 1))}`
}

export function StatusGlyph({ status, skin }) {
  if (status === "SUCCESS") return <text fg={skin.success}>✓</text>
  if (status === "PARTIAL SUCCESS") return <text fg={skin.accent}>◐</text>
  if (status === "FAILED") return <text fg={skin.error}>✕</text>
  return <text fg={skin.muted}>?</text>
}

export function Badge({ text, color, skin }) {
  return (
    <text fg={color}>
      <b>[{text}]</b>
    </text>
  )
}

export function MetaLine({ skin, children }) {
  return <text fg={skin.muted}>{children}</text>
}

export function SectionHeader({ title, skin, color }) {
  return (
    <text fg={color ?? skin.accent}>
      <b>{title}</b>
    </text>
  )
}

export function Expandable({ header, children, skin, openDefault = false }) {
  const [open, setOpen] = createSignal(openDefault)
  return (
    <box flexDirection="column" gap={0}>
      <box
        flexDirection="row"
        gap={1}
        onClick={() => setOpen((value) => !value)}
      >
        <text fg={skin.muted}>{open() ? "[-]" : "[+]"}</text>
        {header}
      </box>
      {open() ? children : null}
    </box>
  )
}

export function MetaGrid({ skin, entries }) {
  return (
    <box paddingLeft={2} flexDirection="column" gap={0}>
      {entries
        .filter((entry) => entry && entry[1] !== null && entry[1] !== undefined && entry[1] !== "")
        .map((entry) => (
          <text fg={skin.muted}>
            <span style={{ fg: skin.text }}>{entry[0]}:</span> {String(entry[1]).slice(0, 120)}
          </text>
        ))}
    </box>
  )
}
