/** @jsxImportSource @opentui/solid */
// Real-time Mission Control. Delivery planning, review and historical memory
// belong to the Project Delivery Hub; this view is only for intervention now.

import { createMemo, createSignal, For, Show } from "solid-js"
import { GLYPH } from "../lib/design.js"
import { liveActivity } from "../lib/activity.js"
import { fit, fitLeft } from "../lib/layout.js"
import { agentWindow, missionControlModel } from "../lib/mission-control.js"
import { workspaceSnapshot } from "../lib/workspace.js"
import { ActivityLine, Button, ClickRow, SegmentedControl } from "./controls.jsx"
import { Badge, EmptyState, StatusDot } from "./ide-kit.jsx"
import { useClock } from "./runtime.jsx"

function missionAgent(api, session) {
  const activity = liveActivity(api, session.id, { limit: 8 })
  const snapshot = workspaceSnapshot(api, session.id)
  return {
    ...session,
    busy: activity.busy,
    headline: activity.headline,
    events: activity.events,
    failedCount: activity.failedCount,
    attention: snapshot.attention,
    activeTodos: snapshot.todos.length ? snapshot.activeTodos : Array.from(session.todos ?? []).filter((item) => item?.status !== "completed" && item?.status !== "cancelled").length,
    currentTodo: snapshot.currentTodo ?? Array.from(session.todos ?? []).find((item) => item?.status === "in_progress") ?? Array.from(session.todos ?? [])[0] ?? null,
    changedFiles: snapshot.changedFiles || session.changedFiles,
    files: snapshot.files.length ? snapshot.files : session.files,
  }
}

function FocusPanel(props) {
  const agent = () => props.agent
  return (
    <box flexDirection="column" flexGrow={1} minHeight={0} border borderStyle="rounded" borderColor={agent().needsAttention ? props.tokens.warning : agent().collision ? props.tokens.warning : props.tokens.accent} backgroundColor={props.tokens.panel}>
      <box flexDirection="row" height={2} flexShrink={0} paddingLeft={1} paddingRight={1} alignItems="center" backgroundColor={props.tokens.surface} gap={1}>
        <StatusDot tokens={props.tokens} tone={agent().needsAttention ? "warning" : agent().stalled ? "error" : "accent"} pulse={agent().running} />
        <box flexDirection="column" flexGrow={1} minWidth={0}>
          <text fg={props.tokens.text} wrapMode="none"><b>{fit(agent().title, Math.max(14, props.width - 24))}</b></text>
          <text fg={props.tokens.faint} wrapMode="none">{fit(agent().projectName || agent().directory || "", Math.max(12, props.width - 20))}</text>
        </box>
        <Button tokens={props.tokens} size="sm" variant="primary" onPress={() => props.onOpen?.(agent())}>Open chat</Button>
        <Button tokens={props.tokens} size="sm" variant="secondary" onPress={props.onClose}>Back</Button>
      </box>
      <box flexDirection="column" paddingLeft={2} paddingRight={2} paddingTop={1} gap={1}>
        <text fg={props.tokens.muted}>Current objective</text>
        <text fg={props.tokens.text} wrapMode="wrap">{agent().currentTodo?.content || agent().headline || "Working in this chat"}</text>
        <ActivityLine tokens={props.tokens} busy={agent().busy} width={Math.max(12, props.width - 7)}>{agent().headline}</ActivityLine>
        <box flexDirection="row" gap={1} flexWrap="wrap">
          <Show when={agent().attention > 0}><Badge tokens={props.tokens} tone="warning">{agent().attention} need you</Badge></Show>
          <Show when={agent().stalled}><Badge tokens={props.tokens} tone="error">possibly stalled</Badge></Show>
          <Show when={agent().collision}><Badge tokens={props.tokens} tone="warning">file overlap</Badge></Show>
          <Show when={agent().activeTodos > 0}><Badge tokens={props.tokens} tone="accent">{agent().activeTodos} todos</Badge></Show>
          <Show when={agent().changedFiles > 0}><Badge tokens={props.tokens} tone="neutral">{agent().changedFiles} changed</Badge></Show>
        </box>
        <text fg={props.tokens.muted}>Recent meaningful activity</text>
        <For each={agent().events.slice(0, 10)}>{(event) => <text fg={event.failed ? props.tokens.error : event.running ? props.tokens.accent : props.tokens.muted}>{event.running ? GLYPH.pointer : event.failed ? GLYPH.fail : GLYPH.ok} {event.label}</text>}</For>
        <Show when={agent().files.length}>
          <text fg={props.tokens.muted}>Files currently associated with this work</text>
          <For each={agent().files.slice(0, 8)}>{(file) => <text fg={props.tokens.faint} wrapMode="none">{GLYPH.bullet} {fitLeft(file.file, Math.max(12, props.width - 8))}</text>}</For>
        </Show>
      </box>
    </box>
  )
}

function AgentCard(props) {
  const agent = () => props.agent
  const tone = () => agent().needsAttention ? "warning" : agent().stalled ? "error" : agent().collision ? "warning" : "accent"
  return (
    <box flexDirection="column" flexShrink={0} width={props.width} minHeight={props.density === "compact" ? 5 : 9} border borderStyle="rounded" borderColor={tone() === "warning" ? props.tokens.warning : tone() === "error" ? props.tokens.error : props.tokens.accent} backgroundColor={props.tokens.panel}>
      <ClickRow tokens={props.tokens} width={props.width - 2} selected={props.selected} onSelect={() => props.onFocus?.(agent())}>
        <StatusDot tokens={props.tokens} tone={tone()} pulse={agent().running} />
        <box flexDirection="column" flexGrow={1} minWidth={0}>
          <text fg={props.tokens.text} wrapMode="none"><b>{fit(agent().title, Math.max(8, props.width - 14))}</b></text>
          <text fg={props.tokens.faint} wrapMode="none">{fit(agent().projectName || agent().directory || "", Math.max(8, props.width - 10))}</text>
        </box>
      </ClickRow>
      <box paddingLeft={1} paddingRight={1} paddingTop={1}><ActivityLine tokens={props.tokens} busy={agent().busy} width={Math.max(8, props.width - 5)}>{agent().headline}</ActivityLine></box>
      <Show when={props.density !== "compact"}>
        <box flexDirection="column" flexGrow={1} minHeight={0} paddingLeft={2} paddingTop={1}>
          <For each={agent().events.slice(0, props.density === "detailed" ? 6 : 3)}>{(event) => <text wrapMode="none"><span style={{ fg: event.running ? props.tokens.accent : event.failed ? props.tokens.error : props.tokens.success }}>{event.running ? GLYPH.pointer : event.failed ? GLYPH.fail : GLYPH.ok}</span><span style={{ fg: event.running ? props.tokens.text : props.tokens.muted }}>{" "}{fit(event.label, Math.max(8, props.width - 7))}</span></text>}</For>
        </box>
      </Show>
      <box flexDirection="row" flexShrink={0} paddingLeft={1} paddingRight={1} gap={1}>
        <Show when={agent().needsAttention}><Badge tokens={props.tokens} tone="warning">needs you</Badge></Show>
        <Show when={agent().stalled}><Badge tokens={props.tokens} tone="error">stalled?</Badge></Show>
        <Show when={agent().collision}><Badge tokens={props.tokens} tone="warning">overlap</Badge></Show>
        <box flexGrow={1} />
        <Show when={agent().changedFiles > 0}><text fg={props.tokens.faint}>{agent().changedFiles} files</text></Show>
      </box>
    </box>
  )
}

function AgentTableRow(props) {
  const agent = () => props.agent
  const tone = () => agent().needsAttention ? "warning" : agent().stalled ? "error" : agent().collision ? "warning" : "accent"
  return (
    <ClickRow tokens={props.tokens} width={props.width} selected={props.selected} onHover={props.onHover} onSelect={() => props.onFocus?.(agent())}>
      <StatusDot tokens={props.tokens} tone={tone()} pulse={agent().running} />
      <text fg={props.tokens.text} wrapMode="none"><b>{fit(agent().title, Math.max(10, Math.floor(props.width * 0.24)))}</b></text>
      <text fg={props.tokens.faint} wrapMode="none">{fit(agent().projectName, Math.max(8, Math.floor(props.width * 0.16)))}</text>
      <text fg={props.tokens.muted} wrapMode="none">{fit(agent().currentTodo?.content || agent().headline, Math.max(12, Math.floor(props.width * 0.36)))}</text>
      <box flexGrow={1} />
      <Show when={agent().needsAttention}><Badge tokens={props.tokens} tone="warning">attention</Badge></Show>
      <Show when={agent().stalled}><Badge tokens={props.tokens} tone="error">stalled</Badge></Show>
      <Show when={agent().collision}><Badge tokens={props.tokens} tone="warning">overlap</Badge></Show>
    </ClickRow>
  )
}

export function Monitor(props) {
  const tokens = props.tokens
  const [filter, setFilter] = createSignal("all")
  const [density, setDensity] = createSignal("cards")
  const [projectIndex, setProjectIndex] = createSignal(0)
  const [selected, setSelected] = createSignal(0)
  const [focusedID, setFocusedID] = createSignal("")
  const clock = useClock(() => props.tokens().motion !== false)
  const enriched = createMemo(() => {
    void clock()
    return Array.from(props.sessions?.() ?? []).map((session) => missionAgent(props.api, session))
  })
  const projects = createMemo(() => [{ id: "", name: "All folders" }, ...Array.from(props.projects?.() ?? []).map((project) => ({ id: project.id, name: project.name }))])
  const project = createMemo(() => projects()[Math.min(projectIndex(), projects().length - 1)] ?? projects()[0])
  const model = createMemo(() => missionControlModel({ agents: enriched(), filter: filter(), project: project().id, now: Date.now() }))
  const focused = createMemo(() => model().agents.find((agent) => agent.id === focusedID()) ?? null)
  const rowHeight = createMemo(() => density() === "table" ? 1 : density() === "compact" ? 6 : 10)
  const windowed = createMemo(() => agentWindow(model().agents, selected(), Math.max(1, Math.floor((props.height - 9) / rowHeight()))))
  const columns = createMemo(() => density() === "table" ? 1 : props.width >= 108 ? 3 : props.width >= 68 ? 2 : 1)
  const cardWidth = createMemo(() => Math.max(28, Math.floor((props.width - (columns() - 1)) / columns())))
  const cardRows = createMemo(() => {
    const out = []
    const list = windowed().rows
    for (let index = 0; index < list.length; index += columns()) out.push(list.slice(index, index + columns()))
    return out
  })

  return (
    <box flexDirection="column" flexGrow={1} minWidth={0} minHeight={0} paddingLeft={1} paddingRight={1} gap={1}>
      <box flexDirection="row" flexShrink={0} minHeight={3} alignItems="center" backgroundColor={tokens().surface} paddingLeft={1} paddingRight={1} gap={1}>
        <box flexDirection="column" flexGrow={1} minWidth={0}>
          <text fg={tokens().text}><b>Live Agents Mission Control</b></text>
          <text fg={tokens().muted}>Intervene in active work, blockers, stalls and file collisions. Delivery planning lives in the Delivery Hub.</text>
        </box>
        <Button tokens={tokens()} size="sm" variant="secondary" onPress={() => setProjectIndex((projectIndex() + 1) % Math.max(1, projects().length))}>Folder: {fit(project().name, 16)}</Button>
        <Button tokens={tokens()} size="sm" variant="secondary" onPress={() => setDensity(density() === "cards" ? "table" : density() === "table" ? "compact" : "cards")}>View: {density()}</Button>
      </box>
      <box flexDirection="row" flexShrink={0} gap={1} flexWrap="wrap">
        <SegmentedControl tokens={tokens()} value={filter()} onChange={(value) => { setFilter(value); setSelected(0); setFocusedID("") }} items={[{ value: "all", label: "All", count: model().stats.total }, { value: "attention", label: "Needs you", count: model().stats.attention }, { value: "working", label: "Working", count: model().stats.working }, { value: "stalled", label: "Stalled", count: model().stats.stalled }, { value: "collisions", label: "Overlaps", count: model().stats.collisions }]} />
        <box flexGrow={1} />
        <Show when={windowed().before > 0}><Badge tokens={tokens()} tone="neutral">{windowed().before} above</Badge></Show>
        <Show when={windowed().after > 0}><Badge tokens={tokens()} tone="neutral">+{windowed().after} more</Badge></Show>
      </box>

      <Show when={focused()} fallback={
        <Show when={model().agents.length} fallback={<EmptyState tokens={tokens()} title={props.ready ? "No live agents match this view" : "Loading live work"} hint={props.ready ? "Change the filter or use the Delivery Hub to start and plan work." : "Checking every workspace for active chats…"} action={props.ready ? <Button tokens={tokens()} variant="primary" size="lg" glyph={GLYPH.pointer} onPress={props.onChooseProject}>Start new work</Button> : undefined} />}>
          <scrollbox flexGrow={1} stickyScroll={false} onMouseScroll={(event) => setSelected(Math.max(0, Math.min(model().agents.length - 1, selected() + (Number(event?.delta) > 0 ? 1 : -1))))}>
            <Show when={density() === "table"} fallback={<For each={cardRows()}>{(row) => <box flexDirection="row" flexShrink={0} gap={1} marginBottom={1}><For each={row}>{(agent) => <AgentCard tokens={tokens()} agent={agent} width={cardWidth()} density={density()} selected={model().agents[selected()]?.id === agent.id} onFocus={(item) => setFocusedID(item.id)} />}</For></box>}</For>}>
              <For each={windowed().rows}>{(agent, index) => <AgentTableRow tokens={tokens()} agent={agent} width={props.width} selected={model().agents[selected()]?.id === agent.id} onHover={() => setSelected(windowed().start + index())} onFocus={(item) => setFocusedID(item.id)} />}</For>
            </Show>
          </scrollbox>
        </Show>
      }>
        {(agent) => <FocusPanel tokens={tokens()} agent={agent()} width={props.width} onOpen={props.onOpen} onClose={() => setFocusedID("")} />}
      </Show>
    </box>
  )
}
