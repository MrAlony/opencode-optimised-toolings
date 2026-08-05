/** @jsxImportSource @opentui/solid */
import { createMemo } from "solid-js"
import { parseDiscovery } from "../lib/inspect.js"
import { Activity, ContentPane, InspectorCard, lifecycleOf, MetaGrid, OutcomeOverview, PreviewList, RawEvidence, resolvedStatus, Section, statusLabel } from "./kit.jsx"

export function DiscoveryView(props) {
  const parsed = createMemo(() => parseDiscovery(props.output ?? "", props.tool))
  const lifecycle = createMemo(() => lifecycleOf(props.part))
  const status = createMemo(() => resolvedStatus(props.part, parsed()?.status))
  const items = createMemo(() => parsed()?.items ?? [])
  const isSearch = createMemo(() => props.tool === "alonix-search")
  const summary = createMemo(() => lifecycle().phase === "completed" ? parsed()?.summary ?? `${props.tool} completed` : isSearch() ? `Searching ${props.input?.file_pattern ?? "files"}` : `Exploring ${props.input?.base_dir ?? "project"}`)
  const details = () => parsed() ? <><OutcomeOverview skin={props.skin} status={parsed().status} summary={parsed().summary} facts={isSearch() ? [["matching items", parsed().metrics?.["Matches found"] ?? items().length], ["files scanned", parsed().metrics?.["Files scanned"]], ["scan complete", parsed().metrics?.["Complete"]]] : [["components checked", items().length], ["complete components", items().filter((item) => item.status === "SUCCESS").length], ["partial components", items().filter((item) => item.status === "PARTIAL SUCCESS").length], ["failed components", items().filter((item) => item.status === "FAILED").length]]} meaning={parsed().status === "SUCCESS" ? ["Discovery completed within its configured bounds."] : ["The evidence below is usable, but at least one discovery boundary was incomplete or failed.", "Treat missing results as unknown unless the coverage card says the scan was complete."]} /><Section title={isSearch() ? "Matches and coverage" : "Exploration components"} skin={props.skin}>{items().map((item, index) => <InspectorCard title={`${index + 1}. ${item.label}`} skin={props.skin} status={item.status} meta={item.meta} subtitle={item.status === "PARTIAL SUCCESS" ? "Usable but bounded or incomplete evidence." : null} />)}</Section><InspectorCard title="Technical coverage" skin={props.skin} status={parsed().status} meta="verification details"><MetaGrid skin={props.skin} entries={Object.entries(parsed().metrics ?? {})} /><ContentPane title="Bounded report evidence" skin={props.skin} lines={String(parsed().raw).split(/\r?\n/)} limit={18} /></InspectorCard></> : <RawEvidence skin={props.skin} text={lifecycle().error || props.output} />
  return <Activity label={isSearch() ? "search" : "explore"} summary={summary()} meta={statusLabel(status(), lifecycle())} status={status()} pending={lifecycle().pending} skin={props.skin} preview={items().length ? <PreviewList skin={props.skin} items={items()} /> : null} details={details} />
}
