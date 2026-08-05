/** @jsxImportSource @opentui/solid */
import { createEffect, createSignal, onCleanup } from "solid-js"

export function displayPath(path, max = 64) {
  const text = String(path ?? "")
  if (text.length <= max) return text
  return `…${text.slice(-(max - 1))}`
}

export function statusTone(status, skin) {
  if (status === "SUCCESS") return skin.success
  if (status === "FAILED") return skin.error
  return skin.accent
}

export function StatusGlyph({ status, skin, pending = false }) {
  const frames = ["◌", "◔", "◑", "◕"]
  const [frame, setFrame] = createSignal(0)
  createEffect(() => {
    if (!pending || skin.motion === false) return
    const timer = setInterval(() => setFrame((value) => (value + 1) % frames.length), 140)
    onCleanup(() => clearInterval(timer))
  })
  if (pending) return <text fg={skin.accent}>{skin.motion === false ? frames[0] : frames[frame()]}</text>
  if (status === "SUCCESS") return <text fg={skin.success}>✓</text>
  if (status === "PARTIAL SUCCESS") return <text fg={skin.accent}>◐</text>
  if (status === "FAILED") return <text fg={skin.error}>✕</text>
  return <text fg={skin.muted}>·</text>
}

export function Badge({ text, color }) {
  return <text fg={color}>{String(text).toLowerCase()}</text>
}

export function MetaLine({ skin, children }) {
  return <text fg={skin.muted}>{children}</text>
}

export function SectionHeader({ title, skin, color }) {
  return <text fg={color ?? skin.accent}><b>{title}</b></text>
}

function isToggleKey(event) {
  const name = String(event?.name ?? event?.key ?? "").toLowerCase()
  return name === "return" || name === "enter" || name === "space" || name === " "
}

export function Activity({ label, summary, meta, status, skin, children, openDefault = false, pending = false }) {
  const expandable = children !== undefined && children !== null
  const [open, setOpen] = createSignal(openDefault || status === "FAILED")
  const [active, setActive] = createSignal(false)
  const toggle = (event) => {
    if (!expandable) return
    event?.stopPropagation?.()
    setOpen((value) => !value)
  }
  const tone = () => statusTone(status, skin)
  return (
    <box
      flexDirection="column"
      flexShrink={0}
      paddingLeft={1}
      paddingRight={1}
      paddingTop={0}
      paddingBottom={open() ? 1 : 0}
      backgroundColor={active() ? skin.panel : undefined}
      onMouseOver={() => setActive(true)}
      onMouseOut={() => setActive(false)}
      onMouseUp={(event) => toggle(event)}
      focusable={expandable}
      onFocus={() => setActive(true)}
      onBlur={() => setActive(false)}
      onKeyDown={(event) => {
        if (!expandable || !isToggleKey(event)) return
        toggle(event)
      }}
    >
      <box flexDirection="row" gap={1}>
        <StatusGlyph status={status} skin={skin} pending={pending} />
        <text fg={skin.text}><b>{label}</b></text>
        <text flexGrow={1} fg={status === "FAILED" ? skin.error : skin.text}>{summary}</text>
        {meta ? <text fg={skin.muted}>{meta}</text> : null}
        {expandable ? <text fg={active() ? tone() : skin.muted}>{open() ? "▾" : "›"}</text> : null}
      </box>
      {open() ? <box paddingLeft={2} paddingTop={1} flexDirection="column" gap={0}>{children}</box> : null}
    </box>
  )
}

export function Expandable({ header, children, skin, openDefault = false }) {
  return <Activity label="" summary={header} status="SUCCESS" skin={skin} openDefault={openDefault}>{children}</Activity>
}

export function MetaGrid({ skin, entries, limit = 8 }) {
  const visible = entries
    .filter((entry) => entry && entry[1] !== null && entry[1] !== undefined && entry[1] !== "")
    .slice(0, limit)
  return (
    <box flexDirection="column" gap={0}>
      {visible.map((entry) => (
        <text fg={skin.muted}><span style={{ fg: skin.text }}>{entry[0]}</span>  {String(entry[1]).slice(0, 140)}</text>
      ))}
    </box>
  )
}

export function DetailLines({ lines, skin, limit = 12, color }) {
  const list = Array.from(lines ?? []).filter((line) => String(line).trim()).slice(-limit)
  return (
    <box flexDirection="column" gap={0}>
      {list.map((line, index) => <text key={index} fg={color ?? skin.muted}>{String(line).slice(0, 220)}</text>)}
    </box>
  )
}
