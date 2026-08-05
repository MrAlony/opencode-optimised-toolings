/** @jsxImportSource @opentui/solid */
// Full-screen Alonix operations workspace.

import { createMemo, Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { GLYPH } from "../lib/design.js"
import { classifyKey } from "../lib/keys.js"
import { Button, SegmentedControl, Toolbar } from "./controls.jsx"
import { Monitor } from "./monitor.jsx"
import { OperationsWorkspace } from "./operations.jsx"
import { dockWidth } from "./dock.jsx"

export function Workbench(props) {
  const tokens = props.tokens
  const store = props.store
  const dimensions = useTerminalDimensions()
  const viewport = createMemo(() => {
    const reserved = props.dockOpen ? dockWidth(props.dockOpen(), dimensions().width) : 0
    return {
      width: Math.max(20, dimensions().width - reserved),
      height: Math.max(8, dimensions().height),
    }
  })
  const sessions = createMemo(() => store.sessionRows())
  const summary = createMemo(() => store.summary())
  const activeID = createMemo(() => store.workbench.activeID ?? sessions().find((item) => item.active)?.id ?? null)

  const handleKey = (event) => {
    const action = classifyKey(event)
    const name = String(event?.name ?? "").toLowerCase()
    if (action === "dismiss") return props.onExit?.()
    if (event?.ctrl && name === "p") return props.onPalette?.()
    if (event?.ctrl && name === "n") return props.onChooseProject?.()
    if (event?.ctrl && name === "m") return props.onMode?.((props.mode?.() ?? "work") === "monitor" ? "work" : "monitor")
  }

  return (
    <box
      width={viewport().width}
      height={viewport().height}
      flexDirection="column"
      backgroundColor={tokens().canvasOpaque ?? tokens().canvas}
      focusable
      focused
      onKeyDown={handleKey}
    >
      <Toolbar tokens={tokens()} height={3} gap={1}>
        <text fg={tokens().accent} wrapMode="none" selectable={false}>{GLYPH.diamond}</text>
        <text fg={tokens().text} wrapMode="none" selectable={false}><b>Alonix</b></text>
        <Button tokens={tokens()} variant="secondary" glyph={GLYPH.pointer} shortcut="^p" onPress={props.onPalette}>Search</Button>
        <Button tokens={tokens()} variant="primary" glyph={GLYPH.plus} shortcut="^n" onPress={props.onChooseProject}>New chat</Button>
        <Button tokens={tokens()} variant="secondary" glyph={GLYPH.square} onPress={props.onAddProject}>Add folder</Button>
        <SegmentedControl
          tokens={tokens()}
          value={props.mode?.() ?? "work"}
          onChange={props.onMode}
          items={[
            { value: "work", label: "Operations" },
            { value: "monitor", label: "Live agents", count: summary().running || undefined },
          ]}
        />
        <box flexGrow={1} />
        <Show when={summary().running > 0}><text fg={tokens().accent} wrapMode="none" selectable={false}>{GLYPH.dot} {summary().running} working</text></Show>
        <text fg={tokens().faint} wrapMode="none" selectable={false}>{summary().projects} folders · {summary().sessions} chats</text>
        <Button tokens={tokens()} variant="secondary" onPress={props.onExit}>Back to chat</Button>
      </Toolbar>

      <Show
        when={(props.mode?.() ?? "work") === "monitor"}
        fallback={
          <OperationsWorkspace
            api={props.api}
            tokens={tokens}
            sessions={sessions}
            activeID={activeID()}
            width={viewport().width - 2}
            height={viewport().height - 3}
            onOpen={(session) => props.onOpenChat?.(session.id)}
            onChooseProject={props.onChooseProject}
          />
        }
      >
        <Monitor
          api={props.api}
          tokens={tokens}
          sessions={sessions}
          width={viewport().width - 2}
          height={viewport().height - 3}
          onOpen={(session) => props.onOpenChat?.(session.id)}
          onChooseProject={props.onChooseProject}
        />
      </Show>
    </box>
  )
}
