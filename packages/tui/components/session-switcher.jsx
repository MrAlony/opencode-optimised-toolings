/** @jsxImportSource @opentui/solid */
// Session switcher: the primary navigation surface of the Alonix IDE.
//
// Renders inside the host dialog stack and owns only its own selection state.
// Navigation is delegated to the host router, and pins are the only thing it
// persists.

import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import { GLYPH } from "../lib/design.js"
import { applyKeyToQuery, classifyKey, moveIndex, scrollWindow } from "../lib/keys.js"
import { fit, switcherLayout } from "../lib/layout.js"
import { flattenGroups, groupSessions, summarizeSessions } from "../lib/sessions.js"
import { compactPath } from "../lib/workspace.js"
import { Badge, DiffStat, EmptyState, KeyHints, Row, Rule, SectionLabel, Spinner, StatLine } from "./ide-kit.jsx"
import { activeSessionID, openSession, useClock } from "./runtime.jsx"

const HINTS = [
  { key: "↑↓", label: "move" },
  { key: "↵", label: "open" },
  { key: "1-9", label: "jump" },
  { key: "^P", label: "pin" },
  { key: "type", label: "filter" },
  { key: "esc", label: "close" },
]

function stateTone(row) {
  if (row.state === "retry") return "warning"
  if (row.state === "busy") return "accent"
  if (row.active) return "success"
  return "neutral"
}

function SessionRow(props) {
  const row = () => props.row
  return (
    <Row
      tokens={props.tokens}
      tone={stateTone(row())}
      selected={props.selected}
      animateIndex={props.animateIndex}
      onSelect={() => props.onOpen(row().id)}
      onHover={() => props.onHover(props.flatIndex)}
      leading={
        <box flexDirection="row" gap={1} flexShrink={0} width={3}>
          <Show
            when={row().running}
            fallback={
              <text fg={row().active ? props.tokens.success : props.tokens.borderFaint} wrapMode="none" selectable={false}>
                {row().active ? GLYPH.diamond : row().pinned ? GLYPH.ring : GLYPH.bullet}
              </text>
            }
          >
            <Spinner tokens={props.tokens} tone={row().state === "retry" ? "warning" : "accent"} />
          </Show>
          <text fg={props.selected ? props.tokens.accent : props.tokens.faint} wrapMode="none" selectable={false}>
            {row().slot ? String(row().slot) : " "}
          </text>
        </box>
      }
      meta={row().relative}
    >
      <box flexDirection="row" gap={1} minWidth={0}>
        <text
          fg={row().untitled ? props.tokens.muted : props.selected ? props.tokens.text : props.tokens.text}
          wrapMode="none"
          selectable={false}
        >
          {props.selected ? <b>{fit(row().title, props.width)}</b> : fit(row().title, props.width)}
        </text>
        <box flexGrow={1} />
        <Show when={row().changedFiles > 0}>
          <DiffStat tokens={props.tokens} additions={row().additions} deletions={row().deletions} />
        </Show>
      </box>
    </Row>
  )
}

function Preview(props) {
  const row = () => props.row
  return (
    <box flexDirection="column" flexShrink={0} width={props.width} paddingLeft={2} gap={1}>
      <Show when={row()} fallback={<EmptyState tokens={props.tokens} title="No session selected" />}>
        <box flexDirection="column">
          <SectionLabel tokens={props.tokens}>Session</SectionLabel>
          <text fg={props.tokens.text} wrapMode="wrap" selectable={false}>
            <b>{fit(row().title, props.width * 2)}</b>
          </text>
        </box>

        <box flexDirection="column">
          <StatLine tokens={props.tokens} label="state" labelWidth={12} color={props.tokens.text}>
            {row().active ? "current" : row().running ? row().state : "idle"}
          </StatLine>
          <StatLine tokens={props.tokens} label="updated" labelWidth={12}>
            {row().relative || "unknown"}
          </StatLine>
          <StatLine tokens={props.tokens} label="changes" labelWidth={12}>
            {row().changedFiles ? `${row().changedFiles} files` : "none"}
          </StatLine>
          <Show when={row().cost > 0}>
            <StatLine tokens={props.tokens} label="cost" labelWidth={12}>
              ${row().cost.toFixed(2)}
            </StatLine>
          </Show>
          <Show when={row().pinned}>
            <StatLine tokens={props.tokens} label="pinned" labelWidth={12} color={props.tokens.accent}>
              yes
            </StatLine>
          </Show>
        </box>

        <Show when={row().directory}>
          <box flexDirection="column">
            <SectionLabel tokens={props.tokens}>Directory</SectionLabel>
            <text fg={props.tokens.muted} wrapMode="none" selectable={false}>
              {compactPath(row().directory, props.width - 1)}
            </text>
          </box>
        </Show>
      </Show>
    </box>
  )
}

export function SessionSwitcher(props) {
  const tokens = props.tokens
  const store = props.store
  const [query, setQuery] = createSignal("")
  const [index, setIndex] = createSignal(0)
  const [offset, setOffset] = createSignal(0)
  const clock = useClock(() => tokens().motion !== false)

  const layout = createMemo(() => switcherLayout(props.dimensions?.() ?? { width: 120, height: 40 }))
  const rows = createMemo(() => store.model(activeSessionID(props.api), query()))
  const groups = createMemo(() => groupSessions(rows(), query()))
  const flat = createMemo(() => flattenGroups(groups()))
  const summary = createMemo(() => summarizeSessions(rows()))
  const selected = createMemo(() => flat()[Math.min(index(), Math.max(0, flat().length - 1))] ?? null)

  // Keep the cursor valid and visible as the filtered list changes.
  createEffect(() => {
    const size = flat().length
    if (index() > Math.max(0, size - 1)) setIndex(Math.max(0, size - 1))
  })
  createEffect(() => setOffset((current) => scrollWindow(current, index(), layout().rows, flat().length)))

  const open = (id) => {
    if (openSession(props.api, id)) props.onClose?.()
  }

  const handleKey = (event) => {
    const action = classifyKey(event)

    if (action === "dismiss") {
      props.onClose?.()
      return
    }
    if (action === "confirm") {
      const row = selected()
      if (row) open(row.id)
      return
    }
    if (action === "remove") {
      const row = selected()
      if (row) store.togglePin(row.id)
      return
    }
    if (event?.ctrl && String(event?.name ?? "").toLowerCase() === "p") {
      const row = selected()
      if (row) store.togglePin(row.id)
      return
    }
    if (["up", "down", "page-up", "page-down", "first", "last"].includes(action)) {
      setIndex((current) => moveIndex(current, flat().length, action, layout().rows))
      return
    }

    // Digit quick-jump only when it cannot be part of a search term.
    const name = String(event?.name ?? "")
    if (!query() && /^[1-9]$/.test(name)) {
      const row = flat().find((item) => item.slot === Number(name))
      if (row) {
        open(row.id)
        return
      }
    }

    const next = applyKeyToQuery(query(), event)
    if (next !== query()) {
      setQuery(next)
      setIndex(0)
      setOffset(0)
    }
  }

  // Flatten groups into renderable entries so headers and rows share one index.
  const entries = createMemo(() => {
    const out = []
    let flatIndex = 0
    for (const group of groups()) {
      out.push({ kind: "group", label: group.label, count: group.rows.length })
      for (const row of group.rows) {
        out.push({ kind: "row", row, flatIndex })
        flatIndex += 1
      }
    }
    return out
  })

  const visible = createMemo(() => {
    const list = entries()
    const start = offset()
    const end = start + layout().rows
    let seen = 0
    const out = []
    for (const entry of list) {
      if (entry.kind === "row") {
        if (seen >= start && seen < end) out.push(entry)
        seen += 1
        continue
      }
      // Keep a group header only when at least one of its rows is visible.
      out.push(entry)
    }
    return out.filter((entry, position) => {
      if (entry.kind !== "group") return true
      const next = out[position + 1]
      return next && next.kind === "row"
    })
  })

  return (
    <box
      flexDirection="column"
      paddingLeft={2}
      paddingRight={2}
      paddingBottom={1}
      gap={1}
      focusable
      focused
      onKeyDown={handleKey}
    >
      <box flexDirection="row" gap={1} flexShrink={0} alignItems="center">
        <text fg={tokens().accent} wrapMode="none" selectable={false}>
          {GLYPH.diamond}
        </text>
        <text fg={tokens().text} wrapMode="none" selectable={false}>
          <b>Sessions</b>
        </text>
        <Badge tokens={tokens()} tone="neutral">
          {summary().total}
        </Badge>
        <Show when={summary().running > 0}>
          <Badge tokens={tokens()} tone="accent">
            {summary().running} working
          </Badge>
        </Show>
        <Show when={summary().pinned > 0}>
          <Badge tokens={tokens()} tone="neutral">
            {summary().pinned} pinned
          </Badge>
        </Show>
        <box flexGrow={1} />
        <Show when={store.loading}>
          <Spinner tokens={tokens()} tone="accent" />
        </Show>
      </box>

      <box flexDirection="row" gap={1} flexShrink={0} backgroundColor={tokens().surface} paddingLeft={1} paddingRight={1}>
        <text fg={tokens().accent} wrapMode="none" selectable={false}>
          {GLYPH.pointer}
        </text>
        <text fg={query() ? tokens().text : tokens().faint} wrapMode="none" selectable={false}>
          {query() || "Filter sessions…"}
        </text>
        <Show when={tokens().motion !== false}>
          <text fg={tokens().accent} wrapMode="none" selectable={false}>
            {Math.floor(clock() / 520) % 2 === 0 ? GLYPH.caret : " "}
          </text>
        </Show>
      </box>

      <box flexDirection="row" flexShrink={0}>
        <box flexDirection="column" flexGrow={1} minWidth={0}>
          <Show
            when={flat().length}
            fallback={
              <EmptyState
                tokens={tokens()}
                title={query() ? "No sessions match that filter" : "No sessions yet"}
                hint={query() ? "Backspace to widen the search" : "Send a prompt to start one"}
              />
            }
          >
            <For each={visible()}>
              {(entry) => (
                <Show
                  when={entry.kind === "row"}
                  fallback={
                    <box paddingTop={1} flexShrink={0}>
                      <SectionLabel tokens={tokens()} meta={entry.count}>
                        {entry.label}
                      </SectionLabel>
                    </box>
                  }
                >
                  <SessionRow
                    tokens={tokens()}
                    row={entry.row}
                    flatIndex={entry.flatIndex}
                    selected={entry.flatIndex === index()}
                    animateIndex={entry.flatIndex - offset()}
                    width={layout().list - 14}
                    onOpen={open}
                    onHover={setIndex}
                  />
                </Show>
              )}
            </For>
          </Show>
        </box>

        <Show when={layout().showPreview}>
          <Preview tokens={tokens()} row={selected()} width={layout().preview} />
        </Show>
      </box>

      <Rule tokens={tokens()} />
      <KeyHints tokens={tokens()} hints={HINTS} />
    </box>
  )
}
