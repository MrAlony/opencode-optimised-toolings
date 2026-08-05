/** @jsxImportSource @opentui/solid */
import { createMemo } from "solid-js"
import { parseWebFetch, parseWebSearch, inputItems } from "../lib/inspect.js"
import { Activity, ContentPane, InspectorCard, lifecycleOf, MetaGrid, OutcomeOverview, PreviewList, RawEvidence, resolvedStatus, Section, statusLabel } from "./kit.jsx"

function FetchDetails(props) {
  return <Section title="URL results" skin={props.skin}>{props.items.map((item) => <InspectorCard title={`URL ${item.number} · ${item.titleText || item.title}`} skin={props.skin} status={item.status} meta={item.outcome} subtitle={item.status === "FAILED" ? item.error || "No content was returned." : item.finalUrl && item.finalUrl !== item.title ? item.finalUrl : "Content was fetched and extracted."}>{item.extracted ? <ContentPane title="Useful content returned" skin={props.skin} lines={item.extracted.split(/\r?\n/)} limit={20} tail={false} /> : <ContentPane title="Useful content returned" skin={props.skin} lines={[item.error || "No extracted content was returned for this URL."]} tail={false} color={item.status === "FAILED" ? props.skin.error : props.skin.muted} />}<MetaGrid skin={props.skin} entries={[["final URL", item.finalUrl], ["completeness", item.completeness], ["cache", item.cache], ["duration", item.duration], ["content metadata", item.content]]} /></InspectorCard>)}</Section>
}

function SearchDetails(props) {
  return <Section title="Query results" skin={props.skin}>{props.items.map((item) => <InspectorCard title={`Query ${item.number} · ${item.title}`} skin={props.skin} status={item.status} meta={item.outcome} subtitle={item.results.length ? `${item.results.length} result(s) returned.` : "No usable result was returned for this query."}>{item.results.slice(0, 8).map((result, index) => <InspectorCard title={`${index + 1}. ${result.title}`} skin={props.skin} status="SUCCESS" meta={result.source} subtitle={result.url} nested><text fg={props.skin.text}>{result.snippet}</text></InspectorCard>)}<MetaGrid skin={props.skin} entries={[["cache", item.cache], ["backend attempts", item.attempts.join(" · ")]]} /></InspectorCard>)}</Section>
}

export function WebView(props) {
  const isFetch = createMemo(() => props.tool === "alonix-web-fetch-many")
  const parsed = createMemo(() => isFetch() ? parseWebFetch(props.output ?? "") : parseWebSearch(props.output ?? ""))
  const lifecycle = createMemo(() => lifecycleOf(props.part))
  const status = createMemo(() => resolvedStatus(props.part, parsed()?.status))
  const items = createMemo(() => parsed()?.items?.map((item) => ({ status: item.status, label: item.titleText || item.title, meta: item.outcome || item.http })) ?? inputItems(props.tool, props.input))
  const summary = createMemo(() => lifecycle().phase === "completed" ? parsed()?.summary ?? `${props.tool} completed` : isFetch() ? `Fetching ${items().length} URL${items().length === 1 ? "" : "s"}` : `Searching ${items().length} quer${items().length === 1 ? "y" : "ies"}`)
  const details = () => parsed() ? <><OutcomeOverview skin={props.skin} status={parsed().status} summary={parsed().summary} facts={[[isFetch() ? "URLs" : "queries", parsed().items.length], ["successful", parsed().items.filter((item) => item.status === "SUCCESS").length], ["partial or failed", parsed().items.filter((item) => item.status !== "SUCCESS").length], ["allocation", parsed().allocation]]} meaning={parsed().status === "SUCCESS" ? ["Every requested item returned usable evidence."] : ["Some items returned usable evidence and others did not.", "Each item card below states its own outcome; do not apply the overall status to every URL or query."]} />{isFetch() ? <FetchDetails skin={props.skin} items={parsed().items} /> : <SearchDetails skin={props.skin} items={parsed().items} />}</> : <RawEvidence skin={props.skin} text={lifecycle().error || props.output} />
  return <Activity label={isFetch() ? "web fetch" : "web search"} summary={summary()} meta={statusLabel(status(), lifecycle())} status={status()} pending={lifecycle().pending} skin={props.skin} preview={<PreviewList skin={props.skin} items={items()} />} details={details} />
}
