/** @jsxImportSource @opentui/solid */
import { createEffect, createMemo, createSignal, onCleanup } from "solid-js"

export function displayPath(path, max = 64) {
  const text = String(path ?? "")
  if (text.length <= max) return text
  return `…${text.slice(-(max - 1))}`
}

export function lifecycleOf(part) {
  const state = part?.state ?? {}
  if (state.status === "error") return { phase: "error", status: "FAILED", pending: false, label: "failed", error: state.error ?? "Tool execution failed" }
  if (state.status === "completed") return { phase: "completed", status: null, pending: false, label: "done", error: "" }
  if (state.status === "running") return { phase: "running", status: "RUNNING", pending: true, label: "running", error: "" }
  return { phase: "pending", status: "PENDING", pending: true, label: "queued", error: "" }
}

export function resolvedStatus(part, resultStatus) {
  const lifecycle = lifecycleOf(part)
  if (lifecycle.status) return lifecycle.status
  return resultStatus ?? "PARTIAL SUCCESS"
}

export function statusTone(status, skin) {
  if (status === "SUCCESS") return skin.success
  if (status === "FAILED") return skin.error
  if (status === "RUNNING" || status === "PENDING") return skin.accent
  return skin.warning ?? skin.accent
}

export function statusLabel(status, lifecycle) {
  if (lifecycle?.phase !== "completed") return lifecycle?.label ?? "working"
  if (status === "SUCCESS") return "success"
  if (status === "FAILED") return "failed"
  return "partial"
}

export function StatusGlyph(props) {
  const frames = ["◌", "◔", "◑", "◕"]
  const [frame, setFrame] = createSignal(0)
  createEffect(() => {
    if (!props.pending || props.skin.motion === false) return
    const timer = setInterval(() => setFrame((value) => (value + 1) % frames.length), 140)
    onCleanup(() => clearInterval(timer))
  })
  return (
    <text fg={statusTone(props.status, props.skin)}>
      {props.pending ? (props.skin.motion === false ? frames[0] : frames[frame()]) : props.status === "SUCCESS" ? "✓" : props.status === "FAILED" ? "✕" : "◐"}
    </text>
  )
}

function isToggleKey(event) {
  const name = String(event?.name ?? event?.key ?? "").toLowerCase()
  return name === "return" || name === "enter" || name === "space" || name === " "
}

export function Activity(props) {
  const expandable = createMemo(() => typeof props.details === "function")
  const [open, setOpen] = createSignal(Boolean(props.openDefault))
  const [active, setActive] = createSignal(false)
  let failureOpened = false
  let defaultOpened = Boolean(props.openDefault)
  createEffect(() => {
    if (props.openDefault && !defaultOpened) {
      defaultOpened = true
      setOpen(true)
    }
    if (props.status === "FAILED" && !failureOpened) {
      failureOpened = true
      setOpen(true)
    }
  })
  const toggle = (event) => {
    if (!expandable()) return
    event?.stopPropagation?.()
    setOpen((value) => !value)
  }
  return (
    <box
      flexDirection="column"
      flexShrink={0}
      marginTop={props.compact ? 0 : 1}
      paddingLeft={1}
      paddingRight={1}
      paddingTop={0}
      paddingBottom={open() ? 1 : 0}
      backgroundColor={active() ? props.skin.panel : undefined}
      onMouseOver={() => setActive(true)}
      onMouseOut={() => setActive(false)}
      onMouseUp={toggle}
      focusable={expandable()}
      onFocus={() => setActive(true)}
      onBlur={() => setActive(false)}
      onKeyDown={(event) => {
        if (isToggleKey(event)) toggle(event)
      }}
    >
      <box flexDirection="row" gap={1}>
        <StatusGlyph status={props.status} skin={props.skin} pending={props.pending} />
        <text fg={props.skin.text}><b>{props.label}</b></text>
        <text flexGrow={1} fg={props.status === "FAILED" ? props.skin.error : props.skin.text}>{props.summary}</text>
        {props.meta ? <text fg={statusTone(props.status, props.skin)}>{props.meta}</text> : null}
        {expandable() ? <text fg={active() ? statusTone(props.status, props.skin) : props.skin.muted}>{open() ? "▾" : "›"}</text> : null}
      </box>
      {props.preview ? <box paddingLeft={2} paddingTop={1} flexDirection="column" gap={0}>{props.preview}</box> : null}
      {open() ? <box paddingLeft={2} paddingTop={1} flexDirection="column" gap={1}>{props.details()}</box> : null}
    </box>
  )
}

export function ItemRow(props) {
  return (
    <box flexDirection="row" gap={1} flexShrink={0}>
      <text width={1} fg={statusTone(props.status, props.skin)}>{props.status === "SUCCESS" ? "✓" : props.status === "FAILED" ? "✕" : props.status === "RUNNING" || props.status === "PENDING" ? "◌" : "◐"}</text>
      <text flexGrow={1} fg={props.status === "FAILED" ? props.skin.error : props.skin.text}>{props.label}</text>
      {props.meta ? <text fg={props.skin.muted}>{props.meta}</text> : null}
    </box>
  )
}

export function PreviewList(props) {
  const items = createMemo(() => Array.from(props.items ?? []).slice(0, props.limit ?? 4))
  return (
    <box flexDirection="column" gap={0}>
      {items().map((item) => <ItemRow skin={props.skin} {...item} />)}
      {(props.items?.length ?? 0) > (props.limit ?? 4) ? <text fg={props.skin.muted}>  +{props.items.length - (props.limit ?? 4)} more</text> : null}
    </box>
  )
}

export function Section(props) {
  return (
    <box flexDirection="column" gap={0}>
      <text fg={props.color ?? props.skin.accent}><b>{props.title}</b>{props.meta ? <span style={{ fg: props.skin.muted }}>  {props.meta}</span> : null}</text>
      <box paddingLeft={1} flexDirection="column" gap={0}>{props.children}</box>
    </box>
  )
}

export function MetaGrid(props) {
  const visible = createMemo(() => Array.from(props.entries ?? []).filter((entry) => entry && entry[1] !== null && entry[1] !== undefined && entry[1] !== "").slice(0, props.limit ?? 10))
  return <box flexDirection="column" gap={0}>{visible().map((entry) => <text fg={props.skin.muted}><span style={{ fg: props.skin.text }}>{entry[0]}</span>  {String(entry[1]).slice(0, 180)}</text>)}</box>
}

export function DetailLines(props) {
  const list = createMemo(() => Array.from(props.lines ?? []).filter((line) => String(line).trim()).slice(props.tail === false ? 0 : -(props.limit ?? 16), props.tail === false ? (props.limit ?? 16) : undefined))
  return <box flexDirection="column" gap={0}>{list().map((line, index) => <text key={index} fg={props.color ?? props.skin.muted}>{String(line).slice(0, props.width ?? 240)}</text>)}</box>
}

export function RawEvidence(props) {
  return <Section title="Raw evidence" skin={props.skin} meta={`${props.tail === false ? "first" : "last"} ${props.limit ?? 24} lines`}><DetailLines skin={props.skin} lines={String(props.text ?? "").split(/\r?\n/)} limit={props.limit ?? 24} color={props.skin.muted} tail={props.tail} /></Section>
}
