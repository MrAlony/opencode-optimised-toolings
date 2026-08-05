/** @jsxImportSource @opentui/solid */
import { createMemo } from "solid-js"
import { inputPlanAvailable } from "../lib/batch.js"
import { inputItems, parseDiscovery } from "../lib/inspect.js"
import { Activity, ContentPane, InspectorCard, InspectorDegraded, InspectorUnavailable, lifecycleOf, MetaGrid, OutcomeOverview, PreviewList, resolvedStatus, Section, statusLabel, statusPending } from "./kit.jsx"
export function DiscoveryView(props) {
  const parsed = createMemo(() => parseDiscovery(props.output ?? "", props.tool))
  const lifecycle = createMemo(() => lifecycleOf(props.part))
  const status = createMemo(() => resolvedStatus(props.part, parsed()?.status))
  const items = createMemo(() => parsed()?.items ?? inputItems(props.tool, props.input))
  const isSearch = createMemo(() => props.tool === "alonix-search")
  const planReady = createMemo(() => inputPlanAvailable(props.tool, props.input))
  const label = createMemo(() => isSearch() ? "Search" : "Explore")
  const summary = createMemo(() => parsed() ? parsed().summary : planReady() ? isSearch() ? String(props.input.file_pattern) : String(props.input.base_dir) : `${label().toLowerCase()} input pending`)
  const details = () => {
    const result = parsed()
    if (result) return <><OutcomeOverview skin={props.skin} status={result.status} summary={result.summary} facts={isSearch() ? [["matching items", result.metrics?.["Matches found"] ?? items().length], ["files scanned", result.metrics?.["Files scanned"]], ["scan complete", result.metrics?.["Complete"]]] : [["components", items().length], ["complete", items().filter((item) => item.status === "SUCCESS").length], ["partial", items().filter((item) => item.status === "PARTIAL SUCCESS").length], ["failed", items().filter((item) => item.status === "FAILED").length]]} meaning={result.status === "SUCCESS" ? ["Discovery completed within its configured bounds."] : ["At least one discovery boundary was incomplete or failed.", "Missing results remain unknown unless coverage explicitly says complete."]} /><Section title={isSearch() ? "Matches and coverage" : "Exploration components"} skin={props.skin}>{items().map((item, index) => <InspectorCard title={`${index + 1}. ${item.label}`} skin={props.skin} status={item.status} meta={item.meta} />)}</Section><InspectorCard title="Coverage" skin={props.skin} status={result.status}><MetaGrid skin={props.skin} entries={Object.entries(result.metrics ?? {})} />{result.raw ? <ContentPane title="Bounded diagnostics" skin={props.skin} lines={String(result.raw).split(/\r?\n/)} limit={12} /> : null}</InspectorCard></>
    if (statusPending(status())) return <InspectorCard title={planReady() ? `${label()} plan` : `Preparing ${label().toLowerCase()}`} skin={props.skin} status={status()} pending meta={planReady() ? "input ready" : "input pending"}>{planReady() ? <MetaGrid skin={props.skin} entries={[["base directory", props.input?.base_dir], ["file pattern", props.input?.file_pattern], ["query", props.input?.query]]} /> : <text fg={props.skin.muted}>Waiting for OpenCode to attach the validated discovery input.</text>}</InspectorCard>
    if (lifecycle().phase === "error") return <InspectorUnavailable skin={props.skin} message={lifecycle().error} />
    return <InspectorDegraded skin={props.skin} message={`The completed ${props.tool} response was bounded before its structured discovery report.`} />
  }
  return <Activity evidence={props.output} label={label()} summary={summary().slice(0, 120)} meta={statusLabel(status())} status={status()} pending={statusPending(status())} skin={props.skin} preview={items().length ? <PreviewList skin={props.skin} items={items()} /> : null} details={details} />
}
