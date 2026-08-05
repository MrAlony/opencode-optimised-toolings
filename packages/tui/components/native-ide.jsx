/** @jsxImportSource @opentui/solid */
import { createMemo, Show } from "solid-js"
import { compactPath, contextLine, healthTone, sessionSnapshot } from "../lib/native-ide.js"

function toneColor(skin, tone) {
  if (tone === "error") return skin.error
  if (tone === "active") return skin.accent
  if (tone === "warning") return skin.warning
  return skin.success
}

function Metric(props) {
  return <text fg={props.skin.muted}><span style={{ fg: props.color ?? props.skin.text }}><b>{props.value}</b></span> {props.label}</text>
}

export function NativePromptContext(props) {
  const snapshot = createMemo(() => sessionSnapshot(props.api, props.sessionID))
  return <text fg={props.skin.muted} wrapMode="none">{contextLine(snapshot())}</text>
}

export function NativeHomeWorkspace(props) {
  const snapshot = createMemo(() => sessionSnapshot(props.api))
  const tone = createMemo(() => healthTone(snapshot()))
  return (
    <box width="100%" maxWidth={75} flexShrink={0} paddingTop={1} flexDirection="column" alignItems="center">
      <text fg={props.skin.muted} wrapMode="none">
        <span style={{ fg: toneColor(props.skin, tone()) }}>●</span> {contextLine(snapshot())}
        <span style={{ fg: props.skin.muted }}>  ·  {snapshot().sessionCount} sessions  ·  {snapshot().lspReady}/{snapshot().lspTotal || 0} LSP  ·  {snapshot().mcpReady}/{snapshot().mcpTotal || 0} MCP</span>
      </text>
      <text fg={props.skin.muted} wrapMode="none">OpenCode - MrAlony Customised Tool Edition</text>
    </box>
  )
}

export function NativeWorkspaceInspector(props) {
  const snapshot = createMemo(() => sessionSnapshot(props.api, props.sessionID))
  const tone = createMemo(() => healthTone(snapshot()))
  return (
    <box flexDirection="column" gap={1} paddingTop={1} paddingBottom={1}>
      <box flexDirection="column">
        <text fg={props.skin.section}><b>WORKSPACE</b></text>
        <text fg={props.skin.text}><span style={{ fg: toneColor(props.skin, tone()) }}>●</span> <b>{snapshot().project}</b>{snapshot().branch ? <span style={{ fg: props.skin.muted }}>   {snapshot().branch}</span> : null}</text>
        <text fg={props.skin.muted} wrapMode="none">{compactPath(snapshot().directory, 38)}</text>
      </box>

      <box flexDirection="row" gap={2} flexWrap="wrap">
        <Metric skin={props.skin} value={snapshot().changedFiles} label="files" color={snapshot().changedFiles ? props.skin.warning : props.skin.success} />
        <Metric skin={props.skin} value={`+${snapshot().additions}`} label="added" color={props.skin.success} />
        <Metric skin={props.skin} value={`-${snapshot().deletions}`} label="removed" color={props.skin.error} />
      </box>

      <Show when={snapshot().files.length}>
        <box flexDirection="column">
          <text fg={props.skin.section}><b>CHANGES</b></text>
          {snapshot().files.map((file) => <text fg={props.skin.text} wrapMode="none"><span style={{ fg: props.skin.muted }}>•</span> {compactPath(file.file, 30)} <span style={{ fg: props.skin.success }}>+{file.additions}</span> <span style={{ fg: props.skin.error }}>-{file.deletions}</span></text>)}
          <Show when={snapshot().changedFiles > snapshot().files.length}><text fg={props.skin.muted}>+{snapshot().changedFiles - snapshot().files.length} more changed files</text></Show>
        </box>
      </Show>

      <Show when={snapshot().todos.length}>
        <box flexDirection="column">
          <text fg={props.skin.section}><b>SESSION PLAN</b> <span style={{ fg: props.skin.muted }}>{snapshot().activeTodos} active · {snapshot().completedTodos} done</span></text>
          {snapshot().todos.map((todo) => <text fg={todo.status === "completed" ? props.skin.muted : props.skin.text} wrapMode="none"><span style={{ fg: todo.status === "completed" ? props.skin.success : props.skin.accent }}>{todo.status === "completed" ? "✓" : "·"}</span> {String(todo.content).slice(0, 34)}</text>)}
        </box>
      </Show>

      <box flexDirection="column">
        <text fg={props.skin.section}><b>ENVIRONMENT</b></text>
        <text fg={props.skin.muted}><span style={{ fg: snapshot().lspReady === snapshot().lspTotal ? props.skin.success : props.skin.warning }}>●</span> LSP {snapshot().lspReady}/{snapshot().lspTotal || 0}  <span style={{ fg: snapshot().mcpFailed ? props.skin.error : props.skin.success }}>●</span> MCP {snapshot().mcpReady}/{snapshot().mcpTotal || 0}</text>
        <Show when={props.tooling}>
          <text fg={props.skin.muted} wrapMode="none">
            <span style={{ fg: props.tooling.indicator.level === "error" ? props.skin.error : props.tooling.indicator.level === "warn" ? props.skin.warning : props.skin.success }}>●</span> Alonix {props.tooling.registration.registered}/{props.tooling.registration.available ? 16 : 0} renderers · {props.tooling.indicator.text}
          </text>
        </Show>
        <Show when={props.tooling?.state?.lastError}><text fg={props.skin.error} wrapMode="none">{String(props.tooling.state.lastError).slice(0, 38)}</text></Show>
      </box>
    </box>
  )
}
