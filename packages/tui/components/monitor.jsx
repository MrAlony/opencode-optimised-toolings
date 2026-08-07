/** @jsxImportSource @opentui/solid */
// Automatic live dashboard. It derives entirely from current session state;
// there is no stale manual pane configuration to maintain.

import { createMemo, For, Show } from "solid-js"
import { GLYPH } from "../lib/design.js"
import { liveActivity } from "../lib/activity.js"
import { fit } from "../lib/layout.js"
import { workspaceSnapshot } from "../lib/workspace.js"
import { ActivityLine, Button, ClickRow } from "./controls.jsx"
import { EmptyState, Panel, StatusDot } from "./ide-kit.jsx"
import { useClock } from "./runtime.jsx"

function LiveCard(props) {
  const tokens = () => props.tokens
  const session = () => props.session
  const clock = useClock(() => session().running === true && tokens().motion !== false)
  const activity = createMemo(() => {
    void clock()
    return liveActivity(props.api, session().id, { limit: Math.max(2, props.rows ?? 5) })
  })
  const snapshot = createMemo(() => workspaceSnapshot(props.api, session().id))

  return (
    <box flexDirection="column" flexShrink={0} width={props.width} minHeight={8} border borderStyle="rounded" borderColor={snapshot().attention > 0 ? tokens().warning : activity().busy ? tokens().accent : tokens().borderFaint} backgroundColor={tokens().panel}>
      <ClickRow tokens={tokens()} selected={snapshot().attention > 0} onSelect={() => props.onOpen?.(session())}>
        <StatusDot tokens={tokens()} tone={snapshot().attention > 0 ? "warning" : activity().busy ? "accent" : "success"} pulse={activity().busy} />
        <text fg={tokens().text} wrapMode="none" selectable={false}><b>{fit(session().title, Math.max(8, props.width - 12))}</b></text>
      </ClickRow>
      <text fg={tokens().faint} wrapMode="none" selectable={false}>{"  "}{fit(session().projectName || session().directory || "", Math.max(8, props.width - 4))}</text>
      <box paddingLeft={1} paddingRight={1} paddingTop={1}>
        <ActivityLine tokens={tokens()} busy={activity().busy} width={Math.max(8, props.width - 5)}>{activity().headline}</ActivityLine>
      </box>
      <box flexDirection="column" flexGrow={1} minHeight={0} paddingLeft={2} paddingTop={1}>
        <For each={activity().events.slice(0, props.rows ?? 5)}>
          {(event) => (
            <text wrapMode="none" selectable={false}>
              <span style={{ fg: event.running ? tokens().accent : event.failed ? tokens().error : tokens().success }}>{event.running ? GLYPH.pointer : event.failed ? GLYPH.fail : GLYPH.ok}</span>
              <span style={{ fg: event.running ? tokens().text : tokens().muted }}>{" "}{fit(event.label, Math.max(8, props.width - 7))}</span>
            </text>
          )}
        </For>
      </box>
      <box flexDirection="row" flexShrink={0} paddingLeft={1} paddingRight={1}>
        <Show when={snapshot().attention > 0}><text fg={tokens().warning} wrapMode="none" selectable={false}>{GLYPH.diamond} needs your answer</text></Show>
        <box flexGrow={1} />
        <Show when={snapshot().changedFiles > 0}><text fg={tokens().faint} wrapMode="none" selectable={false}>{snapshot().changedFiles} changed</text></Show>
      </box>
    </box>
  )
}

export function Monitor(props) {
  const tokens = props.tokens
  const all = createMemo(() => props.sessions?.() ?? [])
  const attention = createMemo(() => all().filter((session) => workspaceSnapshot(props.api, session.id).attention > 0))
  const running = createMemo(() => all().filter((session) => session.running && !attention().some((item) => item.id === session.id)))
  const visible = createMemo(() => [...attention(), ...running()].slice(0, 6))
  const columns = createMemo(() => (props.width >= 96 ? 3 : props.width >= 60 ? 2 : 1))
  const gap = 1
  const cardWidth = createMemo(() => Math.max(24, Math.floor((props.width - gap * (columns() - 1)) / columns())))
  const rows = createMemo(() => {
    const out = []
    for (let index = 0; index < visible().length; index += columns()) out.push(visible().slice(index, index + columns()))
    return out
  })

  return (
    <box flexDirection="column" flexGrow={1} minWidth={0} minHeight={0} paddingLeft={1} paddingRight={1} gap={1}>
      <box flexDirection="row" flexShrink={0} height={3} alignItems="center" backgroundColor={tokens().surface} paddingLeft={1} paddingRight={1}>
        <box flexDirection="column" flexGrow={1}>
          <text fg={tokens().text} wrapMode="none" selectable={false}><b>Live work</b></text>
          <text fg={tokens().muted} wrapMode="none" selectable={false}>Updates automatically from every active chat</text>
        </box>
        <Show when={attention().length > 0}><text fg={tokens().warning} wrapMode="none" selectable={false}>{attention().length} need you</text></Show>
        <Show when={running().length > 0}><text fg={tokens().accent} wrapMode="none" selectable={false}>{"  "}{running().length} working</text></Show>
      </box>

      <Show when={visible().length} fallback={<EmptyState tokens={tokens()} title={props.ready ? "Nothing is running" : "Loading live work"} hint={props.ready ? "Start a chat in a folder; active work will appear here automatically" : "Checking every workspace for active chats…"} action={props.ready ? <Button tokens={tokens()} variant="primary" size="lg" glyph={GLYPH.pointer} description="Choose the folder for a new chat" onPress={props.onChooseProject}>Choose a folder</Button> : undefined} />}>
        <scrollbox flexGrow={1} stickyScroll={false}>
          <For each={rows()}>
            {(row) => (
              <box flexDirection="row" flexShrink={0} gap={gap} marginBottom={1}>
                <For each={row}>
                  {(session) => <LiveCard api={props.api} tokens={tokens()} session={session} width={cardWidth()} rows={Math.max(3, Math.floor((props.height - 8) / Math.max(1, rows().length)) - 4)} onOpen={props.onOpen} />}
                </For>
              </box>
            )}
          </For>
        </scrollbox>
      </Show>
    </box>
  )
}
