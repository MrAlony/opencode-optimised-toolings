/** @jsxImportSource @opentui/solid */
import { createMemo } from "solid-js"
import { parseOperations } from "../lib/background.js"
import { inputItems } from "../lib/inspect.js"
import { Activity, ContentPane, InspectorCard, lifecycleOf, MetaGrid, OutcomeOverview, PreviewList, RawEvidence, resolvedStatus, Section, statusLabel } from "./kit.jsx"

function operationStatus(op) { if (/FAILED|ERROR/i.test(op.headline)) return "FAILED"; if (/RUNNING|STARTING|PENDING/i.test(op.headline)) return "PARTIAL SUCCESS"; if (/READY|STARTED|COMPLETED|REMOVED|STOPPED/i.test(op.headline)) return "SUCCESS"; return "PARTIAL SUCCESS" }

export function BackgroundView(props) {
  const text = createMemo(() => String(props.output ?? "").trim())
  const operations = createMemo(() => parseOperations(text()))
  const lifecycle = createMemo(() => lifecycleOf(props.part))
  const resultStatus = createMemo(() => operations().some((op) => operationStatus(op) === "FAILED") ? operations().some((op) => operationStatus(op) === "SUCCESS") ? "PARTIAL SUCCESS" : "FAILED" : "SUCCESS")
  const status = createMemo(() => resolvedStatus(props.part, resultStatus()))
  const items = createMemo(() => operations().length ? operations().map((op) => ({ status: operationStatus(op), label: op.label, meta: op.headline.slice(0, 40) })) : inputItems("alonix-background-process", props.input))
  const summary = createMemo(() => lifecycle().phase === "completed" ? text().match(/^WHAT HAPPENED: (.+)$/m)?.[1] ?? `Processed ${items().length} operations` : `Managing ${items().length} background operation${items().length === 1 ? "" : "s"}`)
  const details = () => operations().length ? <><OutcomeOverview skin={props.skin} status={resultStatus()} summary={summary()} facts={[["operations", operations().length], ["successful", operations().filter((op) => operationStatus(op) === "SUCCESS").length], ["failed", operations().filter((op) => operationStatus(op) === "FAILED").length], ["still active or uncertain", operations().filter((op) => operationStatus(op) === "PARTIAL SUCCESS").length]]} meaning={["Each operation below starts with its actual state; process identifiers and diagnostics follow only when useful."]} /><Section title="Operation results" skin={props.skin}>{operations().map((op) => <InspectorCard title={`Operation ${op.num} · ${op.label}`} skin={props.skin} status={operationStatus(op)} meta={op.headline} subtitle={op.headline}>{op.body.length ? <ContentPane title="Observed result" skin={props.skin} lines={op.body} limit={18} /> : null}<MetaGrid skin={props.skin} entries={op.kv} /></InspectorCard>)}</Section></> : <RawEvidence skin={props.skin} text={lifecycle().error || text()} />
  return <Activity label="process" summary={summary().slice(0, 130)} meta={statusLabel(status(), lifecycle())} status={status()} pending={lifecycle().pending} skin={props.skin} preview={<PreviewList skin={props.skin} items={items()} />} details={details} />
}
