/** @jsxImportSource @opentui/solid */
// Portfolio operations workspace: useful live information across the full canvas.

import { createMemo, For, Show } from "solid-js"
import { GLYPH } from "../lib/design.js"
import { liveActivity } from "../lib/activity.js"
import { fit, fitLeft } from "../lib/layout.js"
import { workspaceSnapshot } from "../lib/workspace.js"
import { ActivityLine, Button, ClickRow } from "./controls.jsx"
import { StatusDot } from "./ide-kit.jsx"
import { useClock } from "./runtime.jsx"

const SNAPSHOT_LIMIT = 60
const RECENT_LIMIT = 10
const LIVE_LIMIT = 8

function Card(props) {
  const tokens = () => props.tokens
  return (
    <box
      flexDirection="column"
      flexShrink={props.grow ? 1 : 0}
      flexGrow={props.grow ? 1 : 0}
      minHeight={props.minHeight ?? 4}
      width={props.width}
      border
      borderStyle="rounded"
      borderColor={props.tone === "warning" ? tokens().warning : props.tone === "accent" ? tokens().accent : tokens().borderFaint}
      backgroundColor={tokens().panel}
    >
      <box flexDirection="row" flexShrink={0} height={1} paddingLeft={1} paddingRight={1} backgroundColor={tokens().surface}>
        <text fg={props.tone === "warning" ? tokens().warning : props.tone === "accent" ? tokens().accent : tokens().muted} wrapMode="none" selectable={false}>
          {props.glyph ?? GLYPH.square}
        </text>
        <text fg={tokens().text} wrapMode="none" selectable={false}>{" "}<b>{props.title}</b></text>
        <box flexGrow={1} />
        <Show when={props.meta !== undefined}><text fg={tokens().faint} wrapMode="none" selectable={false}>{props.meta}</text></Show>
      </box>
      <box flexDirection="column" flexGrow={1} minHeight={0} paddingTop={1} paddingBottom={1}>
        {props.children}
      </box>
    </box>
  )
}

function SessionLine(props) {
  const tokens = () => props.tokens
  const session = () => props.session
  return (
    <ClickRow tokens={tokens()} selected={props.selected} onSelect={() => props.onOpen?.(session())}>
      <StatusDot tokens={tokens()} tone={props.tone ?? (session().running ? "accent" : "neutral")} pulse={session().running} />
      <box flexDirection="column" flexGrow={1} minWidth={0}>
        <text fg={tokens().text} wrapMode="none" selectable={false}>
          {props.selected ? <b>{fit(session().title, props.width - 12)}</b> : fit(session().title, props.width - 12)}
        </text>
        <Show when={props.detail}>
          <text fg={tokens().faint} wrapMode="none" selectable={false}>{fit(props.detail, props.width - 8)}</text>
        </Show>
      </box>
      <Show when={props.meta}><text fg={tokens().faint} wrapMode="none" selectable={false}>{props.meta}</text></Show>
    </ClickRow>
  )
}

function CurrentChat(props) {
  const tokens = () => props.tokens
  const session = () => props.session
  const clock = useClock(() => session()?.running === true && tokens().motion !== false)
  const activity = createMemo(() => {
    if (!session()) return null
    void clock()
    return liveActivity(props.api, session().id, { limit: 6 })
  })
  const snapshot = createMemo(() => (session() ? workspaceSnapshot(props.api, session().id) : null))

  return (
    <Card tokens={tokens()} title="Current chat" glyph={GLYPH.diamond} tone={activity()?.busy ? "accent" : "neutral"} minHeight={10}>
      <Show
        when={session()}
        fallback={
          <box flexDirection="column" paddingLeft={2} paddingRight={2} gap={1}>
            <text fg={tokens().text} wrapMode="none" selectable={false}><b>No chat selected</b></text>
            <text fg={tokens().muted} wrapMode="wrap" selectable={false}>Choose a folder for new work, or open a previous chat from the sidebar.</text>
            <Button tokens={tokens()} variant="primary" size="lg" glyph={GLYPH.pointer} onPress={props.onChooseProject}>Choose a folder</Button>
          </box>
        }
      >
        <box flexDirection="column" paddingLeft={1} paddingRight={1} gap={1}>
          <box flexDirection="row" flexShrink={0}>
            <box flexDirection="column" flexGrow={1} minWidth={0}>
              <text fg={tokens().text} wrapMode="none" selectable={false}><b>{fit(session().title, props.width - 18)}</b></text>
              <text fg={tokens().faint} wrapMode="none" selectable={false}>{fitLeft(session().directory || session().projectName || "", props.width - 8)}</text>
            </box>
            <Button tokens={tokens()} variant="primary" glyph={GLYPH.pointer} onPress={() => props.onOpen?.(session())}>Open chat</Button>
          </box>
          <ActivityLine tokens={tokens()} busy={activity()?.busy} width={props.width - 6}>{activity()?.headline ?? "Idle"}</ActivityLine>
          <For each={activity()?.events?.slice(0, 4) ?? []}>
            {(event) => (
              <text wrapMode="none" selectable={false}>
                <span style={{ fg: event.running ? tokens().accent : event.failed ? tokens().error : tokens().success }}>{event.running ? GLYPH.pointer : event.failed ? GLYPH.fail : GLYPH.ok}</span>
                <span style={{ fg: event.running ? tokens().text : tokens().muted }}>{" "}{fit(event.label, props.width - 7)}</span>
              </text>
            )}
          </For>
          <Show when={snapshot()?.attention > 0}>
            <text fg={tokens().warning} wrapMode="none" selectable={false}>{GLYPH.diamond} Agent is waiting for you</text>
          </Show>
          <Show when={snapshot()?.changedFiles > 0}>
            <text fg={tokens().faint} wrapMode="none" selectable={false}>{snapshot().changedFiles} files changed · +{snapshot().additions} -{snapshot().deletions}</text>
          </Show>
        </box>
      </Show>
    </Card>
  )
}

export function OperationsWorkspace(props) {
  const tokens = props.tokens
  const sessions = createMemo(() => props.sessions?.() ?? [])
  const active = createMemo(() => sessions().find((item) => item.id === props.activeID) ?? null)
  const candidates = createMemo(() => {
    const out = []
    const seen = new Set()
    if (active() && !seen.has(active().id)) { seen.add(active().id); out.push(active()) }
    for (const session of sessions().filter((item) => item.running)) {
      if (!seen.has(session.id)) { seen.add(session.id); out.push(session) }
    }
    for (const session of sessions().slice(0, SNAPSHOT_LIMIT)) {
      if (!seen.has(session.id)) { seen.add(session.id); out.push(session) }
    }
    return out
  })
  const snapshots = createMemo(() => {
    const map = new Map()
    for (const session of candidates()) map.set(session.id, workspaceSnapshot(props.api, session.id))
    return map
  })
  const needsYou = createMemo(() => candidates().filter((session) => (snapshots().get(session.id)?.attention ?? 0) > 0).slice(0, LIVE_LIMIT))
  const working = createMemo(() => sessions().filter((session) => session.running).slice(0, LIVE_LIMIT))
  const recent = createMemo(() => sessions().filter((session) => session.id !== active()?.id).slice(0, RECENT_LIMIT))
  const wide = createMemo(() => props.width >= 86)
  const columnWidth = createMemo(() => wide() ? Math.max(34, Math.floor((props.width - 1) / 2)) : props.width)

  return (
    <box flexDirection="column" flexGrow={1} minWidth={0} minHeight={0} paddingLeft={1} paddingRight={1} gap={1}>
      <box flexDirection="row" flexShrink={0} height={3} paddingLeft={1} paddingRight={1} alignItems="center" backgroundColor={tokens().surface}>
        <box flexDirection="column" flexGrow={1} minWidth={0}>
          <text fg={tokens().text} wrapMode="none" selectable={false}><b>Operations</b></text>
          <text fg={tokens().muted} wrapMode="none" selectable={false}>Selected chat, every running agent, and the {SNAPSHOT_LIMIT} most recent chats</text>
        </box>
        <Show when={needsYou().length > 0}><text fg={tokens().warning} wrapMode="none" selectable={false}>{needsYou().length} need you</text></Show>
        <Show when={working().length > 0}><text fg={tokens().accent} wrapMode="none" selectable={false}>{"  "}{working().length} working</text></Show>
      </box>

      <scrollbox flexGrow={1} stickyScroll={false}>
        <CurrentChat api={props.api} tokens={tokens()} session={active()} width={props.width} onOpen={props.onOpen} onChooseProject={props.onChooseProject} />

        <box flexDirection={wide() ? "row" : "column"} flexShrink={0} gap={1} marginTop={1}>
          <Card tokens={tokens()} title="Needs you" glyph={GLYPH.diamond} tone={needsYou().length ? "warning" : "neutral"} meta={needsYou().length} width={columnWidth()} minHeight={8}>
            <Show when={needsYou().length} fallback={<text fg={tokens().muted} wrapMode="none" selectable={false}>{"  "}No agents are waiting for you</text>}>
              <For each={needsYou()}>
                {(session) => <SessionLine tokens={tokens()} session={session} width={columnWidth()} tone="warning" detail={session.projectName} meta="answer" onOpen={props.onOpen} />}
              </For>
            </Show>
          </Card>

          <Card tokens={tokens()} title="Working now" glyph={GLYPH.dot} tone={working().length ? "accent" : "neutral"} meta={working().length} width={columnWidth()} minHeight={8}>
            <Show when={working().length} fallback={<text fg={tokens().muted} wrapMode="none" selectable={false}>{"  "}No agents are running</text>}>
              <For each={working()}>
                {(session) => <SessionLine tokens={tokens()} session={session} width={columnWidth()} tone="accent" detail={session.projectName} meta="live" onOpen={props.onOpen} />}
              </For>
            </Show>
          </Card>
        </box>

        <box marginTop={1}>
          <Card tokens={tokens()} title="Recent chats" glyph={GLYPH.ring} meta={sessions().length} width={props.width} minHeight={Math.max(8, Math.min(14, props.height - 22))}>
            <Show when={recent().length} fallback={<text fg={tokens().muted} wrapMode="none" selectable={false}>{"  "}No previous chats</text>}>
              <For each={recent()}>
                {(session) => <SessionLine tokens={tokens()} session={session} width={props.width} detail={session.projectName || session.directory} meta={session.relative} onOpen={props.onOpen} />}
              </For>
            </Show>
          </Card>
        </box>
      </scrollbox>
    </box>
  )
}
