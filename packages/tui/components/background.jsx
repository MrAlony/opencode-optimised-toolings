/** @jsxImportSource @opentui/solid */
import { createMemo } from "solid-js"
import { parseOperations } from "../lib/background.js"
import { inputItems } from "../lib/inspect.js"
import { Activity, ContentPane, InspectorCard, InspectorUnavailable, lifecycleOf, MetaGrid, OutcomeOverview, PreviewList, resolvedStatus, Section, statusLabel, statusPending } from "./kit.jsx"
function operationStatus(op) { if (/FAILED|ERROR/i.test(op.headline)) return "FAILED"; if (/RUNNING|STARTING|PENDING/i.test(op.headline)) return "PARTIAL SUCCESS"; if (/READY|STARTED|COMPLETED|REMOVED|STOPPED/i.test(op.headline)) return "SUCCESS"; return "PARTIAL SUCCESS" }
export function BackgroundView(props) {
  const text = createMemo(() => String(props.output ?? "").trim())
  const operations = createMemo(() => parseOperations(text()))
  const lifecycle = createMemo(() => lifecycleOf(props.part))
  const resultStatus = createMemo(() => operations().some((op) => operationStatus(op) === "FAILED") ? operations().some((op) => operationStatus(op) === "SUCCESS") ? "PARTIAL SUCCESS" : "FAILED" : operations().length ? "SUCCESS" : null)
  const status = createMemo(() => resolvedStatus(props.part, resultStatus()))
  const items = createMemo(() => operations().length ? operations().map((op) => ({ status: operationStatus(op), label: op.label, meta: op.headline.slice(0, 40) })) : inputItems("alonix-background-process", props.input))
  const summary = createMemo(() => operations().length ? `${operations().length} operation${operations().length === 1 ? "" : "s"} · ${operations().filter((op) => operationStatus(op) === "FAILED").length} failed` : `${items().length} operation${items().length === 1 ? "" : "s"}`)
  const details = () => operations().length ? <><OutcomeOverview skin={props.skin} status={resultStatus()} summary={text().match(/^WHAT HAPPENED: (.+)$/m)?.[1] ?? summary()} facts={[["operations", operations().length], ["successful", operations().filter((op) => operationStatus(op) === "SUCCESS").length], ["failed", operations().filter((op) => operationStatus(op) === "FAILED").length], ["active or uncertain", operations().filter((op) => operationStatus(op) === "PARTIAL SUCCESS").length]]} meaning={["Each operation below shows its actual state before identifiers and diagnostics."]} /><Section title="Operation results" skin={props.skin}>{operations().map((op) => <InspectorCard title={`${op.num}. ${op.label}`} skin={props.skin} status={operationStatus(op)} meta={op.headline}>{op.body.length ? <ContentPane title="Observed result" skin={props.skin} lines={op.body} limit={18} /> : null}<MetaGrid skin={props.skin} entries={op.kv} /></InspectorCard>)}</Section></> : statusPending(status()) ? <InspectorCard title="Process plan" skin={props.skin} status={status()} pending meta={`${items().length} operation(s)`}><PreviewList skin={props.skin} items={items()} limit={12} /></InspectorCard> : <InspectorUnavailable skin={props.skin} message={lifecycle().error || "The completed background-process response did not contain recognizable operation blocks."} />
  return <Activity label="Process" summary={summary()} meta={statusLabel(status())} status={status()} pending={statusPending(status())} skin={props.skin} preview={<PreviewList skin={props.skin} items={items()} />} details={details} />
}
