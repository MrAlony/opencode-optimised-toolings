/** @jsxImportSource @opentui/solid */
import { createMemo } from "solid-js"
import { parseReportBlocks, reportStatus, reportSummary } from "../lib/report.js"
import { Activity, ContentPane, InspectorCard, InspectorUnavailable, lifecycleOf, MetaGrid, OutcomeOverview, resolvedStatus, Section, statusLabel, statusPending } from "./kit.jsx"
function displayTool(tool) { return String(tool).replace(/^alonix-/, "").split("-").map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" ") }
export function ReportView(props) {
  const text = createMemo(() => String(props.output ?? "").trim())
  const lifecycle = createMemo(() => lifecycleOf(props.part))
  const resultStatus = createMemo(() => text() ? reportStatus(text(), props.tool) : null)
  const status = createMemo(() => resolvedStatus(props.part, resultStatus()))
  const nodes = createMemo(() => parseReportBlocks(text()))
  const entries = createMemo(() => nodes().flatMap((node) => node.type === "kv" ? [[node.key, node.value]] : node.type === "list" ? node.items.map((item) => ["•", item]) : []))
  const sections = createMemo(() => nodes().filter((node) => node.type === "section" || node.type === "text"))
  const summary = createMemo(() => text() ? reportSummary(text(), props.tool) : "waiting for result")
  const details = () => text() ? <><OutcomeOverview skin={props.skin} status={status()} summary={summary()} facts={[["structured fields", entries().length], ["evidence sections", sections().length]]} meaning={["This fallback shows parsed fields and bounded evidence; raw transport output is not repeated."]} />{entries().length ? <InspectorCard title="Key results" skin={props.skin} status={status()}><MetaGrid skin={props.skin} entries={entries()} limit={16} /></InspectorCard> : null}{sections().length ? <Section title="Evidence" skin={props.skin}>{sections().map((node, index) => <InspectorCard title={node.type === "section" ? node.title : `Evidence ${index + 1}`} skin={props.skin} status={status()}><ContentPane skin={props.skin} lines={node.lines ?? []} limit={16} tail={false} /></InspectorCard>)}</Section> : <InspectorUnavailable skin={props.skin} message="The tool returned text, but no useful structured fields or evidence sections were recognized." />}</> : statusPending(status()) ? <InspectorCard title={`${displayTool(props.tool)} plan`} skin={props.skin} status={status()} pending><text fg={props.skin.muted}>Waiting for the tool result.</text></InspectorCard> : <InspectorUnavailable skin={props.skin} message={lifecycle().error || "The completed tool response was empty."} />
  return <Activity label={displayTool(props.tool)} summary={summary()} meta={statusLabel(status())} status={status()} pending={statusPending(status())} skin={props.skin} details={details} />
}
