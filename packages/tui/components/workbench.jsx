/** @jsxImportSource @opentui/solid */
// The Alonix workbench: a full-screen IDE route.
//
// Registered through `api.route.register`, so it owns the whole viewport rather
// than decorating the host's chrome. Layout is three panes plus a tab strip:
//
//   explorer (projects/sessions)  |  main (tabs + focused session)  |  detail
//
// Panes drop progressively as the terminal narrows. All state transitions run
// through the pure workbench reducers; this component only renders and routes
// keyboard intent.

import { createMemo, For, Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { GLYPH } from "../lib/design.js"
import { classifyKey } from "../lib/keys.js"
import { fit, workbenchLayout } from "../lib/layout.js"
import { tabsWithSlots } from "../lib/workbench.js"
import { compactPath, fileKind, healthLabel, healthTone, splitPath, workspaceSnapshot } from "../lib/workspace.js"
import {
  Badge,
  DiffStat,
  EmptyState,
  Gauge,
  KeyHints,
  MetricTile,
  Panel,
  PathLabel,
  Row,
  Rule,
  SectionLabel,
  Spinner,
  StatLine,
  StatusDot,
} from "./ide-kit.jsx"

const HINTS = [
  { key: "ctrl+p", label: "palette" },
  { key: "1-9", label: "tab" },
  { key: "tab", label: "pane" },
  { key: "^w", label: "close" },
  { key: "↵", label: "open" },
  { key: "esc", label: "session" },
]

const KIND_GLYPH = {
  code: "◆",
  config: "◇",
  doc: "▤",
  style: "◑",
  asset: "▣",
  test: "◎",
  file: "▪",
}

/** Left rail: projects with their sessions nested underneath. */
function Explorer(props) {
  const tokens = () => props.tokens
  const rows = createMemo(() => props.projects ?? [])

  // One flat, index-addressable list so keyboard navigation is unambiguous.
  const entries = createMemo(() => {
    const out = []
    for (const project of rows()) {
      out.push({ kind: "project", project })
      if (props.collapsed.has(project.id)) continue
      for (const session of project.sessions) out.push({ kind: "session", session, project })
    }
    return out
  })

  return (
    <box flexDirection="column" width={props.width} flexShrink={0} paddingLeft={1} paddingRight={1} gap={0}>
      <box flexDirection="row" gap={1} flexShrink={0} paddingBottom={1}>
        <SectionLabel tokens={tokens()} meta={`${props.summary.projects}`}>
          Projects
        </SectionLabel>
        <box flexGrow={1} />
        <Show when={props.summary.running > 0}>
          <Badge tokens={tokens()} tone="accent">
            {props.summary.running}
          </Badge>
        </Show>
      </box>

      <Show
        when={entries().length}
        fallback={<EmptyState tokens={tokens()} title="No projects yet" hint="Send a prompt to start one" />}
      >
        <scrollbox flexGrow={1} stickyScroll={false}>
          <For each={entries()}>
            {(entry, position) => (
              <Show
                when={entry.kind === "project"}
                fallback={
                  <Row
                    tokens={tokens()}
                    tone={entry.session?.running ? "accent" : "neutral"}
                    selected={props.focused && position() === props.index}
                    onSelect={() => props.onOpenSession(entry.session, entry.project)}
                    meta={entry.session?.relative}
                    leading={
                      <box width={3} flexShrink={0} flexDirection="row" gap={1}>
                        <text fg={tokens().borderFaint} wrapMode="none" selectable={false}>
                          {" "}
                        </text>
                        <Show
                          when={entry.session?.running}
                          fallback={
                            <text
                              fg={entry.session?.active ? tokens().success : tokens().faint}
                              wrapMode="none"
                              selectable={false}
                            >
                              {entry.session?.active ? GLYPH.diamond : GLYPH.bullet}
                            </text>
                          }
                        >
                          <Spinner tokens={tokens()} tone="accent" />
                        </Show>
                      </box>
                    }
                  >
                    <text
                      fg={entry.session?.untitled ? tokens().muted : tokens().text}
                      wrapMode="none"
                      selectable={false}
                    >
                      {fit(entry.session?.title ?? "", props.width - 12)}
                    </text>
                  </Row>
                }
              >
                <Row
                  tokens={tokens()}
                  tone={entry.project.current ? "success" : "neutral"}
                  selected={props.focused && position() === props.index}
                  onSelect={() => props.onToggleProject(entry.project)}
                  meta={entry.project.sessionCount ? String(entry.project.sessionCount) : ""}
                  leading={
                    <text fg={tokens().faint} wrapMode="none" selectable={false}>
                      {props.collapsed.has(entry.project.id) ? GLYPH.caretRight : GLYPH.caretDown}
                    </text>
                  }
                >
                  <box flexDirection="row" gap={1} minWidth={0}>
                    <text
                      fg={entry.project.current ? tokens().success : tokens().text}
                      wrapMode="none"
                      selectable={false}
                    >
                      <b>{fit(entry.project.name, props.width - 14)}</b>
                    </text>
                    <Show when={entry.project.pinned}>
                      <text fg={tokens().accent} wrapMode="none" selectable={false}>
                        {GLYPH.ring}
                      </text>
                    </Show>
                  </box>
                </Row>
              </Show>
            )}
          </For>
        </scrollbox>
      </Show>
    </box>
  )
}

/** Tab strip across the top of the main pane. */
function TabStrip(props) {
  const tokens = () => props.tokens
  return (
    <box flexDirection="row" flexShrink={0} gap={0} backgroundColor={tokens().panel}>
      <Show
        when={props.tabs.length}
        fallback={
          <box paddingLeft={1} paddingRight={1}>
            <text fg={tokens().faint} wrapMode="none" selectable={false}>
              No open sessions — press ctrl+p to find one
            </text>
          </box>
        }
      >
        <For each={props.tabs}>
          {(tab) => (
            <box
              flexDirection="row"
              gap={1}
              flexShrink={1}
              minWidth={0}
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={tab.active ? tokens().surface : undefined}
              onMouseDown={() => props.onActivate(tab.id)}
            >
              <text fg={tab.active ? tokens().accent : tokens().faint} wrapMode="none" selectable={false}>
                {tab.pinned ? GLYPH.ring : (tab.slot ?? GLYPH.bullet)}
              </text>
              <text fg={tab.active ? tokens().text : tokens().muted} wrapMode="none" selectable={false}>
                {tab.active ? <b>{fit(tab.title, 22)}</b> : fit(tab.title, 18)}
              </text>
            </box>
          )}
        </For>
      </Show>
    </box>
  )
}

/** Main pane: the focused session's live state. */
function SessionView(props) {
  const tokens = () => props.tokens
  const snapshot = createMemo(() => workspaceSnapshot(props.api, props.sessionID))
  const files = createMemo(() => snapshot().files.slice(0, 12))
  const todos = createMemo(() => snapshot().todos.slice(0, 8))

  return (
    <box flexDirection="column" flexGrow={1} minWidth={0} paddingLeft={1} paddingRight={1} gap={1}>
      <Show
        when={props.sessionID}
        fallback={
          <EmptyState
            tokens={tokens()}
            title="No session open"
            hint="Pick one from the explorer, or press ctrl+p to search every project"
          />
        }
      >
        <box flexDirection="row" gap={1} flexShrink={0} paddingTop={1}>
          <StatusDot tokens={tokens()} tone={healthTone(snapshot())} pulse={snapshot().busy} />
          <text fg={tokens().text} wrapMode="none" selectable={false}>
            <b>{fit(props.title || snapshot().sessionTitle || "Session", props.width - 24)}</b>
          </text>
          <box flexGrow={1} />
          <text fg={tokens().faint} wrapMode="none" selectable={false}>
            {healthLabel(snapshot())}
          </text>
        </box>

        <text fg={tokens().faint} wrapMode="none" selectable={false}>
          {compactPath(props.directory || snapshot().directory, props.width - 2)}
        </text>

        <box flexDirection="row" gap={2} flexShrink={0} flexWrap="wrap">
          <MetricTile tokens={tokens()} tone="accent" value={snapshot().changedFiles} label="changed" width={10} />
          <MetricTile tokens={tokens()} tone="success" value={`+${snapshot().additions}`} label="added" width={10} />
          <MetricTile tokens={tokens()} tone="error" value={`-${snapshot().deletions}`} label="removed" width={10} />
          <MetricTile tokens={tokens()} tone="accent" value={snapshot().activeTodos} label="todo" width={10} />
        </box>

        <Show when={snapshot().attention > 0}>
          <Panel tokens={tokens()} title="Needs you" glyph={GLYPH.diamond} tone="warning">
            <text fg={tokens().warning} wrapMode="none" selectable={false}>
              {snapshot().permissions} permission{snapshot().permissions === 1 ? "" : "s"} · {snapshot().questions}{" "}
              question{snapshot().questions === 1 ? "" : "s"}
            </text>
          </Panel>
        </Show>

        <Show when={todos().length}>
          <Panel
            tokens={tokens()}
            title="Plan"
            glyph={GLYPH.square}
            tone="accent"
            meta={`${snapshot().activeTodos} active · ${snapshot().completedTodos} done`}
          >
            <For each={todos()}>
              {(todo) => (
                <box flexDirection="row" gap={1} flexShrink={0}>
                  <text
                    fg={
                      todo.status === "completed"
                        ? tokens().success
                        : todo.status === "in_progress"
                          ? tokens().accent
                          : tokens().faint
                    }
                    wrapMode="none"
                    selectable={false}
                  >
                    {todo.status === "completed" ? GLYPH.ok : todo.status === "in_progress" ? GLYPH.pointer : GLYPH.bullet}
                  </text>
                  <text
                    fg={todo.status === "completed" ? tokens().faint : tokens().text}
                    wrapMode="none"
                    selectable={false}
                  >
                    {fit(String(todo.content ?? ""), props.width - 6)}
                  </text>
                </box>
              )}
            </For>
          </Panel>
        </Show>

        <Show when={files().length}>
          <Panel
            tokens={tokens()}
            title="Changes"
            glyph={GLYPH.diamond}
            tone="warning"
            meta={`+${snapshot().additions} -${snapshot().deletions}`}
          >
            <For each={files()}>
              {(file) => {
                const parts = splitPath(file.file, props.width - 16)
                return (
                  <box flexDirection="row" gap={1} flexShrink={0}>
                    <text fg={tokens().faint} wrapMode="none" selectable={false}>
                      {KIND_GLYPH[fileKind(file.file)] ?? GLYPH.square}
                    </text>
                    <PathLabel
                      tokens={tokens()}
                      dir={parts.dir}
                      name={parts.name}
                      dirWidth={Math.max(8, Math.floor(props.width * 0.3))}
                      nameWidth={Math.max(10, Math.floor(props.width * 0.4))}
                    />
                    <box flexGrow={1} />
                    <DiffStat tokens={tokens()} additions={file.additions} deletions={file.deletions} />
                  </box>
                )
              }}
            </For>
            <Show when={snapshot().changedFiles > files().length}>
              <text fg={tokens().faint} wrapMode="none" selectable={false}>
                +{snapshot().changedFiles - files().length} more
              </text>
            </Show>
          </Panel>
        </Show>
      </Show>
    </box>
  )
}

/** Right pane: portfolio overview across every project. */
function DetailPane(props) {
  const tokens = () => props.tokens
  const snapshot = createMemo(() => workspaceSnapshot(props.api, props.sessionID))

  return (
    <box flexDirection="column" width={props.width} flexShrink={0} paddingLeft={1} paddingRight={1} gap={1}>
      <Panel tokens={tokens()} title="Portfolio" glyph={GLYPH.square} tone="accent">
        <StatLine tokens={tokens()} label="projects" labelWidth={props.width - 10}>
          {props.summary.projects}
        </StatLine>
        <StatLine tokens={tokens()} label="sessions" labelWidth={props.width - 10}>
          {props.summary.sessions}
        </StatLine>
        <StatLine tokens={tokens()} label="running" labelWidth={props.width - 10}>
          {props.summary.running}
        </StatLine>
        <StatLine tokens={tokens()} label="with changes" labelWidth={props.width - 10}>
          {props.summary.withWork}
        </StatLine>
      </Panel>

      <Show when={snapshot().context.tokens > 0}>
        <Panel tokens={tokens()} title="Context" glyph={GLYPH.ring} tone="accent">
          <box flexDirection="row" gap={1} flexShrink={0}>
            <Gauge
              tokens={tokens()}
              tone={snapshot().context.percent > 85 ? "warning" : "accent"}
              percent={snapshot().context.percent ?? 0}
              width={Math.max(6, props.width - 12)}
            />
            <text fg={tokens().muted} wrapMode="none" selectable={false}>
              {snapshot().context.percent ?? 0}%
            </text>
          </box>
          <StatLine tokens={tokens()} label="tokens" labelWidth={props.width - 12}>
            {snapshot().context.tokens.toLocaleString()}
          </StatLine>
        </Panel>
      </Show>

      <Panel tokens={tokens()} title="Environment" glyph={GLYPH.square} tone="neutral">
        <box flexDirection="row" gap={2} flexShrink={0}>
          <box flexDirection="row" gap={1}>
            <StatusDot
              tokens={tokens()}
              tone={snapshot().lspTotal && snapshot().lspReady < snapshot().lspTotal ? "warning" : "success"}
            />
            <text fg={tokens().muted} wrapMode="none" selectable={false}>
              LSP {snapshot().lspReady}/{snapshot().lspTotal}
            </text>
          </box>
          <box flexDirection="row" gap={1}>
            <StatusDot tokens={tokens()} tone={snapshot().mcpFailed ? "error" : "success"} />
            <text fg={tokens().muted} wrapMode="none" selectable={false}>
              MCP {snapshot().mcpReady}/{snapshot().mcpTotal}
            </text>
          </box>
        </box>
      </Panel>
    </box>
  )
}

export function Workbench(props) {
  const tokens = props.tokens
  const store = props.store
  const dimensions = useTerminalDimensions()
  const layout = createMemo(() => workbenchLayout(dimensions()))
  const projects = createMemo(() => store.projectRows())
  const summary = createMemo(() => store.summary())
  const tabs = createMemo(() => tabsWithSlots(store.workbench))
  const active = createMemo(() => tabs().find((tab) => tab.active) ?? null)

  const explorerEntries = createMemo(() => {
    const out = []
    for (const project of projects()) {
      out.push({ kind: "project", project })
      if (store.workbench.collapsed.has(project.id)) continue
      for (const session of project.sessions) out.push({ kind: "session", session, project })
    }
    return out
  })

  const openSession = (session, project) => {
    if (!session) return
    store.openTab({
      id: session.id,
      title: session.title,
      projectID: project?.id ?? null,
      projectName: project?.name ?? "",
      directory: session.directory,
    })
    props.onOpenSession?.(session.id)
  }

  const handleKey = (event) => {
    const action = classifyKey(event)
    const name = String(event?.name ?? "").toLowerCase()

    if (action === "dismiss") {
      props.onExit?.()
      return
    }
    if (event?.ctrl && name === "p") {
      props.onPalette?.()
      return
    }
    if (event?.ctrl && name === "w") {
      if (active()) store.closeTab(active().id)
      return
    }
    if (action === "next-pane" || action === "prev-pane") {
      const available = ["main"]
      if (layout().showExplorer) available.unshift("explorer")
      if (layout().showDetail) available.push("detail")
      props.onCyclePane?.(action === "next-pane" ? 1 : -1, available)
      return
    }
    if (/^[1-9]$/.test(name)) {
      store.activateSlot(Number(name))
      const tab = tabsWithSlots(store.workbench).find((item) => item.slot === Number(name))
      if (tab) props.onOpenSession?.(tab.id)
      return
    }

    if (store.workbench.focus === "explorer") {
      const entries = explorerEntries()
      if (action === "up" || action === "down") {
        const next = Math.max(
          0,
          Math.min(entries.length - 1, store.workbench.explorerIndex + (action === "down" ? 1 : -1)),
        )
        props.onExplorerIndex?.(next)
        return
      }
      if (action === "confirm") {
        const entry = entries[store.workbench.explorerIndex]
        if (entry?.kind === "session") openSession(entry.session, entry.project)
        else if (entry?.kind === "project") store.toggleCollapsed(entry.project.id)
        return
      }
    }

    if (action === "left") store.cycleTab(-1)
    if (action === "right") store.cycleTab(1)
  }

  return (
    <box
      width={dimensions().width}
      height={dimensions().height}
      flexDirection="column"
      backgroundColor={tokens().canvas}
      focusable
      focused
      onKeyDown={handleKey}
    >
      <box
        flexDirection="row"
        flexShrink={0}
        gap={2}
        paddingLeft={1}
        paddingRight={1}
        backgroundColor={tokens().panel}
      >
        <box flexDirection="row" gap={1}>
          <text fg={tokens().accent} wrapMode="none" selectable={false}>
            {GLYPH.diamond}
          </text>
          <text fg={tokens().text} wrapMode="none" selectable={false}>
            <b>Alonix Workbench</b>
          </text>
        </box>
        <box flexGrow={1} />
        <text fg={tokens().faint} wrapMode="none" selectable={false}>
          {summary().projects} projects · {summary().sessions} sessions
        </text>
        <Show when={summary().running > 0}>
          <Badge tokens={tokens()} tone="accent">
            {summary().running} working
          </Badge>
        </Show>
        <Show when={store.loading}>
          <Spinner tokens={tokens()} tone="accent" />
        </Show>
      </box>

      <box flexDirection="row" flexGrow={1} minHeight={0}>
        <Show when={layout().showExplorer}>
          <Explorer
            tokens={tokens()}
            width={layout().explorer}
            projects={projects()}
            summary={summary()}
            collapsed={store.workbench.collapsed}
            index={store.workbench.explorerIndex}
            focused={store.workbench.focus === "explorer"}
            onOpenSession={openSession}
            onToggleProject={(project) => store.toggleCollapsed(project.id)}
          />
        </Show>

        <box flexDirection="column" flexGrow={1} minWidth={0}>
          <TabStrip tokens={tokens()} tabs={tabs()} onActivate={(id) => store.activateTab(id)} />
          <SessionView
            api={props.api}
            tokens={tokens()}
            sessionID={active()?.id ?? null}
            title={active()?.title ?? ""}
            directory={active()?.directory ?? ""}
            width={layout().main}
          />
        </box>

        <Show when={layout().showDetail}>
          <DetailPane
            api={props.api}
            tokens={tokens()}
            width={layout().detail}
            summary={summary()}
            sessionID={active()?.id ?? null}
          />
        </Show>
      </box>

      <Rule tokens={tokens()} />
      <box flexShrink={0} paddingLeft={1} paddingRight={1}>
        <KeyHints tokens={tokens()} hints={HINTS} />
      </box>
    </box>
  )
}
