/** @jsxImportSource @opentui/solid */
import { createMemo } from "solid-js"
import { declaredCounts, inputPlanAvailable, pendingPlanSummary, reconcileBatch, visibleOutcome } from "../lib/batch.js"
import { parseShellCommands } from "../lib/shell.js"
import { inputItems } from "../lib/inspect.js"
import { Activity, ContentPane, displayPath, InspectorCard, InspectorDegraded, InspectorUnavailable, lifecycleOf, MetaGrid, OutcomeOverview, PreviewList, resolvedStatus, Section, statusLabel, statusPending } from "./kit.jsx"
function commandStatus(command) { return command.exit === 0 ? "SUCCESS" : command.exit == null ? "PARTIAL SUCCESS" : "FAILED" }
export function ShellView(props) {
  const text = createMemo(() => String(props.output ?? "").trim())
  const lifecycle = createMemo(() => lifecycleOf(props.part))
  const commands = createMemo(() => parseShellCommands(text()))
  const resultStatus = createMemo(() => text().match(/^TERMINAL RESULT: (SUCCESS|PARTIAL SUCCESS|FAILED)$/m)?.[1] ?? null)
  const status = createMemo(() => resolvedStatus(props.part, resultStatus()))
  const plan = createMemo(() => inputItems("alonix-shell", props.input))
  const planReady = createMemo(() => inputPlanAvailable("alonix-shell", props.input))
  const observed = createMemo(() => commands().map((command) => ({ ...command, status: commandStatus(command), label: displayPath(command.label || command.command, 84), meta: command.duration || (command.exit == null ? "incomplete" : `exit ${command.exit}`) })))
  const batch = createMemo(() => reconcileBatch(plan(), observed()))
  const items = createMemo(() => batch().records)
  const counts = createMemo(() => declaredCounts(text().match(/^WHAT HAPPENED: (.+)$/m)?.[1]))
  const visible = createMemo(() => visibleOutcome(items()))
  const summary = createMemo(() => resultStatus() ? `${counts().succeeded ?? visible().succeeded}/${batch().plannedCount} commands succeeded${batch().omitted.length ? ` · ${batch().omitted.length} details omitted` : ""}` : pendingPlanSummary(planReady(), batch().plannedCount, "command"))
  const details = () => {
    if (commands().length || resultStatus()) return <><OutcomeOverview skin={props.skin} status={resultStatus() ?? "PARTIAL SUCCESS"} summary={text().match(/^WHAT HAPPENED: (.+)$/m)?.[1] ?? summary()} facts={[["commands requested", batch().plannedCount], ["succeeded (declared)", counts().succeeded], ["visible result blocks", batch().observedCount], ["omitted result blocks", batch().omitted.length]]} meaning={batch().omitted.length ? ["The command plan remains intact; bounded output omitted some command result blocks."] : resultStatus() === "SUCCESS" ? ["Every command completed successfully."] : ["Review the failed command first; later sequential commands may not have run."]} /><Section title="Command results" skin={props.skin}>{items().map((command) => command.detailAvailable ? <InspectorCard title={`${command.number}. ${command.label || "Unlabelled command"}`} skin={props.skin} status={command.status} meta={command.duration || `exit ${command.exit ?? "?"}`} subtitle={command.meaning}>{command.body.length ? <ContentPane title="Output" skin={props.skin} lines={command.body} limit={24} /> : <ContentPane title="Output" skin={props.skin} lines={["No output was captured."]} tail={false} />}<MetaGrid skin={props.skin} entries={[["exit", command.exit ?? "not completed"], ["command", command.command], ["directory", command.workdir]]} />{command.technical.length ? <ContentPane title="Diagnostics" skin={props.skin} lines={command.technical} limit={10} /> : null}</InspectorCard> : <InspectorDegraded skin={props.skin} title={`${command.number}. ${command.label}`} subtitle="This command remained in the batch plan, but its result block was omitted." />)}</Section></>
    if (statusPending(status())) return <InspectorCard title={planReady() ? "Command plan" : "Preparing command"} skin={props.skin} status={status()} pending meta={planReady() ? `${batch().plannedCount} command(s)` : "input pending"}>{planReady() ? <PreviewList skin={props.skin} items={items()} limit={12} /> : <text fg={props.skin.muted}>Waiting for OpenCode to attach the validated command input.</text>}</InspectorCard>
    if (lifecycle().phase === "error") return <InspectorUnavailable skin={props.skin} message={lifecycle().error} />
    return <InspectorDegraded skin={props.skin} items={items()} message="The completed terminal response was bounded before its structured result. The command plan remains authoritative." />
  }
  return <Activity evidence={props.output} label="Shell" summary={summary()} meta={statusLabel(status())} status={status()} pending={statusPending(status())} skin={props.skin} preview={items().length ? <PreviewList skin={props.skin} items={items()} /> : null} details={details} />
}
