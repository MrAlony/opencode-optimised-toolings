/** @jsxImportSource @opentui/solid */
// Tooling status dialog for the Alonix IDE.
//
// Presents the self-patch lifecycle as a readable state view instead of a raw
// log dump, while still exposing the full log for diagnosis.

import { createMemo, For, Show } from "solid-js"
import { GLYPH } from "../lib/design.js"
import { Badge, Gauge, Panel, Rule, SectionLabel, StatLine, StatusDot } from "./ide-kit.jsx"

function toneFor(level) {
  if (level === "error") return "error"
  if (level === "warn") return "warning"
  if (level === "ok") return "success"
  return "accent"
}

export function ToolingStatusView(props) {
  const tokens = () => props.tokens()
  const tooling = () => props.tooling ?? {}
  const state = createMemo(() => tooling().state ?? {})
  const indicator = createMemo(() => tooling().indicator ?? { level: "info", text: "" })
  const registration = createMemo(() => tooling().registration ?? { available: false, registered: 0, failed: [] })
  const percent = createMemo(() => {
    const value = Number(state().progressPercent)
    return Number.isFinite(value) && value > 0 ? Math.min(100, value) : null
  })
  const logLines = createMemo(() => String(props.log ?? "").split(/\r?\n/).filter((line) => line.trim()))

  return (
    <box flexDirection="column" paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <box flexDirection="row" gap={1} alignItems="center" flexShrink={0}>
        <text fg={tokens().accent} wrapMode="none" selectable={false}>
          {GLYPH.diamond}
        </text>
        <text fg={tokens().text} wrapMode="none" selectable={false}>
          <b>Alonix tooling</b>
        </text>
        <box flexGrow={1} />
        <Badge tokens={tokens()} tone={toneFor(indicator().level)} solid>
          {String(state().status ?? "unknown")}
        </Badge>
      </box>

      <box flexDirection="row" gap={1} flexShrink={0}>
        <StatusDot tokens={tokens()} tone={toneFor(indicator().level)} pulse={indicator().level === "info"} />
        <text fg={tokens().muted} wrapMode="wrap" selectable={false}>
          {indicator().text}
        </text>
      </box>

      <Show when={percent() !== null}>
        <box flexDirection="row" gap={1} flexShrink={0}>
          <Gauge tokens={tokens()} tone={toneFor(indicator().level)} percent={percent()} width={28} active />
          <text fg={tokens().faint} wrapMode="none" selectable={false}>
            {percent()}% {state().stepLabel ?? ""}
          </text>
        </box>
      </Show>

      <Panel tokens={tokens()} title="Renderers" glyph={GLYPH.square} tone="accent">
        <StatLine tokens={tokens()} label="registered" labelWidth={24}>
          {registration().registered}/{registration().available ? 16 : 0}
        </StatLine>
        <StatLine tokens={tokens()} label="registry available" labelWidth={24}>
          {registration().available ? "yes" : "portable mode"}
        </StatLine>
        <Show when={registration().failed?.length}>
          <StatLine tokens={tokens()} label="failed" labelWidth={24} color={tokens().error}>
            {registration().failed.join(", ")}
          </StatLine>
        </Show>
      </Panel>

      <Show when={state().lastError && indicator().level === "error"}>
        <Panel tokens={tokens()} title="Last error" glyph={GLYPH.fail} tone="error">
          <text fg={tokens().error} wrapMode="wrap" selectable={false}>
            {String(state().lastError)}
          </text>
        </Panel>
      </Show>

      <Rule tokens={tokens()} />
      <SectionLabel tokens={tokens()}>Details</SectionLabel>
      <box flexDirection="column" flexShrink={0}>
        <For each={logLines()}>
          {(line) => (
            <text fg={tokens().faint} wrapMode="none" selectable>
              {line}
            </text>
          )}
        </For>
      </box>
    </box>
  )
}
