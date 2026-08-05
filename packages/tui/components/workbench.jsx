/** @jsxImportSource @opentui/solid */
// The Alonix workbench: a full-screen, mouse-first IDE route.
//
// Registered through `api.route.register`, so it owns the whole viewport rather
// than decorating the host's chrome:
//
//   explorer (projects/sessions)  |  tabs + live session  |  activity/detail
//
// Design intent: everything is clickable. A user who never learns a shortcut
// can still switch projects, open and close sessions, start new work, and watch
// the agent run. Shortcuts are shown next to their controls so the pointer path
// teaches the keyboard path.
//
// Widths are computed as exact cell counts and rows are clipped, because flex
// shrinking inside a fixed-width terminal panel silently destroys labels.

import { createMemo, For, Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { GLYPH } from "../lib/design.js"
import { liveActivity } from "../lib/activity.js"
import { classifyKey } from "../lib/keys.js"
import { fit, fitLeft, pad, workbenchLayout } from "../lib/layout.js"
import { tabsWithSlots } from "../lib/workbench.js"
import { fileKind, healthLabel, healthTone, splitPath, workspaceSnapshot } from "../lib/workspace.js"
import { DiffStat, EmptyState, Gauge, KeyHints, Panel, Rule, SectionLabel, StatLine, StatusDot } from "./ide-kit.jsx"
import { ActivityLine, Button, ClickRow, SegmentedControl, Tab, Toolbar } from "./controls.jsx"

const HINTS = [
  { key: "ctrl+p", label: "search" },
  { key: "1-9", label: "tab" },
  { key: "tab", label: "pane" },
  { key: "^w", label: "close" },
  { key: "click", label: "anything" },
  { key: "esc", label: "chat" },
]

const KIND_GLYPH = { code: "◆", config: "◇", doc: "▤", style: "◑", asset: "▣", test: "◎", file: "▪" }

/**
 * Left rail: every project and its sessions.
 *
 * Rows are pre-flattened by the parent so click and keyboard selection share
 * one index space and can never disagree.
 */
function Explorer(props) {
  const tokens = () => props.tokens
  const width = () => props.width
  // Row text budget: width minus the selection bar, glyph, and padding.
  const labelWidth = () => Math.max(6, width() - 8)

  return (
    <box flexDirection="column" width={width()} flexShrink={0} paddingLeft={1} paddingRight={1}>
      <box flexDirection="row" flexShrink={0} height={1} gap={1}>
        <SectionLabel tokens={tokens()} meta={String(props.summary.projects)}>
          Explorer
        </SectionLabel>
        <box flexGrow={1} />
        <Button tokens={tokens()} tone="accent" glyph={GLYPH.plus} onPress={() => props.onNewSession()}>
          New
        </Button>
      </box>

      <Show
        when={props.entries.length}
        fallback={<EmptyState tokens={tokens()} title="No projects" hint="Press New to begin" />}
      >
        <scrollbox flexGrow={1} stickyScroll={false}>
          <For each={props.entries}>
            {(entry, position) => (
              <Show
                when={entry.kind === "project"}
                fallback={
                  <ClickRow
                    tokens={tokens()}
                    selected={props.focused && position() === props.index}
                    onHover={() => props.onHover(position())}
                    onSelect={() => props.onOpenSession(entry.session, entry.project)}
                  >
                    <text wrapMode="none" selectable={false}>
                      <span style={{ fg: tokens().borderFaint }}>{"  "}</span>
                      <span
                        style={{
                          fg: entry.session.running
                            ? tokens().accent
                            : entry.session.active
                              ? tokens().success
                              : tokens().faint,
                        }}
                      >
                        {entry.session.running ? GLYPH.dot : entry.session.active ? GLYPH.diamond : GLYPH.bullet}
                      </span>
                      <span
                        style={{
                          fg: entry.session.active
                            ? tokens().text
                            : entry.session.untitled
                              ? tokens().faint
                              : tokens().muted,
                        }}
                      >
                        {" "}
                        {fit(entry.session.title, labelWidth() - 3)}
                      </span>
                    </text>
                  </ClickRow>
                }
              >
                <ClickRow
                  tokens={tokens()}
                  selected={props.focused && position() === props.index}
                  onHover={() => props.onHover(position())}
                  onSelect={() => props.onToggleProject(entry.project)}
                >
                  <text wrapMode="none" selectable={false}>
                    <span style={{ fg: tokens().faint }}>
                      {props.collapsed.has(entry.project.id) ? GLYPH.caretRight : GLYPH.caretDown}
                    </span>
                    <span style={{ fg: entry.project.current ? tokens().success : tokens().text }}>
                      {" "}
                      <b>{fit(entry.project.name, labelWidth() - 6)}</b>
                    </span>
                    <span style={{ fg: entry.project.running ? tokens().accent : tokens().faint }}>
                      {" "}
                      {entry.project.running ? `${entry.project.running}●` : String(entry.project.sessionCount)}
                    </span>
                  </text>
                </ClickRow>
              </Show>
            )}
          </For>
        </scrollbox>
      </Show>
    </box>
  )
}

/** Live "what is the agent doing" feed. */
function ActivityPanel(props) {
  const tokens = () => props.tokens
  const activity = () => props.activity
  return (
    <Panel
      tokens={tokens()}
      title="Activity"
      glyph={GLYPH.dot}
      tone={activity().busy ? "accent" : "neutral"}
      meta={activity().busy ? "live" : "idle"}
    >
      <ActivityLine tokens={tokens()} busy={activity().busy} width={props.width - 4}>
        {activity().headline}
      </ActivityLine>
      <Show when={activity().events.length}>
        <box flexDirection="column" flexShrink={0} paddingTop={1}>
          <For each={activity().events.slice(0, props.rows ?? 6)}>
            {(event) => (
              <text wrapMode="none" selectable={false}>
                <span
                  style={{
                    fg: event.running ? tokens().accent : event.failed ? tokens().error : tokens().success,
                  }}
                >
                  {event.running ? GLYPH.pointer : event.failed ? GLYPH.fail : GLYPH.ok}
                </span>
                <span style={{ fg: event.running ? tokens().text : tokens().muted }}>
                  {" "}
                  {fit(event.label, props.width - 8)}
                </span>
              </text>
            )}
          </For>
        </box>
      </Show>
    </Panel>
  )
}

/** Main pane: the focused session. */
function SessionView(props) {
  const tokens = () => props.tokens
  const width = () => props.width
  const snapshot = createMemo(() => workspaceSnapshot(props.api, props.sessionID))
  const activity = createMemo(() => {
    // Re-read on every clock tick so the feed stays live while the agent runs.
    void props.tick?.()
    return liveActivity(props.api, props.sessionID, { limit: 8 })
  })
  const files = createMemo(() => snapshot().files.slice(0, props.view === "changes" ? 20 : 8))
  const todos = createMemo(() => snapshot().todos.slice(0, props.view === "plan" ? 20 : 6))

  return (
    <box flexDirection="column" flexGrow={1} minWidth={0} paddingLeft={1} paddingRight={1}>
      <Show
        when={props.sessionID}
        fallback={
          <box flexDirection="column" paddingTop={2} gap={1}>
            <EmptyState
              tokens={tokens()}
              title="No session open"
              hint="Click a session on the left, or start something new"
            />
            <box flexDirection="row" gap={2}>
              <Button tokens={tokens()} tone="accent" primary glyph={GLYPH.plus} onPress={() => props.onNewSession()}>
                New session
              </Button>
              <Button tokens={tokens()} glyph={GLYPH.pointer} shortcut="ctrl+p" onPress={() => props.onPalette()}>
                Search everything
              </Button>
            </box>
          </box>
        }
      >
        <box flexDirection="row" flexShrink={0} height={1} gap={1} paddingTop={0}>
          <StatusDot tokens={tokens()} tone={healthTone(snapshot())} pulse={activity().busy} />
          <text fg={tokens().text} wrapMode="none" selectable={false}>
            <b>{fit(props.title || snapshot().sessionTitle || "Session", Math.max(10, width() - 30))}</b>
          </text>
          <box flexGrow={1} />
          <text fg={tokens().faint} wrapMode="none" selectable={false}>
            {healthLabel(snapshot())}
          </text>
        </box>

        <text fg={tokens().faint} wrapMode="none" selectable={false}>
          {fitLeft(props.directory || snapshot().directory, Math.max(10, width() - 2))}
        </text>

        <box flexShrink={0} paddingTop={1}>
          <SegmentedControl
            tokens={tokens()}
            value={props.view}
            onChange={props.onView}
            items={[
              { value: "activity", label: "Activity", count: activity().runningCount || undefined },
              { value: "changes", label: "Changes", count: snapshot().changedFiles || undefined },
              { value: "plan", label: "Plan", count: snapshot().activeTodos || undefined },
            ]}
          />
        </box>

        <box flexDirection="column" flexGrow={1} minHeight={0} paddingTop={1}>
          <Show when={snapshot().attention > 0}>
            <Panel tokens={tokens()} title="Needs you" glyph={GLYPH.diamond} tone="warning">
              <text fg={tokens().warning} wrapMode="none" selectable={false}>
                {snapshot().permissions} permission{snapshot().permissions === 1 ? "" : "s"} · {snapshot().questions}{" "}
                question{snapshot().questions === 1 ? "" : "s"} waiting
              </text>
              <Button tokens={tokens()} tone="warning" primary onPress={() => props.onOpenChat()}>
                Open the conversation
              </Button>
            </Panel>
          </Show>

          <Show when={props.view === "activity"}>
            <ActivityPanel tokens={tokens()} activity={activity()} width={width()} rows={8} />
          </Show>

          <Show when={props.view === "plan"}>
            <Show
              when={todos().length}
              fallback={<EmptyState tokens={tokens()} title="No plan yet" hint="The agent has not written a plan" />}
            >
              <Panel
                tokens={tokens()}
                title="Plan"
                glyph={GLYPH.square}
                tone="accent"
                meta={`${snapshot().activeTodos} active · ${snapshot().completedTodos} done`}
              >
                <For each={todos()}>
                  {(todo) => (
                    <text wrapMode="none" selectable={false}>
                      <span
                        style={{
                          fg:
                            todo.status === "completed"
                              ? tokens().success
                              : todo.status === "in_progress"
                                ? tokens().accent
                                : tokens().faint,
                        }}
                      >
                        {todo.status === "completed"
                          ? GLYPH.ok
                          : todo.status === "in_progress"
                            ? GLYPH.pointer
                            : GLYPH.bullet}
                      </span>
                      <span style={{ fg: todo.status === "completed" ? tokens().faint : tokens().text }}>
                        {" "}
                        {fit(String(todo.content ?? ""), width() - 6)}
                      </span>
                    </text>
                  )}
                </For>
              </Panel>
            </Show>
          </Show>

          <Show when={props.view === "changes"}>
            <Show
              when={files().length}
              fallback={<EmptyState tokens={tokens()} title="No file changes" hint="Nothing has been edited yet" />}
            >
              <Panel
                tokens={tokens()}
                title="Changes"
                glyph={GLYPH.diamond}
                tone="warning"
                meta={`+${snapshot().additions} -${snapshot().deletions}`}
              >
                <For each={files()}>
                  {(file) => {
                    const parts = splitPath(file.file, Math.max(12, width() - 18))
                    return (
                      <box flexDirection="row" flexShrink={0} height={1} gap={1}>
                        <text fg={tokens().faint} wrapMode="none" selectable={false}>
                          {KIND_GLYPH[fileKind(file.file)] ?? GLYPH.square}
                        </text>
                        <text wrapMode="none" selectable={false}>
                          <span style={{ fg: tokens().faint }}>{parts.dir ? `${fitLeft(parts.dir, 20)}/` : ""}</span>
                          <span style={{ fg: tokens().text }}>{fit(parts.name, Math.max(8, width() - 34))}</span>
                        </text>
                        <box flexGrow={1} />
                        <DiffStat tokens={tokens()} additions={file.additions} deletions={file.deletions} />
                      </box>
                    )
                  }}
                </For>
                <Show when={snapshot().changedFiles > files().length}>
                  <text fg={tokens().faint} wrapMode="none" selectable={false}>
                    +{snapshot().changedFiles - files().length} more files
                  </text>
                </Show>
              </Panel>
            </Show>
          </Show>
        </box>

        <Toolbar tokens={tokens()} background={tokens().canvas} inset={false}>
          <Button tokens={tokens()} tone="accent" primary glyph={GLYPH.pointer} onPress={() => props.onOpenChat()}>
            Open chat
          </Button>
          <Button tokens={tokens()} glyph={GLYPH.plus} onPress={() => props.onNewSession()}>
            New
          </Button>
          <Button tokens={tokens()} shortcut="^w" onPress={() => props.onCloseTab()}>
            Close
          </Button>
        </Toolbar>
      </Show>
    </box>
  )
}

/** Right pane: portfolio-wide state, always visible. */
function DetailPane(props) {
  const tokens = () => props.tokens
  const width = () => props.width
  const snapshot = createMemo(() => workspaceSnapshot(props.api, props.sessionID))
  const labelWidth = () => Math.max(8, width() - 12)

  return (
    <box flexDirection="column" width={width()} flexShrink={0} paddingLeft={1} paddingRight={1}>
      <Panel tokens={tokens()} title="All projects" glyph={GLYPH.square} tone="accent">
        <StatLine tokens={tokens()} label="projects" labelWidth={labelWidth()}>
          {props.summary.projects}
        </StatLine>
        <StatLine tokens={tokens()} label="sessions" labelWidth={labelWidth()}>
          {props.summary.sessions}
        </StatLine>
        <StatLine tokens={tokens()} label="working now" labelWidth={labelWidth()}>
          {props.summary.running}
        </StatLine>
        <StatLine tokens={tokens()} label="with changes" labelWidth={labelWidth()}>
          {props.summary.withWork}
        </StatLine>
      </Panel>

      <Show when={props.running.length}>
        <Panel tokens={tokens()} title="Running" glyph={GLYPH.dot} tone="accent" meta={String(props.running.length)}>
          <For each={props.running.slice(0, 6)}>
            {(session) => (
              <ClickRow tokens={tokens()} onSelect={() => props.onOpenSession(session)}>
                <text wrapMode="none" selectable={false}>
                  <span style={{ fg: tokens().accent }}>{GLYPH.dot}</span>
                  <span style={{ fg: tokens().text }}>
                    {" "}
                    {fit(session.title, width() - 8)}
                  </span>
                </text>
              </ClickRow>
            )}
          </For>
        </Panel>
      </Show>

      <Show when={props.sessionID && snapshot().context.tokens > 0}>
        <Panel tokens={tokens()} title="Context" glyph={GLYPH.ring} tone="accent">
          <box flexDirection="row" flexShrink={0} gap={1}>
            <Gauge
              tokens={tokens()}
              tone={snapshot().context.percent > 85 ? "warning" : "accent"}
              percent={snapshot().context.percent ?? 0}
              width={Math.max(6, width() - 14)}
            />
            <text fg={tokens().muted} wrapMode="none" selectable={false}>
              {snapshot().context.percent ?? 0}%
            </text>
          </box>
        </Panel>
      </Show>

      <Panel tokens={tokens()} title="Environment" glyph={GLYPH.square} tone="neutral">
        <box flexDirection="row" flexShrink={0} gap={2}>
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
  const running = createMemo(() => store.sessionRows().filter((session) => session.running))

  const entries = createMemo(() => {
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
      projectID: project?.id ?? session.projectID ?? null,
      projectName: project?.name ?? session.projectName ?? "",
      directory: session.directory,
    })
  }

  const closeActive = () => {
    if (active()) store.closeTab(active().id)
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
    if (event?.ctrl && name === "n") {
      props.onNewSession?.()
      return
    }
    if (event?.ctrl && name === "w") {
      closeActive()
      return
    }
    if (action === "next-pane" || action === "prev-pane") {
      const available = ["main"]
      if (layout().showExplorer) available.unshift("explorer")
      if (layout().showDetail) available.push("detail")
      store.cyclePane(action === "next-pane" ? 1 : -1, available)
      return
    }
    if (/^[1-9]$/.test(name)) {
      store.activateSlot(Number(name))
      return
    }

    if (store.workbench.focus === "explorer") {
      const list = entries()
      if (action === "up" || action === "down") {
        const next = Math.max(0, Math.min(list.length - 1, store.workbench.explorerIndex + (action === "down" ? 1 : -1)))
        store.setExplorerIndex(next)
        return
      }
      if (action === "confirm") {
        const entry = list[store.workbench.explorerIndex]
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
      <Toolbar tokens={tokens()}>
        <text fg={tokens().accent} wrapMode="none" selectable={false}>
          {GLYPH.diamond}
        </text>
        <text fg={tokens().text} wrapMode="none" selectable={false}>
          <b>Alonix</b>
        </text>
        <Button tokens={tokens()} glyph={GLYPH.pointer} shortcut="^p" onPress={() => props.onPalette?.()}>
          Search
        </Button>
        <Button tokens={tokens()} tone="accent" glyph={GLYPH.plus} shortcut="^n" onPress={() => props.onNewSession?.()}>
          New
        </Button>
        <box flexGrow={1} />
        <Show when={summary().running > 0}>
          <text fg={tokens().accent} wrapMode="none" selectable={false}>
            {GLYPH.dot} {summary().running} working
          </text>
        </Show>
        <text fg={tokens().faint} wrapMode="none" selectable={false}>
          {summary().projects}p {summary().sessions}s
        </text>
        <Button tokens={tokens()} onPress={() => props.onExit?.()}>
          Chat
        </Button>
      </Toolbar>

      <box flexDirection="row" flexGrow={1} minHeight={0}>
        <Show when={layout().showExplorer}>
          <Explorer
            tokens={tokens()}
            width={layout().explorer}
            entries={entries()}
            summary={summary()}
            collapsed={store.workbench.collapsed}
            index={store.workbench.explorerIndex}
            focused={store.workbench.focus === "explorer"}
            onHover={(index) => store.setExplorerIndex(index)}
            onOpenSession={openSession}
            onToggleProject={(project) => store.toggleCollapsed(project.id)}
            onNewSession={() => props.onNewSession?.()}
          />
        </Show>

        <box flexDirection="column" flexGrow={1} minWidth={0}>
          <box flexDirection="row" flexShrink={0} height={1} backgroundColor={tokens().panel}>
            <Show
              when={tabs().length}
              fallback={
                <box paddingLeft={1}>
                  <text fg={tokens().faint} wrapMode="none" selectable={false}>
                    No open sessions
                  </text>
                </box>
              }
            >
              <For each={tabs()}>
                {(tab) => (
                  <Tab
                    tokens={tokens()}
                    title={tab.title}
                    slot={tab.slot}
                    active={tab.active}
                    pinned={tab.pinned}
                    running={running().some((session) => session.id === tab.id)}
                    width={tab.active ? 20 : 14}
                    onSelect={() => store.activateTab(tab.id)}
                    onClose={() => store.closeTab(tab.id)}
                  />
                )}
              </For>
            </Show>
          </box>

          <SessionView
            api={props.api}
            tokens={tokens()}
            tick={props.tick}
            sessionID={active()?.id ?? null}
            title={active()?.title ?? ""}
            directory={active()?.directory ?? ""}
            width={layout().main}
            view={props.view?.() ?? "activity"}
            onView={(value) => props.onView?.(value)}
            onPalette={() => props.onPalette?.()}
            onNewSession={() => props.onNewSession?.()}
            onCloseTab={closeActive}
            onOpenChat={() => props.onOpenChat?.(active()?.id ?? null)}
          />
        </box>

        <Show when={layout().showDetail}>
          <DetailPane
            api={props.api}
            tokens={tokens()}
            width={layout().detail}
            summary={summary()}
            running={running()}
            sessionID={active()?.id ?? null}
            onOpenSession={(session) => openSession(session, null)}
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
