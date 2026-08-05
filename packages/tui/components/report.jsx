/** @jsxImportSource @opentui/solid */
import { createMemo } from "solid-js"
import { parseReportBlocks, reportStatus, reportSummary } from "../lib/report.js"
import { Activity, ContentPane, InspectorCard, lifecycleOf, MetaGrid, OutcomeOverview, RawEvidence, resolvedStatus, Section, statusLabel } from "./kit.jsx"

export function ReportView(props) {
  const text = createMemo(() => String(props.output ?? "").trim())
  const lifecycle = createMemo(() => lifecycleOf(props.part))
  const resultStatus = createMemo(() => text() ? reportStatus(text(), props.tool) : null)
  const status = createMemo(() => resolvedStatus(props.part, resultStatus()))
  const nodes = createMemo(() => parseReportBlocks(text()))
  const entries = createMemo(() => nodes().flatMap((node) => node.type === "kv" ? [[node.key, node.value]] : node.type === "list" ? node.items.map((item) => ["•", item]) : []))
  const sections = createMemo(() => nodes().filter((node) => node.type === "section" || node.type === "text"))
  const summary = createMemo(() => lifecycle().phase === "completed" ? reportSummary(text(), props.tool) : `${props.tool} is ${lifecycle().label}`)
  const details = () => <><OutcomeOverview skin={props.skin} status={status()} summary={summary()} facts={[["structured fields", entries().length], ["evidence sections", sections().length]]} meaning={["This tool does not yet have a dedicated inspector; the most useful parsed evidence is shown before the raw report."]} />{entries().length ? <InspectorCard title="Key results" skin={props.skin} status={status()}><MetaGrid skin={props.skin} entries={entries()} limit={16} /></InspectorCard> : null}{sections().length ? <Section title="Evidence sections" skin={props.skin}>{sections().map((node, index) => <InspectorCard title={node.type === "section" ? node.title : `Evidence ${index + 1}`} skin={props.skin} status={status()}><ContentPane skin={props.skin} lines={node.lines ?? []} limit={16} tail={false} /></InspectorCard>)}</Section> : null}<RawEvidence skin={props.skin} text={lifecycle().error || text()} limit={18} /></>
  return <Activity label={props.tool} summary={summary()} meta={statusLabel(status(), lifecycle())} status={status()} pending={lifecycle().pending} skin={props.skin} details={details} />
}
