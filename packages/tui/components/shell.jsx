/** @jsxImportSource @opentui/solid */
import { createMemo } from "solid-js"
import { parseShellCommands } from "../lib/shell.js"
import { inputItems } from "../lib/inspect.js"
import { Activity, ContentPane, displayPath, InspectorCard, lifecycleOf, MetaGrid, OutcomeOverview, PreviewList, RawEvidence, resolvedStatus, Section, statusLabel } from "./kit.jsx"

function commandStatus(command) { return command.exit === 0 ? "SUCCESS" : command.exit == null ? "PARTIAL SUCCESS" : "FAILED" }

export function ShellView(props) {
  const text = createMemo(() => String(props.output ?? "").trim())
  const lifecycle = createMemo(() => lifecycleOf(props.part))
  const commands = createMemo(() => parseShellCommands(text()))
  const resultStatus = createMemo(() => text().match(/^TERMINAL RESULT: (SUCCESS|PARTIAL SUCCESS|FAILED)$/m)?.[1] ?? null)
  const status = createMemo(() => resolvedStatus(props.part, resultStatus()))
  const items = createMemo(() => commands().length ? commands().map((command) => ({ status: commandStatus(command), label: displayPath(command.label || command.command, 84), meta: command.duration || (command.exit == null ? "running" : `exit ${command.exit}`) })) : inputItems("alonix-shell", props.input))
  const meaning = createMemo(() => text().match(/^WHAT HAPPENED: (.+)$/m)?.[1] ?? `Executing ${items().length} command${items().length === 1 ? "" : "s"}`)
  const details = () => commands().length ? <><OutcomeOverview skin={props.skin} status={resultStatus() ?? "PARTIAL SUCCESS"} summary={meaning()} facts={[["commands", commands().length], ["succeeded", commands().filter((item) => item.exit === 0).length], ["failed or interrupted", commands().filter((item) => item.exit !== 0).length]]} meaning={resultStatus() === "SUCCESS" ? ["Every command completed successfully."] : ["Review the failed command first; later sequential commands may not have run."]} /><Section title="Command results" skin={props.skin}>{commands().map((command) => <InspectorCard title={`Command ${command.num} · ${command.label || "unlabelled"}`} skin={props.skin} status={commandStatus(command)} meta={command.duration || `exit ${command.exit ?? "?"}`} subtitle={command.meaning}>{command.body.length ? <ContentPane title="What the command printed" skin={props.skin} lines={command.body} limit={24} /> : <ContentPane title="What the command printed" skin={props.skin} lines={["No output was captured."]} tail={false} />}<MetaGrid skin={props.skin} entries={[["exit", command.exit ?? "not completed"], ["command", command.command], ["directory", command.workdir]]} />{command.technical.length ? <ContentPane title="Technical diagnostics" skin={props.skin} lines={command.technical} limit={10} /> : null}</InspectorCard>)}</Section></> : <RawEvidence skin={props.skin} text={lifecycle().error || text()} />
  return <Activity label="shell" summary={meaning().slice(0, 130)} meta={statusLabel(status(), lifecycle())} status={status()} pending={lifecycle().pending} skin={props.skin} preview={<PreviewList skin={props.skin} items={items()} />} details={details} />
}
