/** @jsxImportSource @opentui/solid */
import { createMemo } from "solid-js"
import { parseWebFetch, parseWebSearch, inputItems } from "../lib/inspect.js"
import { Activity, DetailLines, lifecycleOf, MetaGrid, PreviewList, RawEvidence, resolvedStatus, Section, statusLabel } from "./kit.jsx"

function FetchDetails(props) {
  return <>{props.items.map((item) => <Section title={`URL ${item.number} · ${item.titleText || item.title}`} skin={props.skin} color={item.status === "FAILED" ? props.skin.error : props.skin.success}><MetaGrid skin={props.skin} entries={[["outcome", item.outcome], ["final URL", item.finalUrl], ["cache", item.cache], ["duration", item.duration], ["content", item.content], ["completeness", item.completeness], ["error", item.error]]} /><DetailLines skin={props.skin} lines={item.extracted.split(/\r?\n/)} limit={18} color={props.skin.text} tail={false} /></Section>)}</>
}

function SearchDetails(props) {
  return <>{props.items.map((item) => <Section title={`Query ${item.number} · ${item.title}`} skin={props.skin} color={item.status === "FAILED" ? props.skin.error : props.skin.success} meta={item.outcome}><MetaGrid skin={props.skin} entries={[["cache", item.cache], ["backend attempts", item.attempts.join(" · ")]]} />{item.results.slice(0, 8).map((result) => <Section title={result.title} skin={props.skin} meta={result.source}><text fg={props.skin.accent}>{result.url}</text><text fg={props.skin.text}>{result.snippet}</text></Section>)}</Section>)}</>
}

export function WebView(props) {
  const parsed = createMemo(() => props.tool === "web_fetch_many" ? parseWebFetch(props.output ?? "") : parseWebSearch(props.output ?? ""))
  const lifecycle = createMemo(() => lifecycleOf(props.part))
  const status = createMemo(() => resolvedStatus(props.part, parsed()?.status))
  const items = createMemo(() => parsed()?.items?.map((item) => ({ status: item.status, label: item.titleText || item.title, meta: item.outcome || item.http })) ?? inputItems(props.tool, props.input))
  const summary = createMemo(() => lifecycle().phase === "completed" ? parsed()?.summary ?? `${props.tool} completed` : props.tool === "web_fetch_many" ? `Fetching ${items().length} URL${items().length === 1 ? "" : "s"}` : `Searching ${items().length} quer${items().length === 1 ? "y" : "ies"}`)
  return <Activity label={props.tool === "web_fetch_many" ? "web fetch" : "web search"} summary={summary()} meta={statusLabel(status(), lifecycle())} status={status()} pending={lifecycle().pending} skin={props.skin} preview={<PreviewList skin={props.skin} items={items()} />} details={() => parsed() ? (props.tool === "web_fetch_many" ? <FetchDetails skin={props.skin} items={parsed().items} /> : <SearchDetails skin={props.skin} items={parsed().items} />) : <RawEvidence skin={props.skin} text={lifecycle().error || props.output} />} />
}
