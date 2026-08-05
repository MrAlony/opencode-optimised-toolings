/** @jsxImportSource @opentui/solid */
import { createMemo } from "solid-js"
import { parseDiscovery } from "../lib/inspect.js"
import { Activity, lifecycleOf, MetaGrid, PreviewList, RawEvidence, resolvedStatus, Section, statusLabel } from "./kit.jsx"

export function DiscoveryView(props) {
  const parsed = createMemo(() => parseDiscovery(props.output ?? "", props.tool))
  const lifecycle = createMemo(() => lifecycleOf(props.part))
  const status = createMemo(() => resolvedStatus(props.part, parsed()?.status))
  const items = createMemo(() => parsed()?.items ?? [])
  const summary = createMemo(() => lifecycle().phase === "completed" ? parsed()?.summary ?? `${props.tool} completed` : props.tool === "fs_search" ? `Searching ${props.input?.file_pattern ?? "files"}` : `Exploring ${props.input?.base_dir ?? "project"}`)
  return <Activity label={props.tool === "fs_search" ? "search" : "explore"} summary={summary()} meta={statusLabel(status(), lifecycle())} status={status()} pending={lifecycle().pending} skin={props.skin} preview={items().length ? <PreviewList skin={props.skin} items={items()} /> : null} details={() => parsed() ? <><Section title="Metrics" skin={props.skin}><MetaGrid skin={props.skin} entries={Object.entries(parsed().metrics ?? {})} /></Section><RawEvidence skin={props.skin} text={parsed().raw} limit={32} /></> : <RawEvidence skin={props.skin} text={lifecycle().error || props.output} />} />
}
