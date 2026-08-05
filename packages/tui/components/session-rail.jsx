/** @jsxImportSource @opentui/solid */
// Always-visible session rail.
//
// Every live session stays on screen with what its agent is doing right now.
// One click switches, so day-to-day use never requires a command. This renders
// inside the host's own chrome (via a slot) as well as inside the workbench,
// which is why it takes an explicit width and never assumes a viewport.

import { createMemo, For, Show } from "solid-js"
import { GLYPH } from "../lib/design.js"
import { liveActivity } from "../lib/activity.js"
import { fit } from "../lib/layout.js"
import { spinnerFrame } from "../lib/motion.js"
import { useClock } from "./runtime.jsx"

/**
 * One session row: status, title, and its current activity.
 *
 * The activity line is what makes the rail worth having - a static list of
 * titles cannot answer "is it still working?".
 */
function RailRow(props) {
  const tokens = () => props.tokens
  const session = () => props.session
  const clock = useClock(() => session().running === true && tokens().motion !== false)

  const activity = createMemo(() => {
    if (!props.api) return null
    // Re-read on each tick so the line tracks the agent live.
    void clock()
    return liveActivity(props.api, session().id, { limit: 1 })
  })

  const glyph = createMemo(() => {
    if (session().running) return spinnerFrame(clock(), undefined, 90, tokens().motion !== false)
    if (session().active) return GLYPH.diamond
    return GLYPH.bullet
  })

  const glyphColor = createMemo(() => {
    if (session().running) return tokens().accent
    if (session().active) return tokens().success
    return tokens().faint
  })

  const width = () => Math.max(8, props.width - 4)

  return (
    <box
      flexDirection="column"
      flexShrink={0}
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={session().active ? tokens().selectionStrong : undefined}
      onMouseUp={() => props.onOpen(session())}
    >
      <box flexDirection="row" flexShrink={0} height={1} gap={1}>
        <text fg={glyphColor()} wrapMode="none" selectable={false}>
          {glyph()}
        </text>
        <text fg={session().active ? tokens().text : tokens().muted} wrapMode="none" selectable={false}>
          {session().active ? <b>{fit(session().title, width())}</b> : fit(session().title, width())}
        </text>
      </box>

      <Show when={props.showProject !== false && session().projectName}>
        <text fg={tokens().faint} wrapMode="none" selectable={false}>
          {"  "}
          {fit(session().projectName, width() - 2)}
        </text>
      </Show>

      <Show when={activity()?.busy}>
        <text fg={tokens().accent} wrapMode="none" selectable={false}>
          {"  "}
          {fit(activity().headline, width() - 2)}
        </text>
      </Show>

      <Show when={!activity()?.busy && session().changedFiles > 0}>
        <text fg={tokens().faint} wrapMode="none" selectable={false}>
          {"  "}
          {session().changedFiles} changed
        </text>
      </Show>
    </box>
  )
}

/**
 * The rail itself.
 *
 * Running sessions lead because they are the reason to look. When nothing is
 * running the most recent sessions are shown instead, so the rail is never an
 * empty column of wasted space.
 */
export function SessionRail(props) {
  const tokens = props.tokens
  const width = () => Math.max(18, Number(props.width) || 28)
  const limit = () => Math.max(1, Number(props.limit) || 8)

  const sessions = createMemo(() => {
    const all = props.sessions?.() ?? []
    const running = all.filter((session) => session.running)
    if (running.length >= limit()) return running.slice(0, limit())
    const rest = all.filter((session) => !session.running).slice(0, limit() - running.length)
    return [...running, ...rest]
  })

  const runningCount = createMemo(() => (props.sessions?.() ?? []).filter((session) => session.running).length)

  return (
    <box flexDirection="column" width={width()} flexShrink={0} backgroundColor={props.background}>
      <box flexDirection="row" flexShrink={0} height={1} gap={1} paddingLeft={1} paddingRight={1}>
        <text fg={tokens().faint} wrapMode="none" selectable={false}>
          <b>SESSIONS</b>
        </text>
        <box flexGrow={1} />
        <Show when={runningCount() > 0}>
          <text fg={tokens().accent} wrapMode="none" selectable={false}>
            {GLYPH.dot} {runningCount()}
          </text>
        </Show>
      </box>

      <Show
        when={sessions().length}
        fallback={
          <box paddingLeft={1} paddingTop={1}>
            <text fg={tokens().faint} wrapMode="none" selectable={false}>
              No sessions yet
            </text>
          </box>
        }
      >
        <scrollbox flexGrow={1} stickyScroll={false}>
          <For each={sessions()}>
            {(session) => (
              <RailRow
                api={props.api}
                tokens={tokens()}
                session={session}
                width={width()}
                showProject={props.showProject}
                onOpen={(item) => props.onOpen?.(item)}
              />
            )}
          </For>
        </scrollbox>
      </Show>
    </box>
  )
}
