/** @jsxImportSource @opentui/solid */
import { createMemo } from "solid-js"
import { inputPlanAvailable, pendingPlanSummary, reconcileBatch } from "../lib/batch.js"
import { parseOperations } from "../lib/background.js"
import { inputItems } from "../lib/inspect.js"
import { Activity, ContentPane, InspectorCard, InspectorDegraded, InspectorUnavailable, lifecycleOf, MetaGrid, OutcomeOverview, PreviewList, resolvedStatus, Section, statusLabel, statusPending } from "./kit.jsx"
function operationStatus(op) { if (/FAILED|ERROR/i.test(op.headline)) return "FAILED"; if (/RUNNING|STARTING|PENDING/i.test(op.headline)) return "PARTIAL SUCCESS"; if (/READY|STARTED|COMPLETED|REMOVED|STOPPED/i.test(op.headline)) return "SUCCESS"; return "PARTIAL SUCCESS" }
export function BackgroundView(props) {
  const text = createMemo(() => String(props.output ?? "").trim())
  const operations = createMemo(() => parseOperations(text()))
  const lifecycle = createMemo(() => lifecycleOf(props.part))
  const resultStatus = createMemo(() => operations().some((op) => operationStatus(op) === "FAILED") ? operations().some((op) => operationStatus(op) === "SUCCESS") ? "PARTIAL SUCCESS" : "FAILED" : operations().length ? "SUCCESS" : null)
  const status = createMemo(() => resolvedStatus(props.part, resultStatus()))
  const plan = createMemo(() => inputItems("alonix-background-process", props.input))
  const planReady = createMemo(() => inputPlanAvailable("alonix-background-process", props.input))
  const observed = createMemo(() => operations().map((op) => ({ ...op, status: operationStatus(op), label: op.label, meta: op.headline.slice(0, 40) })))
  const batch = createMemo(() => reconcileBatch(plan(), observed()))
  const items = createMemo(() => batch().records)
  const summary = createMemo(() => operations().length ? `${batch().plannedCount} operation${batch().plannedCount === 1 ? "" : "s"} · ${operations().filter((op) => operationStatus(op) === "FAILED").length} failed${batch().omitted.length ? ` · ${batch().omitted.length} details omitted` : ""}` : pendingPlanSummary(planReady(), batch().plannedCount, "operation"))
  const details = () => {
    if (operations().length) return <><OutcomeOverview skin={props.skin} status={resultStatus()} summary={text().match(/^WHAT HAPPENED: (.+)$/m)?.[1] ?? summary()} facts={[["operations requested", batch().plannedCount], ["visible state blocks", operations().length], ["omitted requested operations", batch().omitted.length], ["failed blocks", operations().filter((op) => operationStatus(op) === "FAILED").length]]} meaning={batch().omitted.length ? ["The operation plan remains intact; bounded output omitted some requested operation details."] : ["Each operation below shows its actual state before identifiers and diagnostics."]} /><Section title="Operation results" skin={props.skin}>{operations().map((op) => <InspectorCard title={`${op.num}. ${op.label}`} skin={props.skin} status={operationStatus(op)} meta={op.headline}>{op.body.length ? <ContentPane title="Observed result" skin={props.skin} lines={op.body} limit={18} /> : null}<MetaGrid skin={props.skin} entries={op.kv} /></InspectorCard>)}</Section>{batch().omitted.length ? <Section title="Requested operations without visible detail" skin={props.skin}>{batch().omitted.map((op) => <InspectorDegraded skin={props.skin} title={`${op.number}. ${op.label}`} />)}</Section> : null}</>
    if (statusPending(status())) return <InspectorCard title={planReady() ? "Process plan" : "Preparing process operation"} skin={props.skin} status={status()} pending meta={planReady() ? `${batch().plannedCount} operation(s)` : "input pending"}>{planReady() ? <PreviewList skin={props.skin} items={items()} limit={12} /> : <text fg={props.skin.muted}>Waiting for OpenCode to attach the validated process operations.</text>}</InspectorCard>
    if (lifecycle().phase === "error") return <InspectorUnavailable skin={props.skin} message={lifecycle().error} />
    return <InspectorDegraded skin={props.skin} items={items()} message="The completed process response was bounded before recognizable operation blocks. The operation plan remains authoritative." />
  }
  return <Activity evidence={props.output} label="Process" summary={summary()} meta={statusLabel(status())} status={status()} pending={statusPending(status())} skin={props.skin} preview={items().length ? <PreviewList skin={props.skin} items={items()} /> : null} details={details} />
}
