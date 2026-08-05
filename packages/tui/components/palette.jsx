/** @jsxImportSource @opentui/solid */
// Universal palette: one surface for sessions, projects, and actions.
//
// Typing filters everything at once; a leading `>`, `@`, or `#` narrows the
// scope. Selection state is local; every outcome is delegated to the caller.

import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import { GLYPH } from "../lib/design.js"
import { applyKeyToQuery, classifyKey, moveIndex, scrollWindow } from "../lib/keys.js"
import { fit, switcherLayout } from "../lib/layout.js"
import { MODES, buildActions, groupActions, parseQuery } from "../lib/command-registry.js"
import { compactPath } from "../lib/workspace.js"
import { Badge, DiffStat, EmptyState, KeyHints, Row, Rule, SectionLabel, Spinner, StatLine } from "./ide-kit.jsx"
import { useClock } from "./runtime.jsx"

const HINTS = [
  { key: "↑↓", label: "move" },
  { key: "↵", label: "open" },
  { key: "1-9", label: "jump" },
  { key: ">·@·#", label: "scope" },
  { key: "esc", label: "close" },
]

const KIND_GLYPH = { session: GLYPH.diamond, project: GLYPH.square, command: GLYPH.pointer }

function ActionRow(props) {
  const action = () => props.action
  const tone = createMemo(() => {
    if (action().active) return "success"
    if (action().running) return "accent"
    if (action().kind === "command") return "neutral"
    return "neutral"
  })
  return (
    <Row
      tokens={props.tokens}
      tone={tone()}
      selected={props.selected}
      animateIndex={props.animateIndex}
      onSelect={() => props.onRun(action())}
      onHover={() => props.onHover(props.flatIndex)}
      meta={action().meta}
      leading={
        <box flexDirection="row" gap={1} flexShrink={0} width={3}>
          <Show
            when={action().running}
            fallback={
              <text
                fg={action().active ? props.tokens.success : props.tokens.faint}
                wrapMode="none"
                selectable={false}
              >
                {KIND_GLYPH[action().kind] ?? GLYPH.bullet}
              </text>
            }
          >
            <Spinner tokens={props.tokens} tone="accent" />
          </Show>
          <text fg={props.selected ? props.tokens.accent : props.tokens.faint} wrapMode="none" selectable={false}>
            {action().slot ?? " "}
          </text>
        </box>
      }
    >
      <box flexDirection="row" gap={1} minWidth={0}>
        <text fg={props.tokens.text} wrapMode="none" selectable={false}>
          {props.selected ? <b>{fit(action().title, props.width)}</b> : fit(action().title, props.width)}
        </text>
        <Show when={action().subtitle}>
          <text fg={props.tokens.faint} wrapMode="none" selectable={false}>
            {fit(action().subtitle, Math.max(8, Math.floor(props.width * 0.5)))}
          </text>
        </Show>
        <box flexGrow={1} />
        <Show when={action().changedFiles > 0}>
          <DiffStat tokens={props.tokens} additions={action().session?.additions} deletions={action().session?.deletions} />
        </Show>
      </box>
    </Row>
  )
}

function Preview(props) {
  const action = () => props.action
  return (
    <box flexDirection="column" flexShrink={0} width={props.width} paddingLeft={2} gap={1}>
      <Show when={action()} fallback={<EmptyState tokens={props.tokens} title="Nothing selected" />}>
        <box flexDirection="column">
          <SectionLabel tokens={props.tokens}>{action().kind}</SectionLabel>
          <text fg={props.tokens.text} wrapMode="wrap" selectable={false}>
            <b>{fit(action().title, props.width * 2)}</b>
          </text>
        </box>

        <Show when={action().kind === "session"}>
          <box flexDirection="column">
            <StatLine tokens={props.tokens} label="project" labelWidth={12}>
              {fit(action().session?.projectName ?? "", props.width - 14)}
            </StatLine>
            <StatLine tokens={props.tokens} label="updated" labelWidth={12}>
              {action().meta || "unknown"}
            </StatLine>
            <StatLine tokens={props.tokens} label="changes" labelWidth={12}>
              {action().changedFiles ? `${action().changedFiles} files` : "none"}
            </StatLine>
          </box>
        </Show>

        <Show when={action().kind === "project"}>
          <box flexDirection="column">
            <StatLine tokens={props.tokens} label="sessions" labelWidth={12}>
              {action().project?.sessionCount ?? 0}
            </StatLine>
            <StatLine tokens={props.tokens} label="running" labelWidth={12}>
              {action().project?.running ?? 0}
            </StatLine>
            <StatLine tokens={props.tokens} label="changes" labelWidth={12}>
              {action().changedFiles || "none"}
            </StatLine>
          </box>
        </Show>

        <Show when={action().subtitle}>
          <box flexDirection="column">
            <SectionLabel tokens={props.tokens}>Location</SectionLabel>
            <text fg={props.tokens.muted} wrapMode="none" selectable={false}>
              {compactPath(action().subtitle, props.width - 1)}
            </text>
          </box>
        </Show>
      </Show>
    </box>
  )
}

export function Palette(props) {
  const tokens = props.tokens
  const [query, setQuery] = createSignal(props.initialQuery ?? "")
  const [index, setIndex] = createSignal(0)
  const [offset, setOffset] = createSignal(0)
  const clock = useClock(() => tokens().motion !== false)

  const layout = createMemo(() => switcherLayout(props.dimensions?.() ?? { width: 120, height: 40 }))
  const parsed = createMemo(() => parseQuery(query()))
  const actions = createMemo(() =>
    buildActions({
      query: query(),
      sessions: props.sessions?.() ?? [],
      projects: props.projects?.() ?? [],
      commands: props.commands?.() ?? [],
      now: Date.now(),
    }),
  )
  const groups = createMemo(() => groupActions(actions()))
  const selected = createMemo(() => actions()[Math.min(index(), Math.max(0, actions().length - 1))] ?? null)

  createEffect(() => {
    const size = actions().length
    if (index() > Math.max(0, size - 1)) setIndex(Math.max(0, size - 1))
  })
  createEffect(() => setOffset((current) => scrollWindow(current, index(), layout().rows, actions().length)))

  const run = (action) => {
    if (!action) return
    props.onRun?.(action)
  }

  const handleKey = (event) => {
    const action = classifyKey(event)

    if (action === "dismiss") {
      props.onClose?.()
      return
    }
    if (action === "confirm") {
      run(selected())
      return
    }
    if (["up", "down", "page-up", "page-down", "first", "last"].includes(action)) {
      setIndex((current) => moveIndex(current, actions().length, action, layout().rows))
      return
    }

    // Digits jump directly only when they cannot be part of a search term.
    const name = String(event?.name ?? "")
    if (!parsed().term && /^[1-9]$/.test(name)) {
      const match = actions().find((item) => item.slot === Number(name))
      if (match) {
        run(match)
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

  const entries = createMemo(() => {
    const out = []
    let flatIndex = 0
    for (const group of groups()) {
      out.push({ kind: "group", label: group.label, count: group.rows.length })
      for (const row of group.rows) {
        out.push({ kind: "row", action: row, flatIndex })
        flatIndex += 1
      }
    }
    return out
  })

  const visible = createMemo(() => {
    const start = offset()
    const end = start + layout().rows
    let seen = 0
    const out = []
    for (const entry of entries()) {
      if (entry.kind === "row") {
        if (seen >= start && seen < end) out.push(entry)
        seen += 1
        continue
      }
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
          <b>{MODES[parsed().mode].label}</b>
        </text>
        <text fg={tokens().faint} wrapMode="none" selectable={false}>
          {MODES[parsed().mode].hint}
        </text>
        <box flexGrow={1} />
        <Show when={props.loading?.()}>
          <Spinner tokens={tokens()} tone="accent" />
        </Show>
        <Badge tokens={tokens()} tone="neutral">
          {actions().length}
        </Badge>
      </box>

      <box
        flexDirection="row"
        gap={1}
        flexShrink={0}
        backgroundColor={tokens().surface}
        paddingLeft={1}
        paddingRight={1}
      >
        <text fg={tokens().accent} wrapMode="none" selectable={false}>
          {parsed().prefix || GLYPH.pointer}
        </text>
        <text fg={query() ? tokens().text : tokens().faint} wrapMode="none" selectable={false}>
          {parsed().term || (query() ? "" : "Search sessions, projects and actions…")}
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
            when={actions().length}
            fallback={
              <EmptyState
                tokens={tokens()}
                title="Nothing matches that search"
                hint="Backspace to widen, or press esc to close"
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
                  <ActionRow
                    tokens={tokens()}
                    action={entry.action}
                    flatIndex={entry.flatIndex}
                    selected={entry.flatIndex === index()}
                    animateIndex={entry.flatIndex - offset()}
                    width={layout().list - 18}
                    onRun={run}
                    onHover={setIndex}
                  />
                </Show>
              )}
            </For>
          </Show>
        </box>

        <Show when={layout().showPreview}>
          <Preview tokens={tokens()} action={selected()} width={layout().preview} />
        </Show>
      </box>

      <Rule tokens={tokens()} />
      <KeyHints tokens={tokens()} hints={HINTS} />
    </box>
  )
}
