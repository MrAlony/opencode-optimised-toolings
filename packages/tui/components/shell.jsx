/** @jsxImportSource @opentui/solid */
import { createMemo } from "solid-js"
import { parseShellCommands } from "../lib/shell.js"
import { inputItems } from "../lib/inspect.js"
import { Activity, DetailLines, displayPath, lifecycleOf, MetaGrid, PreviewList, RawEvidence, resolvedStatus, Section, statusLabel } from "./kit.jsx"

export function ShellView(props) {
  const text = createMemo(() => String(props.output ?? "").trim())
  const lifecycle = createMemo(() => lifecycleOf(props.part))
  const commands = createMemo(() => parseShellCommands(text()))
  const resultStatus = createMemo(() => text().match(/^TERMINAL RESULT: (SUCCESS|PARTIAL SUCCESS|FAILED)$/m)?.[1] ?? null)
  const status = createMemo(() => resolvedStatus(props.part, resultStatus()))
  const items = createMemo(() => commands().length ? commands().map((command) => ({ status: command.exit === 0 ? "SUCCESS" : command.exit == null ? "PARTIAL SUCCESS" : "FAILED", label: displayPath(command.label || command.command, 84), meta: command.duration || (command.exit == null ? "running" : `exit ${command.exit}`) })) : inputItems("shell", props.input))
  const meaning = createMemo(() => text().match(/^WHAT HAPPENED: (.+)$/m)?.[1] ?? `Executing ${items().length} command${items().length === 1 ? "" : "s"}`)
  return <Activity label="shell" summary={meaning().slice(0, 130)} meta={statusLabel(status(), lifecycle())} status={status()} pending={lifecycle().pending} skin={props.skin} preview={<PreviewList skin={props.skin} items={items()} />} details={() => commands().length ? <>{commands().map((command) => <Section title={`Command ${command.num} · ${command.label || "unlabelled"}`} skin={props.skin} color={command.exit === 0 ? props.skin.success : command.exit == null ? props.skin.accent : props.skin.error} meta={command.duration || `exit ${command.exit ?? "?"}`}><MetaGrid skin={props.skin} entries={[["command", command.command], ["directory", command.workdir], ["meaning", command.meaning], ["technical", command.technical.join(" · ")]]} /><Section title="Captured output" skin={props.skin}><DetailLines skin={props.skin} lines={command.body} limit={24} color={props.skin.text} /></Section></Section>)}</> : <RawEvidence skin={props.skin} text={lifecycle().error || text()} />} />
}
