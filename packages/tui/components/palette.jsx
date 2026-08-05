/** @jsxImportSource @opentui/solid */
// Universal palette: one surface for sessions, projects, and actions.
//
// Typing filters everything at once; a leading `>`, `@`, or `#` narrows the
// scope. Every row is fully mouse-operable.
//
// Rows are rendered as a single fixed-width text node built from exact column
// arithmetic. The host dialog is a fixed-width panel, so budgeting against the
// terminal (or letting flex shrink labels) truncates titles to a few useless
// characters. Padding each column to a known cell count keeps the grid aligned
// and clips gracefully instead.

import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import { GLYPH } from "../lib/design.js"
import { classifyKey, moveIndex, scrollWindow } from "../lib/keys.js"
import { fit, fitLeft, pad, paletteLayout } from "../lib/layout.js"
import { spinnerFrame, stagger } from "../lib/motion.js"
import { MODES, buildActions, groupActions, parseQuery } from "../lib/command-registry.js"
import { EmptyState, KeyHints, SectionLabel, Spinner, StatLine } from "./ide-kit.jsx"
import { Button, SegmentedControl, TextInput } from "./controls.jsx"
import { useClock } from "./runtime.jsx"

const HINTS = [
  { key: "type", label: "search" },
  { key: "click", label: "choose" },
  { key: "↵", label: "open" },
  { key: "esc", label: "close" },
]

const FILTERS = [
  { value: "all", label: "All" },
  { value: "session", label: "Chats" },
  { value: "project", label: "Folders" },
  { value: "command", label: "Actions" },
]

const KIND_GLYPH = { session: GLYPH.diamond, project: GLYPH.square, command: GLYPH.pointer }

/**
 * One palette row.
 *
 * The whole row is a single `text` with `wrapMode="none"`, so the terminal
 * clips it at the panel edge rather than reflowing or shrinking columns.
 */
function ActionRow(props) {
  const tokens = () => props.tokens
  const columns = () => props.columns
  const action = () => props.action
  const clock = useClock(() => (action().running || props.animateIndex !== undefined) && tokens().motion !== false)

  const entrance = createMemo(() => {
    if (props.animateIndex === undefined || tokens().motion === false) return 1
    return stagger(clock(), props.animateIndex)
  })

  const glyph = createMemo(() => {
    if (action().running) return spinnerFrame(clock(), undefined, 90, tokens().motion !== false)
    if (action().active) return GLYPH.diamond
    return KIND_GLYPH[action().kind] ?? GLYPH.bullet
  })

  const glyphColor = createMemo(() => {
    if (action().running) return tokens().accent
    if (action().active) return tokens().success
    if (action().kind === "command") return tokens().muted
    return tokens().faint
  })

  const titleColor = createMemo(() => {
    if (entrance() < 0.4) return tokens().faint
    return props.selected || action().active ? tokens().text : tokens().muted
  })

  return (
    <box
      flexDirection="row"
      flexShrink={0}
      height={1}
      backgroundColor={props.selected ? tokens().selectionStrong : tokens().panel}
      onMouseUp={() => props.onRun(action())}
      onMouseMove={() => props.onHover(props.flatIndex)}
      onMouseDown={() => props.onHover(props.flatIndex)}
    >
      <text wrapMode="none" selectable={false}>
        <span style={{ fg: props.selected ? tokens().accent : tokens().borderFaint }}>
          {props.selected ? GLYPH.pointer : " "}
        </span>
        <span style={{ fg: glyphColor() }}>{glyph()}</span>
        <span style={{ fg: props.selected ? tokens().accent : tokens().faint }}>
          {" "}
          {action().slot ? String(action().slot) : " "}
        </span>
        <span style={{ fg: titleColor() }}>
          {" "}
          {pad(action().title, columns().title)}
        </span>
        <Show when={columns().subtitle > 0}>
          <span style={{ fg: tokens().faint }}>
            {" "}
            {pad(subtitleFor(action(), columns().subtitle), columns().subtitle)}
          </span>
        </Show>
        <Show when={columns().meta > 0}>
          <span style={{ fg: props.selected ? tokens().muted : tokens().faint }}>
            {pad(metaFor(action()), columns().meta, "right")}
          </span>
        </Show>
      </text>
    </box>
  )
}

/** Paths read better truncated from the left; everything else from the right. */
function subtitleFor(action, width) {
  const value = String(action.subtitle ?? "")
  if (!value) return ""
  const looksLikePath = value.includes("/") || value.includes("\\")
  return looksLikePath ? fitLeft(value, width) : fit(value, width)
}

function metaFor(action) {
  if (action.kind === "session" && action.changedFiles > 0) return `${action.changedFiles}f`
  return String(action.meta ?? "")
}

function Preview(props) {
  const tokens = () => props.tokens
  const action = () => props.action
  const width = () => props.width

  return (
    <box
      flexDirection="column"
      flexShrink={0}
      width={width()}
      paddingLeft={2}
      paddingRight={1}
      paddingTop={1}
      gap={1}
      backgroundColor={tokens().surface}
    >
      <Show when={action()} fallback={<EmptyState tokens={tokens()} title="Nothing selected" />}>
        <box flexDirection="column">
          <SectionLabel tokens={tokens()}>{action().kind}</SectionLabel>
          <text fg={tokens().text} wrapMode="wrap" selectable={false}>
            <b>{action().title}</b>
          </text>
        </box>

        <Show when={action().kind === "session"}>
          <box flexDirection="column">
            <StatLine tokens={tokens()} label="project" labelWidth={12}>
              {fit(action().session?.projectName ?? "—", width() - 16)}
            </StatLine>
            <StatLine tokens={tokens()} label="updated" labelWidth={12}>
              {action().meta || "unknown"}
            </StatLine>
            <StatLine tokens={tokens()} label="changes" labelWidth={12}>
              {action().changedFiles ? `${action().changedFiles} files` : "none"}
            </StatLine>
            <StatLine tokens={tokens()} label="state" labelWidth={12}>
              {action().running ? "working" : action().active ? "open" : "idle"}
            </StatLine>
          </box>
        </Show>

        <Show when={action().kind === "project"}>
          <box flexDirection="column">
            <StatLine tokens={tokens()} label="sessions" labelWidth={12}>
              {action().project?.sessionCount ?? 0}
            </StatLine>
            <StatLine tokens={tokens()} label="running" labelWidth={12}>
              {action().project?.running ?? 0}
            </StatLine>
            <StatLine tokens={tokens()} label="changes" labelWidth={12}>
              {action().changedFiles || "none"}
            </StatLine>
          </box>
        </Show>

        <Show when={action().subtitle}>
          <box flexDirection="column">
            <SectionLabel tokens={tokens()}>Location</SectionLabel>
            <text fg={tokens().muted} wrapMode="wrap" selectable={false}>
              {action().subtitle}
            </text>
          </box>
        </Show>

        <Show when={action().kind === "project"}>
          <text fg={tokens().accent} wrapMode="wrap" selectable={false}>
            {GLYPH.pointer} Prepares a new chat here; it is created after your first message
          </text>
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

  // Sized against the host dialog panel, not the terminal.
  const layout = createMemo(() => {
    const dimensions = props.dimensions?.() ?? { width: 120, height: 40 }
    return paletteLayout({ size: props.size ?? "xlarge", width: dimensions.width, height: dimensions.height })
  })

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
  // Filters and the large action button consume rows that used to belong to
  // the result list. Budget them explicitly so the fixed-size host dialog can
  // never overflow vertically.
  const resultRows = createMemo(() => Math.max(3, layout().rows - 4))
  createEffect(() => setOffset((current) => scrollWindow(current, index(), resultRows(), actions().length)))

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

  }

  const setMode = (mode) => {
    const prefix = MODES[mode]?.prefix ?? ""
    setQuery(`${prefix}${parsed().term}`)
    setIndex(0)
    setOffset(0)
  }

  const selectionDescription = createMemo(() => {
    const action = selected()
    if (!action) return "Choose an item from the list"
    if (action.kind === "session") return "Open this chat"
    if (action.kind === "project") return "Prepare a new chat in this folder"
    return "Run this action"
  })

  // Flatten groups to rows, then window the rows while keeping the header that
  // introduces each visible run.
  const visible = createMemo(() => {
    const start = offset()
    const end = start + resultRows()
    const out = []
    let flat = 0
    for (const group of groups()) {
      let headerEmitted = false
      for (const row of group.rows) {
        const current = flat
        flat += 1
        if (current < start || current >= end) continue
        if (!headerEmitted) {
          out.push({ kind: "group", label: group.label, count: group.rows.length, key: `g:${group.kind}` })
          headerEmitted = true
        }
        out.push({ kind: "row", action: row, flatIndex: current, key: row.id })
      }
    }
    return out
  })

  return (
    <box
      flexDirection="column"
      paddingLeft={2}
      paddingRight={2}
      paddingBottom={1}
      gap={1}
      backgroundColor={tokens().panelOpaque ?? tokens().panel}
    >
      <box flexDirection="row" gap={1} flexShrink={0} alignItems="center">
        <text fg={tokens().accent} wrapMode="none" selectable={false}>
          {GLYPH.diamond}
        </text>
        <text fg={tokens().text} wrapMode="none" selectable={false}>
          <b>Find anything</b>
        </text>
        <text fg={tokens().muted} wrapMode="none" selectable={false}>
          chats, folders and things you can do
        </text>
        <box flexGrow={1} />
        <Show when={props.loading?.()}>
          <Spinner tokens={tokens()} tone="accent" />
        </Show>
        <text fg={tokens().muted} wrapMode="none" selectable={false}>
          {actions().length} found
        </text>
      </box>

      <SegmentedControl tokens={tokens()} items={FILTERS} value={parsed().mode} onChange={setMode} />

      <TextInput
        tokens={tokens()}
        glyph={GLYPH.pointer}
        value={parsed().term}
        placeholder="Search chats, folders and actions"
        autoFocus
        onInput={(value) => {
          const prefix = MODES[parsed().mode]?.prefix ?? ""
          setQuery(`${prefix}${value}`)
          setIndex(0)
          setOffset(0)
        }}
        onSubmit={() => run(selected())}
        onKeyDown={handleKey}
      />

      <box flexDirection="row" flexShrink={0}>
        <box flexDirection="column" width={layout().list} flexShrink={0}>
          <Show
            when={actions().length}
            fallback={
              <EmptyState
                tokens={tokens()}
                title="Nothing matches that search"
                hint="Backspace to widen, or esc to close"
              />
            }
          >
            <For each={visible()}>
              {(entry) => (
                <Show
                  when={entry.kind === "row"}
                  fallback={
                    <box flexShrink={0} height={1}>
                      <SectionLabel tokens={tokens()} meta={entry.count}>
                        {entry.label}
                      </SectionLabel>
                    </box>
                  }
                >
                  <ActionRow
                    tokens={tokens()}
                    columns={layout().columns}
                    action={entry.action}
                    flatIndex={entry.flatIndex}
                    selected={entry.flatIndex === index()}
                    animateIndex={entry.flatIndex - offset()}
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

      <box flexDirection="row" flexShrink={0} height={3} gap={2} alignItems="center">
        <Button
          tokens={tokens()}
          variant="primary"
          size="lg"
          glyph={GLYPH.pointer}
          description={selectionDescription()}
          disabled={!selected()}
          onPress={() => run(selected())}
        >
          Open selected
        </Button>
        <Button tokens={tokens()} variant="ghost" onPress={() => props.onClose?.()}>
          Cancel
        </Button>
        <box flexGrow={1} />
        <KeyHints tokens={tokens()} hints={HINTS} />
      </box>
    </box>
  )
}
