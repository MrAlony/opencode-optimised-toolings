/** @jsxImportSource @opentui/solid */
import { createMemo } from "solid-js"
import { parseDiscovery } from "../lib/inspect.js"
import { Activity, ContentPane, InspectorCard, lifecycleOf, MetaGrid, PreviewList, RawEvidence, resolvedStatus, statusLabel } from "./kit.jsx"

export function DiscoveryView(props) {
  const parsed = createMemo(() => parseDiscovery(props.output ?? "", props.tool))
  const lifecycle = createMemo(() => lifecycleOf(props.part))
  const status = createMemo(() => resolvedStatus(props.part, parsed()?.status))
  const items = createMemo(() => parsed()?.items ?? [])
  const summary = createMemo(() => lifecycle().phase === "completed" ? parsed()?.summary ?? `${props.tool} completed` : props.tool === "fs_search" ? `Searching ${props.input?.file_pattern ?? "files"}` : `Exploring ${props.input?.base_dir ?? "project"}`)
  return <Activity label={props.tool === "fs_search" ? "search" : "explore"} summary={summary()} meta={statusLabel(status(), lifecycle())} status={status()} pending={lifecycle().pending} skin={props.skin} preview={items().length ? <PreviewList skin={props.skin} items={items()} /> : null} details={() => parsed() ? <><InspectorCard title={props.tool === "fs_search" ? "Search coverage" : "Exploration coverage"} skin={props.skin} status={parsed().status} meta={`${items().length} component(s)`}><MetaGrid skin={props.skin} entries={Object.entries(parsed().metrics ?? {})} /></InspectorCard>{items().map((item, index) => <InspectorCard title={`${index + 1}. ${item.label}`} skin={props.skin} status={item.status} meta={item.meta} />)}<ContentPane title="Bounded discovery evidence" skin={props.skin} lines={String(parsed().raw).split(/\r?\n/)} limit={32} /></> : <RawEvidence skin={props.skin} text={lifecycle().error || props.output} />} />
}
