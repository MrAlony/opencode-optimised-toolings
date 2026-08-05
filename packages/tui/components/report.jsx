/** @jsxImportSource @opentui/solid */
import { createMemo } from "solid-js"
import { parseReportBlocks, reportStatus, reportSummary } from "../lib/report.js"
import { Activity, ContentPane, InspectorCard, lifecycleOf, MetaGrid, RawEvidence, resolvedStatus, statusLabel } from "./kit.jsx"

export function ReportView(props) {
  const text = createMemo(() => String(props.output ?? "").trim())
  const lifecycle = createMemo(() => lifecycleOf(props.part))
  const resultStatus = createMemo(() => text() ? reportStatus(text(), props.tool) : null)
  const status = createMemo(() => resolvedStatus(props.part, resultStatus()))
  const nodes = createMemo(() => parseReportBlocks(text()))
  const entries = createMemo(() => nodes().flatMap((node) => node.type === "kv" ? [[node.key, node.value]] : node.type === "list" ? node.items.map((item) => ["•", item]) : []))
  const sections = createMemo(() => nodes().filter((node) => node.type === "section" || node.type === "text"))
  const summary = createMemo(() => lifecycle().phase === "completed" ? reportSummary(text(), props.tool) : `${props.tool} is ${lifecycle().label}`)
  return <Activity label={props.tool} summary={summary()} meta={statusLabel(status(), lifecycle())} status={status()} pending={lifecycle().pending} skin={props.skin} details={() => <><InspectorCard title="Parsed details" skin={props.skin} status={status()}><MetaGrid skin={props.skin} entries={entries()} limit={20} /></InspectorCard>{sections().map((node, index) => <InspectorCard title={node.type === "section" ? node.title : `Evidence ${index + 1}`} skin={props.skin} status={status()}><ContentPane skin={props.skin} lines={node.lines ?? []} limit={16} /></InspectorCard>)}<RawEvidence skin={props.skin} text={lifecycle().error || text()} limit={24} /></>} />
}
