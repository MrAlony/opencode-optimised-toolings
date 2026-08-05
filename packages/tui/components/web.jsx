/** @jsxImportSource @opentui/solid */
import { createMemo } from "solid-js"
import { declaredCounts, reconcileBatch, visibleOutcome } from "../lib/batch.js"
import { inputItems, parseWebFetch, parseWebSearch } from "../lib/inspect.js"
import { Activity, ContentPane, InspectorCard, InspectorDegraded, InspectorUnavailable, lifecycleOf, MetaGrid, OutcomeOverview, PreviewList, resolvedStatus, Section, statusLabel, statusPending } from "./kit.jsx"

function FetchDetails(props) {
  return <Section title="URL results" skin={props.skin}>{props.items.map((item) => item.detailAvailable ? <InspectorCard title={`${item.number}. ${item.titleText || item.title || item.label}`} skin={props.skin} status={item.status} meta={item.outcome} subtitle={item.status === "FAILED" ? item.error || "No content returned." : item.finalUrl}>{item.extracted ? <ContentPane title="Extracted content" skin={props.skin} lines={item.extracted.split(/\r?\n/)} limit={20} tail={false} /> : <ContentPane title="Extracted content" skin={props.skin} lines={[item.error || "No extracted content was returned."]} tail={false} color={item.status === "FAILED" ? props.skin.error : props.skin.muted} />}<MetaGrid skin={props.skin} entries={[["final URL", item.finalUrl], ["completeness", item.completeness], ["cache", item.cache], ["duration", item.duration]]} /></InspectorCard> : <InspectorDegraded skin={props.skin} title={`${item.number}. ${item.label}`} subtitle="This URL remained in the request plan, but its result block was omitted from the bounded transcript output." />)}</Section>
}
function SearchDetails(props) {
  return <Section title="Query results" skin={props.skin}>{props.items.map((item) => item.detailAvailable ? <InspectorCard title={`${item.number}. ${item.title || item.label}`} skin={props.skin} status={item.status} meta={item.outcome} subtitle={item.results.length ? `${item.results.length} result(s)` : "No usable result returned."}>{item.results.slice(0, 8).map((result, index) => <InspectorCard title={`${index + 1}. ${result.title}`} skin={props.skin} status="SUCCESS" meta={result.source} subtitle={result.url} nested><text fg={props.skin.text}>{result.snippet}</text></InspectorCard>)}<MetaGrid skin={props.skin} entries={[["cache", item.cache], ["backend attempts", item.attempts.join(" · ")]]} /></InspectorCard> : <InspectorDegraded skin={props.skin} title={`${item.number}. ${item.label}`} subtitle="This query remained in the request plan, but its result block was omitted from the bounded transcript output." />)}</Section>
}

export function WebView(props) {
  const isFetch = createMemo(() => props.tool === "alonix-web-fetch-many")
  const parsed = createMemo(() => isFetch() ? parseWebFetch(props.output ?? "") : parseWebSearch(props.output ?? ""))
  const lifecycle = createMemo(() => lifecycleOf(props.part))
  const status = createMemo(() => resolvedStatus(props.part, parsed()?.status))
  const plan = createMemo(() => inputItems(props.tool, props.input))
  const batch = createMemo(() => reconcileBatch(plan(), parsed()?.items ?? [], { meta: (_requested, result) => result.outcome || result.http || result.meta }))
  const items = createMemo(() => batch().records)
  const counts = createMemo(() => declaredCounts(parsed()?.summary))
  const visible = createMemo(() => visibleOutcome(items()))
  const noun = createMemo(() => isFetch() ? "URL" : "query")
  const label = createMemo(() => isFetch() ? "Web fetch" : "Web search")
  const summary = createMemo(() => parsed() ? `${counts().succeeded ?? visible().succeeded}/${batch().plannedCount} ${isFetch() ? "URLs" : "queries"} succeeded${batch().omitted.length ? ` · ${batch().omitted.length} detail${batch().omitted.length === 1 ? "" : "s"} omitted` : ""}` : `${batch().plannedCount} ${noun()}${batch().plannedCount === 1 ? "" : "s"}`)
  const details = () => {
    const result = parsed()
    if (result) return <><OutcomeOverview skin={props.skin} status={result.status} summary={result.summary} facts={[[isFetch() ? "URLs requested" : "queries requested", batch().plannedCount], ["successful (declared)", counts().succeeded], ["visible result blocks", batch().observedCount], ["omitted result blocks", batch().omitted.length], ["allocation", result.allocation]]} meaning={batch().omitted.length ? ["The request plan owns batch identity and cardinality.", "Missing result blocks were omitted by bounded transcript output; they are not silently removed or reported as renderer failures."] : result.status === "SUCCESS" ? ["Every requested item returned usable evidence."] : ["Each item below has its own outcome; do not apply the overall status to every URL or query."]} />{isFetch() ? <FetchDetails skin={props.skin} items={items()} /> : <SearchDetails skin={props.skin} items={items()} />}</>
    if (statusPending(status())) return <InspectorCard title={`${label()} plan`} skin={props.skin} status={status()} pending meta={`${batch().plannedCount} item(s)`}><PreviewList skin={props.skin} items={items()} limit={12} /></InspectorCard>
    if (lifecycle().phase === "error") return <InspectorUnavailable skin={props.skin} message={lifecycle().error} />
    return <InspectorDegraded skin={props.skin} items={items()} message={`The completed ${props.tool} response was bounded before its structured report header. The ${batch().plannedCount}-item request plan remains authoritative.`} />
  }
  return <Activity label={label()} summary={summary()} meta={statusLabel(status())} status={status()} pending={statusPending(status())} skin={props.skin} preview={<PreviewList skin={props.skin} items={items()} />} details={details} />
}
