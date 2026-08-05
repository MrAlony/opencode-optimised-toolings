/** @jsxImportSource @opentui/solid */
// Persistent project navigator. Geometry never changes under the pointer.

import { createMemo, For, Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { Button, ClickRow } from "./controls.jsx"
import { GLYPH } from "../lib/design.js"
import { liveActivity } from "../lib/activity.js"
import { fit } from "../lib/layout.js"
import { spinnerFrame } from "../lib/motion.js"
import { useClock } from "./runtime.jsx"

export const DOCK_EXPANDED = 36
export const DOCK_COLLAPSED = 4

export function dockWidth(expanded, viewportWidth) {
  const width = Math.max(20, Math.floor(Number(viewportWidth) || 80))
  if (!expanded) return DOCK_COLLAPSED
  return Math.max(24, Math.min(DOCK_EXPANDED, Math.floor(width / 3)))
}

function SessionRow(props) {
  const tokens = () => props.tokens
  const session = () => props.session
  const clock = useClock(() => session().running === true && tokens().motion !== false)
  const activity = createMemo(() => {
    if (!props.api || !session().running) return null
    void clock()
    return liveActivity(props.api, session().id, { limit: 1 })
  })
  const glyph = createMemo(() => {
    if (session().running) return spinnerFrame(clock(), undefined, 90, tokens().motion !== false)
    if (session().active) return GLYPH.diamond
    return GLYPH.bullet
  })

  return (
    <box flexDirection="column" flexShrink={0}>
      <ClickRow tokens={tokens()} selected={session().active} onSelect={() => props.onOpen?.(session())}>
        <text wrapMode="none" selectable={false}>
          <span style={{ fg: tokens().borderFaint }}>{"  └ "}</span>
          <span style={{ fg: session().running ? tokens().accent : session().active ? tokens().success : tokens().faint }}>
            {glyph()}
          </span>
          <span style={{ fg: session().active ? tokens().text : tokens().muted }}>
            {" "}{fit(session().title, Math.max(6, props.width - 11))}
          </span>
        </text>
      </ClickRow>
      <Show when={activity()?.busy}>
        <text fg={tokens().accent} wrapMode="none" selectable={false}>
          {"      "}{fit(activity().headline, Math.max(6, props.width - 8))}
        </text>
      </Show>
    </box>
  )
}

function ProjectCard(props) {
  const tokens = () => props.tokens
  const project = () => props.project
  return (
    <box flexDirection="column" flexShrink={0} marginBottom={1} backgroundColor={project().current ? tokens().selection : tokens().panel}>
      <box flexDirection="row" flexShrink={0} height={1}>
        <box
          flexShrink={0}
          width={3}
          onMouseUp={(event) => {
            event?.stopPropagation?.()
            props.onToggle?.()
          }}
        >
          <text fg={tokens().faint} wrapMode="none" selectable={false}>
            {" "}{props.collapsed ? GLYPH.caretRight : GLYPH.caretDown}
          </text>
        </box>
        <box
          flexGrow={1}
          minWidth={0}
          onMouseUp={project().openable ? () => props.onOpen?.(project()) : undefined}
        >
          <text fg={project().openable ? (project().current ? tokens().success : tokens().text) : tokens().faint} wrapMode="none" selectable={false}>
            <b>{fit(project().name, Math.max(6, props.width - 14))}</b>
          </text>
        </box>
        <box
          flexShrink={0}
          width={3}
          onMouseUp={project().openable ? (event) => {
            event?.stopPropagation?.()
            props.onNew?.(project())
          } : undefined}
        >
          <text fg={project().openable ? tokens().accent : tokens().faint} wrapMode="none" selectable={false}>
            {project().openable ? GLYPH.plus : " "}
          </text>
        </box>
        <box
          flexShrink={0}
          width={3}
          onMouseUp={project().worktree ? (event) => {
            event?.stopPropagation?.()
            props.onHide?.(project())
          } : undefined}
        >
          <text fg={tokens().faint} wrapMode="none" selectable={false}>
            {project().worktree ? GLYPH.close : " "}
          </text>
        </box>
      </box>
      <box flexDirection="row" flexShrink={0} paddingLeft={3} paddingRight={1}>
        <text fg={tokens().faint} wrapMode="none" selectable={false}>
          {project().running > 0 ? `${project().running} working · ` : ""}{project().sessionCount} chat{project().sessionCount === 1 ? "" : "s"}
        </text>
      </box>
    </box>
  )
}

function Rail(props) {
  const tokens = () => props.tokens
  return (
    <box width={DOCK_COLLAPSED} height={props.height} flexShrink={0} flexDirection="column" backgroundColor={tokens().panelOpaque ?? tokens().panel}>
      <Button tokens={tokens()} variant="ghost" size="sm" glyph={GLYPH.caretRight} onPress={() => props.onToggle?.()}>{""}</Button>
      <Show when={props.running > 0}>
        <text fg={tokens().accent} wrapMode="none" selectable={false}>{" "}{GLYPH.dot}</text>
      </Show>
      <box flexGrow={1} />
      <Button tokens={tokens()} variant="ghost" size="sm" glyph={GLYPH.square} onPress={() => props.onAddProject?.()}>{""}</Button>
    </box>
  )
}

export function Dock(props) {
  const tokens = props.tokens
  const store = props.store
  const dimensions = useTerminalDimensions()
  const expanded = () => props.expanded?.() !== false
  const width = createMemo(() => dockWidth(expanded(), dimensions().width))
  const height = createMemo(() => Math.max(4, dimensions().height))
  const projects = createMemo(() => store.projectRows())
  const summary = createMemo(() => store.summary())
  const hiddenCount = () => store.hiddenProjects?.length ?? 0

  return (
    <box flexShrink={0} width={width()} height={height()}>
      <Show when={expanded()} fallback={<Rail tokens={tokens()} height={height()} running={summary().running} onToggle={props.onToggle} onAddProject={props.onAddProject} />}>
        <box flexDirection="column" width={width()} height={height()} backgroundColor={tokens().panelOpaque ?? tokens().panel}>
          <box flexDirection="row" flexShrink={0} height={3} paddingLeft={1} paddingRight={1} alignItems="center" backgroundColor={tokens().surface}>
            <box flexDirection="column" flexGrow={1} minWidth={0}>
              <text fg={tokens().text} wrapMode="none" selectable={false}><b>Workspaces</b></text>
              <text fg={tokens().faint} wrapMode="none" selectable={false}>
                {summary().projects} folders · {summary().running} working
              </text>
            </box>
            <Button tokens={tokens()} variant="ghost" size="sm" glyph={GLYPH.close} onPress={props.onToggle}>{""}</Button>
          </box>

          <box flexDirection="column" flexShrink={0} paddingLeft={1} paddingRight={1} paddingTop={1} gap={1}>
            <Button tokens={tokens()} variant="primary" size="lg" glyph={GLYPH.pointer} description="Pick where the new chat belongs" onPress={props.onChooseProject}>
              Choose a folder
            </Button>
            <box flexDirection="row" gap={1}>
              <Button tokens={tokens()} variant="secondary" glyph={GLYPH.square} onPress={props.onAddProject}>Add folder</Button>
              <Button tokens={tokens()} variant="secondary" glyph={GLYPH.diamond} onPress={props.onWorkbench}>Dashboard</Button>
            </box>
          </box>

          <box flexDirection="row" flexShrink={0} paddingLeft={1} paddingRight={1} paddingTop={1}>
            <text fg={tokens().muted} wrapMode="none" selectable={false}><b>YOUR FOLDERS</b></text>
            <box flexGrow={1} />
            <text fg={tokens().faint} wrapMode="none" selectable={false}>+ new · × hide</text>
          </box>

          <scrollbox flexGrow={1} stickyScroll={false} paddingTop={1}>
            <Show when={projects().length} fallback={<box paddingLeft={1} paddingRight={1}><text fg={tokens().muted} wrapMode="wrap" selectable={false}>{store.loading ? "Loading folders…" : "No folders yet. Add one to start working."}</text></box>}>
              <For each={projects()}>
                {(project) => (
                  <box flexDirection="column" flexShrink={0}>
                    <ProjectCard
                      tokens={tokens()}
                      project={project}
                      width={width()}
                      collapsed={store.workbench.collapsed.has(project.id)}
                      onToggle={() => store.toggleCollapsed(project.id)}
                      onOpen={props.onOpenProject}
                      onNew={props.onNewSessionIn}
                      onHide={props.onHideProject}
                    />
                    <Show when={!store.workbench.collapsed.has(project.id)}>
                      <For each={project.sessions}>
                        {(session) => <SessionRow api={props.api} tokens={tokens()} session={session} width={width()} onOpen={props.onOpen} />}
                      </For>
                      <Show when={project.sessionCount === 0 && project.openable}>
                        <ClickRow tokens={tokens()} onSelect={() => props.onNewSessionIn?.(project)}>
                          <text fg={tokens().muted} wrapMode="none" selectable={false}>{"  └ "}{GLYPH.plus} new chat here</text>
                        </ClickRow>
                      </Show>
                      <Show when={!project.openable}>
                        <text fg={tokens().faint} wrapMode="none" selectable={false}>{"  └ directory unavailable"}</text>
                      </Show>
                    </Show>
                  </box>
                )}
              </For>
            </Show>
          </scrollbox>

          <Show when={hiddenCount() > 0}>
            <Button tokens={tokens()} variant="ghost" glyph={GLYPH.caretDown} onPress={() => store.showAllProjects?.()}>
              Restore {hiddenCount()} hidden folder{hiddenCount() === 1 ? "" : "s"}
            </Button>
          </Show>
        </box>
      </Show>
    </box>
  )
}
