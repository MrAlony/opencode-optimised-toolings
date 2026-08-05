/** @jsxImportSource @opentui/solid */
// Side-by-side session monitor.
//
// Shows up to four sessions at once, each with its own live agent feed, so
// parallel work across projects is visible simultaneously rather than by
// switching back and forth. Geometry comes from `lib/panes.js`, which degrades
// the grid rather than rendering unreadable slivers.

import { createMemo, For, Show } from "solid-js"
import { GLYPH } from "../lib/design.js"
import { liveActivity } from "../lib/activity.js"
import { fit } from "../lib/layout.js"
import { spinnerFrame } from "../lib/motion.js"
import { paneGrid } from "../lib/panes.js"
import { workspaceSnapshot } from "../lib/workspace.js"
import { useClock } from "./runtime.jsx"
import { Button } from "./controls.jsx"

/** One monitored session. */
function Pane(props) {
  const tokens = () => props.tokens
  const session = () => props.session
  const clock = useClock(() => tokens().motion !== false)

  const activity = createMemo(() => {
    void clock()
    return liveActivity(props.api, props.sessionID, { limit: Math.max(3, props.height - 8) })
  })
  const snapshot = createMemo(() => workspaceSnapshot(props.api, props.sessionID))

  const inner = () => Math.max(6, props.width - 2)

  return (
    <box
      flexDirection="column"
      width={props.width}
      height={props.height}
      flexShrink={0}
      backgroundColor={props.focused ? tokens().surface : tokens().panel}
      onMouseDown={() => props.onFocus?.()}
    >
      <box flexDirection="row" flexShrink={0} height={1} gap={1} paddingLeft={1} paddingRight={1}>
        <text fg={activity().busy ? tokens().accent : tokens().faint} wrapMode="none" selectable={false}>
          {activity().busy ? spinnerFrame(clock(), undefined, 90, tokens().motion !== false) : GLYPH.bullet}
        </text>
        <text fg={props.focused ? tokens().text : tokens().muted} wrapMode="none" selectable={false}>
          <b>{fit(session()?.title ?? "Session", inner() - 10)}</b>
        </text>
        <box flexGrow={1} />
        <box onMouseDown={(event) => {
          // Closing a pane must not also focus it.
          event?.stopPropagation?.()
          props.onClose?.()
        }}>
          <text fg={tokens().error} wrapMode="none" selectable={false}>
            {GLYPH.close}
          </text>
        </box>
      </box>

      <Show when={session()?.projectName}>
        <text fg={tokens().faint} wrapMode="none" selectable={false}>
          {" "}
          {fit(session().projectName, inner() - 1)}
        </text>
      </Show>

      <box flexDirection="row" flexShrink={0} height={1} gap={1} paddingLeft={1}>
        <text fg={activity().busy ? tokens().accent : tokens().muted} wrapMode="none" selectable={false}>
          {fit(activity().headline, inner() - 2)}
        </text>
      </box>

      <box flexDirection="column" flexGrow={1} minHeight={0} paddingLeft={1} paddingTop={1}>
        <For each={activity().events.slice(0, Math.max(1, props.height - 6))}>
          {(event) => (
            <text wrapMode="none" selectable={false}>
              <span
                style={{ fg: event.running ? tokens().accent : event.failed ? tokens().error : tokens().success }}
              >
                {event.running ? GLYPH.pointer : event.failed ? GLYPH.fail : GLYPH.ok}
              </span>
              <span style={{ fg: event.running ? tokens().text : tokens().faint }}>
                {" "}
                {fit(event.label, inner() - 3)}
              </span>
            </text>
          )}
        </For>
      </box>

      <box flexDirection="row" flexShrink={0} height={1} gap={1} paddingLeft={1} paddingRight={1}>
        <Show when={snapshot().attention > 0}>
          <text fg={tokens().warning} wrapMode="none" selectable={false}>
            {GLYPH.diamond} needs you
          </text>
        </Show>
        <box flexGrow={1} />
        <Show when={snapshot().changedFiles > 0}>
          <text fg={tokens().faint} wrapMode="none" selectable={false}>
            {snapshot().changedFiles}f
          </text>
        </Show>
      </box>
    </box>
  )
}

export function Monitor(props) {
  const tokens = props.tokens
  const panes = () => props.panes

  const grid = createMemo(() =>
    paneGrid(panes().ids.length || 1, { width: props.width, height: props.height }),
  )

  const visible = createMemo(() => panes().ids.slice(0, grid().visible))
  const sessionFor = (id) => (props.sessions?.() ?? []).find((session) => session.id === id) ?? null

  const rows = createMemo(() => {
    const out = []
    const ids = visible()
    for (let index = 0; index < ids.length; index += grid().columns) {
      out.push(ids.slice(index, index + grid().columns))
    }
    return out
  })

  return (
    <box flexDirection="column" flexGrow={1} minWidth={0} minHeight={0}>
      <Show
        when={panes().ids.length}
        fallback={
          <box flexDirection="column" paddingLeft={2} paddingTop={2} gap={1}>
            <text fg={tokens().muted} wrapMode="none" selectable={false}>
              {GLYPH.ring} Nothing is being monitored
            </text>
            <text fg={tokens().faint} wrapMode="none" selectable={false}>
              Add a running session to watch it work here
            </text>
            <box flexDirection="row" gap={2} paddingTop={1}>
              <Button tokens={tokens()} tone="accent" primary glyph={GLYPH.plus} onPress={() => props.onAutoFill?.()}>
                Watch active sessions
              </Button>
            </box>
          </box>
        }
      >
        <Show when={grid().constrained}>
          <box flexShrink={0} height={1} paddingLeft={1}>
            <text fg={tokens().warning} wrapMode="none" selectable={false}>
              {grid().hidden} pane{grid().hidden === 1 ? "" : "s"} hidden — the terminal is too small
            </text>
          </box>
        </Show>

        <For each={rows()}>
          {(row, rowIndex) => (
            <box flexDirection="row" flexShrink={0} gap={grid().gap} marginTop={rowIndex() > 0 ? grid().gap : 0}>
              <For each={row}>
                {(id) => (
                  <Pane
                    api={props.api}
                    tokens={tokens()}
                    sessionID={id}
                    session={sessionFor(id)}
                    width={grid().paneWidth}
                    height={grid().paneHeight}
                    focused={panes().focus === id}
                    onFocus={() => props.onFocus?.(id)}
                    onClose={() => props.onClose?.(id)}
                  />
                )}
              </For>
            </box>
          )}
        </For>
      </Show>
    </box>
  )
}
