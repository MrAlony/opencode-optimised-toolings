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
  if (lifecycle.phase === "error") return "FAILED"
  if (resultStatus) return resultStatus
  return lifecycle.status ?? "PARTIAL SUCCESS"
}

export function statusPending(status) {
  return status === "RUNNING" || status === "PENDING"
}

export function statusTone(status, skin) {
  if (status === "SUCCESS") return skin.success
  if (status === "FAILED") return skin.error
  if (status === "RUNNING" || status === "PENDING") return skin.accent
  return skin.warning ?? skin.accent
}

export function statusLabel(status) {
  if (status === "RUNNING") return "running"
  if (status === "PENDING") return "queued"
  if (status === "SUCCESS") return "done"
  if (status === "FAILED") return "failed"
  return "partial"
}

export function statusSurface(status, skin, active = false) {
  if (status === "SUCCESS") return active ? skin.successSurfaceHover : skin.successSurface
  if (status === "FAILED") return active ? skin.errorSurfaceHover : skin.errorSurface
  if (status === "RUNNING" || status === "PENDING") return active ? skin.accentSurfaceHover : skin.accentSurface
  return active ? skin.warningSurfaceHover : skin.warningSurface
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
      paddingTop={1}
      paddingBottom={1}
      backgroundColor={statusSurface(props.status, props.skin, active())}
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
        <text flexGrow={1} fg={props.status === "FAILED" ? props.skin.error : props.skin.text}><b>{props.label}</b><span style={{ fg: props.skin.muted }}> · </span>{props.summary}</text>
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
  const items = createMemo(() => Array.from(props.items ?? []).slice(0, props.limit ?? 6))
  return (
    <box flexDirection="column" gap={0}>
      {items().map((item) => <ItemRow skin={props.skin} {...item} />)}
      {(props.items?.length ?? 0) > (props.limit ?? 6) ? <text fg={props.skin.muted}>  +{props.items.length - (props.limit ?? 6)} more</text> : null}
    </box>
  )
}

export function Section(props) {
  return (
    <box flexDirection="column" gap={0}>
      <text fg={props.color ?? props.skin.accent}><b>{props.title}</b>{props.meta ? <span style={{ fg: props.skin.muted }}>  {props.meta}</span> : null}</text>
      <box paddingLeft={1} paddingTop={props.tight ? 0 : 1} flexDirection="column" gap={0}>{props.children}</box>
    </box>
  )
}

export function InspectorCard(props) {
  const tone = props.status ?? "PARTIAL SUCCESS"
  return (
    <box
      flexDirection="column"
      flexShrink={0}
      backgroundColor={props.backgroundColor ?? (props.nested ? props.skin.surface : props.skin.inset)}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={1}
      paddingRight={1}
      gap={1}
    >
      <box flexDirection="row" gap={1}>
        <StatusGlyph status={tone} skin={props.skin} pending={props.pending === true} />
        <text flexGrow={1} fg={props.color ?? statusTone(tone, props.skin)}><b>{props.title}</b></text>
        {props.meta ? <text fg={props.skin.muted}>{props.meta}</text> : null}
      </box>
      {props.subtitle ? <text fg={props.skin.muted}>{props.subtitle}</text> : null}
      <box paddingLeft={2} flexDirection="column" gap={1}>{props.children}</box>
    </box>
  )
}

export function OutcomeOverview(props) {
  const facts = createMemo(() => Array.from(props.facts ?? []).filter((entry) => entry && entry[1] !== null && entry[1] !== undefined && entry[1] !== ""))
  const meaning = createMemo(() => Array.from(props.meaning ?? []).filter((line) => String(line ?? "").trim()))
  return (
    <InspectorCard
      title={props.title ?? "What happened"}
      skin={props.skin}
      status={props.status}
      meta={props.meta}
      subtitle={props.summary}
    >
      {facts().length ? <MetaGrid skin={props.skin} entries={facts()} limit={8} /> : null}
      {meaning().length ? <ContentPane title="What this means" skin={props.skin} lines={meaning()} limit={6} tail={false} color={props.status === "FAILED" ? props.skin.error : props.skin.text} /> : null}
    </InspectorCard>
  )
}

export function ContentPane(props) {
  return (
    <box flexDirection="column" backgroundColor={props.skin.surface} paddingTop={1} paddingBottom={1} paddingLeft={1} paddingRight={1}>
      {props.title ? <text fg={props.skin.muted}><b>{props.title}</b></text> : null}
      <DetailLines skin={props.skin} lines={props.lines} limit={props.limit ?? 18} width={props.width} tail={props.tail} color={props.color ?? props.skin.text} />
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

export function InspectorUnavailable(props) {
  return (
    <InspectorCard title="Inspector unavailable" skin={props.skin} status="FAILED" subtitle="The tool execution failed or returned an invalid response.">
      <ContentPane skin={props.skin} title="What to do" lines={[props.message ?? "The execution result is preserved. Review the tool error and saved output path when present."]} limit={5} tail={false} color={props.skin.error} />
    </InspectorCard>
  )
}

export function InspectorDegraded(props) {
  return (
    <InspectorCard title={props.title ?? "Details omitted"} skin={props.skin} status="PARTIAL SUCCESS" subtitle={props.subtitle ?? "The request plan is intact, but bounded transcript output did not include the structured result details."}>
      {props.items?.length ? <PreviewList skin={props.skin} items={props.items} limit={props.limit ?? 12} /> : null}
      <ContentPane skin={props.skin} title="What this means" lines={[props.message ?? "OpenCode preserved the original tool output separately. This inspector will not treat missing bounded detail as a renderer or execution failure."]} limit={5} tail={false} color={props.skin.warning} />
    </InspectorCard>
  )
}

export function RawEvidence(props) {
  return <Section title={props.title ?? "Diagnostic evidence"} skin={props.skin} meta={`${props.tail === false ? "first" : "last"} ${props.limit ?? 12} lines`}><DetailLines skin={props.skin} lines={String(props.text ?? "").split(/\r?\n/)} limit={props.limit ?? 12} color={props.skin.muted} tail={props.tail} /></Section>
}
