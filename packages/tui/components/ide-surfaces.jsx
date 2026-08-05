/** @jsxImportSource @opentui/solid */
// Alonix IDE surfaces mounted into the host's presentation slots.
//
// These components enrich OpenCode's native chrome: they read host state and
// render, but never own routing, keybindings, or session mutation.

import { createMemo, For, Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { GLYPH } from "../lib/design.js"
import { fit, homeLayout, inspectorLayout } from "../lib/layout.js"
import { summarizeSessions } from "../lib/sessions.js"
import {
  compactPath,
  fileKind,
  healthLabel,
  healthTone,
  splitPath,
  workspaceMetrics,
  workspaceSnapshot,
} from "../lib/workspace.js"
import {
  Badge,
  DiffStat,
  Gauge,
  MetricTile,
  Panel,
  PathLabel,
  Row,
  SectionLabel,
  Spinner,
  StatLine,
  StatusDot,
} from "./ide-kit.jsx"
import { activeSessionID, openSession } from "./runtime.jsx"

const KIND_GLYPH = {
  code: "◆",
  config: "◇",
  doc: "▤",
  style: "◑",
  asset: "▣",
  test: "◎",
  file: "▪",
}

/**
 * Prompt-adjacent context.
 *
 * The host shares this row with the agent and model labels, and that row has no
 * width reservation: the label box shrinks by default, so an insert that
 * refuses to shrink forces the model name to wrap. Three rules keep this
 * subordinate to the host's own chrome:
 *
 *   1. It renders only what the status bar cannot already show in context --
 *      live token pressure. Project, branch, and change counts are omitted
 *      because the status bar carries them without competing for width.
 *   2. It appears only once a session has real context to report, so the home
 *      screen (where model names are longest) is never crowded.
 *   3. It shrinks and clips before the host's labels do.
 */
export function PromptContext(props) {
  const snapshot = createMemo(() => workspaceSnapshot(props.api, props.sessionID))
  const tokens = () => props.tokens()
  const dimensions = useTerminalDimensions()
  const percent = createMemo(() => snapshot().context.percent)
  // Roughly "model labels have already been given their share".
  const roomy = createMemo(() => dimensions().width >= 90)
  const tone = createMemo(() => {
    const value = percent()
    if (value === null) return "neutral"
    if (value > 90) return "error"
    if (value > 75) return "warning"
    return "success"
  })
  return (
    <Show when={props.sessionID && percent() !== null && roomy()}>
      <text fg={tokens().faint} wrapMode="none" flexShrink={1} minWidth={0} selectable={false}>
        <span style={{ fg: toneColor(tokens(), tone()) }}>{GLYPH.dot}</span> {percent()}%
      </text>
    </Show>
  )
}

function toneColor(tokens, tone) {
  if (tone === "error") return tokens.error
  if (tone === "warning") return tokens.warning
  if (tone === "accent") return tokens.accent
  if (tone === "neutral") return tokens.muted
  return tokens.success
}

/**
 * Home workspace deck: identity, live metrics, and recent sessions so a new
 * OpenCode window opens onto a workbench rather than an empty prompt.
 */
export function HomeDeck(props) {
  const tokens = () => props.tokens()
  const snapshot = createMemo(() => workspaceSnapshot(props.api, null))
  const layout = createMemo(() => homeLayout(props.dimensions?.() ?? { width: 100, height: 40 }))
  const rows = createMemo(() => props.store.sessionRows().slice(0, 5))
  const summary = createMemo(() => props.store.summary())
  const metrics = createMemo(() => workspaceMetrics(snapshot()).slice(0, layout().columns * 2))

  return (
    <box width="100%" maxWidth={layout().deck} flexShrink={0} flexDirection="column" paddingTop={1} gap={1}>
      <box flexDirection="row" gap={1} flexShrink={0} alignItems="center">
        <StatusDot tokens={tokens()} tone={healthTone(snapshot())} pulse={snapshot().busy} />
        <text fg={tokens().text} wrapMode="none" selectable={false}>
          <b>{snapshot().project}</b>
        </text>
        <Show when={snapshot().branch}>
          <text fg={tokens().faint} wrapMode="none" selectable={false}>
            {GLYPH.branch} {fit(snapshot().branch, 18)}
          </text>
        </Show>
        <box flexGrow={1} />
        <text fg={tokens().faint} wrapMode="none" selectable={false}>
          {healthLabel(snapshot())}
        </text>
      </box>

      <box flexDirection="row" gap={2} flexShrink={0} flexWrap="wrap">
        <For each={metrics()}>
          {(metric) => (
            <MetricTile
              tokens={tokens()}
              tone={metric.tone}
              value={metric.value}
              label={metric.label}
              width={layout().density === "compact" ? 9 : 11}
            />
          )}
        </For>
      </box>

      <Show when={rows().length}>
        <box flexDirection="column" flexShrink={0}>
          <SectionLabel tokens={tokens()} meta={`${summary().sessions} total`}>
            Recent sessions
          </SectionLabel>
          <For each={rows()}>
            {(row, position) => (
              <Row
                tokens={tokens()}
                tone={row.running ? "accent" : "neutral"}
                animateIndex={position()}
                onSelect={() => openSession(props.api, row.id)}
                meta={row.relative}
                leading={
                  <box width={2} flexShrink={0}>
                    <Show
                      when={row.running}
                      fallback={
                        <text fg={tokens().faint} wrapMode="none" selectable={false}>
                          {row.slot ?? GLYPH.bullet}
                        </text>
                      }
                    >
                      <Spinner tokens={tokens()} tone="accent" />
                    </Show>
                  </box>
                }
              >
                <text fg={row.untitled ? tokens().muted : tokens().text} wrapMode="none" selectable={false}>
                  {fit(row.title, layout().deck - 16)}
                </text>
              </Row>
            )}
          </For>
        </box>
      </Show>

      <box flexDirection="row" gap={1} flexShrink={0} justifyContent="center">
        <text fg={tokens().faint} wrapMode="none" selectable={false}>
          OpenCode
        </text>
        <text fg={tokens().accent} wrapMode="none" selectable={false}>
          {GLYPH.diamond}
        </text>
        <text fg={tokens().faint} wrapMode="none" selectable={false}>
          MrAlony Customised Tool Edition
        </text>
      </box>
    </box>
  )
}

function ToolingPanel(props) {
  const tooling = () => props.tooling
  const tone = createMemo(() => {
    const level = tooling()?.indicator?.level
    if (level === "error") return "error"
    if (level === "warn") return "warning"
    if (level === "ok") return "success"
    return "accent"
  })
  const percent = createMemo(() => {
    const value = Number(tooling()?.state?.progressPercent)
    return Number.isFinite(value) && value > 0 && value < 100 ? value : null
  })
  const working = createMemo(() => percent() !== null || tooling()?.indicator?.level === "info")

  return (
    <Panel tokens={props.tokens} title="Alonix tooling" glyph={GLYPH.square} tone={tone()}>
      <box flexDirection="row" gap={1} flexShrink={0}>
        <StatusDot tokens={props.tokens} tone={tone()} pulse={working()} />
        <text fg={props.tokens.muted} wrapMode="none" selectable={false}>
          {fit(tooling()?.indicator?.text ?? "", props.width - 4)}
        </text>
      </box>
      <StatLine tokens={props.tokens} label="renderers" labelWidth={props.width - 10}>
        {tooling()?.registration?.registered ?? 0}/{tooling()?.registration?.available ? 16 : 0}
      </StatLine>
      <Show when={percent() !== null}>
        <box flexDirection="row" gap={1} flexShrink={0}>
          <Gauge tokens={props.tokens} tone={tone()} percent={percent()} width={props.gauge} active />
          <text fg={props.tokens.faint} wrapMode="none" selectable={false}>
            {percent()}%
          </text>
        </box>
      </Show>
      <Show when={tooling()?.state?.lastError && tooling()?.indicator?.level === "error"}>
        <text fg={props.tokens.error} wrapMode="none" selectable={false}>
          {fit(String(tooling().state.lastError), props.width)}
        </text>
      </Show>
    </Panel>
  )
}

/**
 * Sidebar workspace inspector. Panels are ordered by urgency: blocking
 * attention first, then the active plan, then changes, then environment.
 */
export function WorkspaceInspector(props) {
  const tokens = () => props.tokens()
  const snapshot = createMemo(() => workspaceSnapshot(props.api, props.sessionID))
  const layout = createMemo(() => inspectorLayout(42))
  const files = createMemo(() => snapshot().files.slice(0, 8))
  const todos = createMemo(() => snapshot().todos.slice(0, 6))
  const summary = createMemo(() => props.store.summary())

  return (
    <box flexDirection="column" gap={1} paddingTop={1} paddingBottom={1}>
      <box flexDirection="column" flexShrink={0}>
        <box flexDirection="row" gap={1} flexShrink={0}>
          <StatusDot tokens={tokens()} tone={healthTone(snapshot())} pulse={snapshot().busy} />
          <text fg={tokens().text} wrapMode="none" selectable={false}>
            <b>{fit(snapshot().project, layout().label)}</b>
          </text>
          <box flexGrow={1} />
          <Show when={snapshot().branch}>
            <text fg={tokens().faint} wrapMode="none" selectable={false}>
              {fit(snapshot().branch, 14)}
            </text>
          </Show>
        </box>
        <text fg={tokens().faint} wrapMode="none" selectable={false}>
          {compactPath(snapshot().directory, layout().usable)}
        </text>
      </box>

      <Show when={snapshot().attention > 0}>
        <Panel tokens={tokens()} title="Needs you" glyph={GLYPH.diamond} tone="warning">
          <Show when={snapshot().permissions > 0}>
            <text fg={tokens().warning} wrapMode="none" selectable={false}>
              {snapshot().permissions} permission request{snapshot().permissions === 1 ? "" : "s"}
            </text>
          </Show>
          <Show when={snapshot().questions > 0}>
            <text fg={tokens().warning} wrapMode="none" selectable={false}>
              {snapshot().questions} open question{snapshot().questions === 1 ? "" : "s"}
            </text>
          </Show>
        </Panel>
      </Show>

      <Panel tokens={tokens()} title="Sessions" glyph={GLYPH.ring} tone="accent">
        <box flexDirection="row" gap={1} flexShrink={0}>
          <Badge tokens={tokens()} tone="neutral">
            {summary().sessions} total
          </Badge>
          <Show when={summary().running > 0}>
            <Badge tokens={tokens()} tone="accent">
              {summary().running} working
            </Badge>
          </Show>

        </box>
      </Panel>

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
                  {fit(String(todo.content ?? ""), layout().usable - 3)}
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
              const parts = splitPath(file.file, layout().usable - 10)
              return (
                <box flexDirection="row" gap={1} flexShrink={0}>
                  <text fg={tokens().faint} wrapMode="none" selectable={false}>
                    {KIND_GLYPH[fileKind(file.file)] ?? GLYPH.square}
                  </text>
                  <PathLabel
                    tokens={tokens()}
                    dir={parts.dir}
                    name={parts.name}
                    dirWidth={10}
                    nameWidth={layout().usable - 18}
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

      <Show when={snapshot().context.tokens > 0}>
        <Panel tokens={tokens()} title="Context" glyph={GLYPH.ring} tone="accent">
          <box flexDirection="row" gap={1} flexShrink={0}>
            <Gauge
              tokens={tokens()}
              tone={snapshot().context.percent > 85 ? "warning" : "accent"}
              percent={snapshot().context.percent ?? 0}
              width={layout().gauge}
            />
            <text fg={tokens().muted} wrapMode="none" selectable={false}>
              {snapshot().context.percent ?? 0}%
            </text>
          </box>
          <StatLine tokens={tokens()} label="tokens" labelWidth={layout().usable - 12}>
            {snapshot().context.tokens.toLocaleString()}
          </StatLine>
          <Show when={snapshot().context.cost > 0}>
            <StatLine tokens={tokens()} label="cost" labelWidth={layout().usable - 12}>
              ${snapshot().context.cost.toFixed(2)}
            </StatLine>
          </Show>
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

      <Show when={props.tooling}>
        <ToolingPanel
          tokens={tokens()}
          tooling={props.tooling}
          width={layout().usable}
          gauge={layout().gauge}
        />
      </Show>
    </box>
  )
}

/**
 * Persistent bottom status bar. Mounted into `app_bottom` so it is visible on
 * every route without replacing any host chrome.
 */
export function StatusBar(props) {
  const tokens = () => props.tokens()
  const sessionID = createMemo(() => activeSessionID(props.api))
  const snapshot = createMemo(() => workspaceSnapshot(props.api, sessionID()))
  const summary = createMemo(() => props.store.summary())
  const tone = createMemo(() => healthTone(snapshot()))

  return (
    <box
      width="100%"
      flexShrink={0}
      flexDirection="row"
      gap={2}
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={tokens().panel}
    >
      <box flexDirection="row" gap={1} flexShrink={0}>
        <StatusDot tokens={tokens()} tone={tone()} pulse={snapshot().busy} />
        <text fg={tokens().text} wrapMode="none" selectable={false}>
          {fit(snapshot().project, 20)}
        </text>
      </box>

      <Show when={snapshot().branch}>
        <text fg={tokens().faint} wrapMode="none" selectable={false}>
          {GLYPH.branch} {fit(snapshot().branch, 16)}
        </text>
      </Show>

      <Show when={snapshot().changedFiles > 0}>
        <box flexDirection="row" gap={1} flexShrink={0}>
          <text fg={tokens().faint} wrapMode="none" selectable={false}>
            {snapshot().changedFiles}
          </text>
          <DiffStat tokens={tokens()} additions={snapshot().additions} deletions={snapshot().deletions} />
        </box>
      </Show>

      <box flexGrow={1} />

      <Show when={snapshot().activeTodos > 0}>
        <text fg={tokens().faint} wrapMode="none" selectable={false}>
          {snapshot().activeTodos} todo
        </text>
      </Show>
      <Show when={snapshot().context.percent !== null}>
        <text
          fg={snapshot().context.percent > 85 ? tokens().warning : tokens().faint}
          wrapMode="none"
          selectable={false}
        >
          ctx {snapshot().context.percent}%
        </text>
      </Show>
      <text fg={tokens().faint} wrapMode="none" selectable={false}>
        {summary().sessions} chats
      </text>
      <Show when={props.tooling?.indicator}>
        <text
          fg={
            props.tooling.indicator.level === "error"
              ? tokens().error
              : props.tooling.indicator.level === "warn"
                ? tokens().warning
                : tokens().faint
          }
          wrapMode="none"
          selectable={false}
        >
          alonix {props.tooling.registration?.registered ?? 0}/16
        </text>
      </Show>
    </box>
  )
}
