/** @jsxImportSource @opentui/solid */
import { createMemo } from "solid-js"
import { parseReportBlocks, reportStatus, reportSummary } from "../lib/report.js"
import { Activity, lifecycleOf, MetaGrid, RawEvidence, resolvedStatus, Section, statusLabel } from "./kit.jsx"

export function ReportView(props) {
  const text = createMemo(() => String(props.output ?? "").trim())
  const lifecycle = createMemo(() => lifecycleOf(props.part))
  const resultStatus = createMemo(() => text() ? reportStatus(text(), props.tool) : null)
  const status = createMemo(() => resolvedStatus(props.part, resultStatus()))
  const nodes = createMemo(() => parseReportBlocks(text()))
  const entries = createMemo(() => nodes().flatMap((node) => node.type === "kv" ? [[node.key, node.value]] : node.type === "list" ? node.items.map((item) => ["•", item]) : node.type === "section" ? [[node.title, ""]] : node.lines.map((line) => ["", line])))
  const summary = createMemo(() => lifecycle().phase === "completed" ? reportSummary(text(), props.tool) : `${props.tool} is ${lifecycle().label}`)
  return <Activity label={props.tool} summary={summary()} meta={statusLabel(status(), lifecycle())} status={status()} pending={lifecycle().pending} skin={props.skin} details={() => <><Section title="Parsed details" skin={props.skin}><MetaGrid skin={props.skin} entries={entries()} limit={20} /></Section><RawEvidence skin={props.skin} text={lifecycle().error || text()} limit={32} /></>} />
}
