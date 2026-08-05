/** @jsxImportSource @opentui/solid */
import { createMemo } from "solid-js"
import { parseOperations } from "../lib/background.js"
import { inputItems } from "../lib/inspect.js"
import { Activity, ContentPane, InspectorCard, lifecycleOf, MetaGrid, PreviewList, RawEvidence, resolvedStatus, statusLabel } from "./kit.jsx"

function operationStatus(op) {
  if (/FAILED|ERROR/i.test(op.headline)) return "FAILED"
  if (/RUNNING|STARTING|PENDING/i.test(op.headline)) return "PARTIAL SUCCESS"
  if (/READY|STARTED|COMPLETED|REMOVED|STOPPED/i.test(op.headline)) return "SUCCESS"
  return "PARTIAL SUCCESS"
}

export function BackgroundView(props) {
  const text = createMemo(() => String(props.output ?? "").trim())
  const operations = createMemo(() => parseOperations(text()))
  const lifecycle = createMemo(() => lifecycleOf(props.part))
  const resultStatus = createMemo(() => operations().some((op) => operationStatus(op) === "FAILED") ? operations().some((op) => operationStatus(op) === "SUCCESS") ? "PARTIAL SUCCESS" : "FAILED" : "SUCCESS")
  const status = createMemo(() => resolvedStatus(props.part, resultStatus()))
  const items = createMemo(() => operations().length ? operations().map((op) => ({ status: operationStatus(op), label: op.label, meta: op.headline.slice(0, 40) })) : inputItems("background_process", props.input))
  const summary = createMemo(() => lifecycle().phase === "completed" ? text().match(/^WHAT HAPPENED: (.+)$/m)?.[1] ?? `Processed ${items().length} operations` : `Managing ${items().length} background operation${items().length === 1 ? "" : "s"}`)
  return <Activity label="process" summary={summary().slice(0, 130)} meta={statusLabel(status(), lifecycle())} status={status()} pending={lifecycle().pending} skin={props.skin} preview={<PreviewList skin={props.skin} items={items()} />} details={() => operations().length ? <>{operations().map((op) => <InspectorCard title={`Operation ${op.num} · ${op.label}`} skin={props.skin} status={operationStatus(op)} meta={op.headline}><MetaGrid skin={props.skin} entries={op.kv} />{op.body.length ? <ContentPane title="Process evidence" skin={props.skin} lines={op.body} limit={18} /> : null}</InspectorCard>)}</> : <RawEvidence skin={props.skin} text={lifecycle().error || text()} />} />
}
