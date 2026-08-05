/** @jsxImportSource @opentui/solid */
import { createMemo } from "solid-js"
import { inputPlanAvailable } from "../lib/batch.js"
import { parseCbm } from "../lib/inspect.js"
import { Activity, ContentPane, InspectorCard, InspectorDegraded, InspectorUnavailable, lifecycleOf, OutcomeOverview, PreviewList, resolvedStatus, Section, statusLabel, statusPending } from "./kit.jsx"
function sectionStatus(name) { if (/FAILED|INCONSISTENT/i.test(name)) return "FAILED"; if (/READINESS|FRESHNESS|ARCHITECTURE|SUMMARY|RESULT|SOURCE|CHAIN/i.test(name)) return "SUCCESS"; return "PARTIAL SUCCESS" }
function labelFor(tool) { if (tool === "alonix-index-project") return "Index project"; if (tool === "alonix-index-context") return "Index context"; if (tool === "alonix-index-investigate") return "Index investigate"; return "Index memory" }
export function CbmView(props) {
  const parsed = createMemo(() => parseCbm(props.output ?? ""))
  const lifecycle = createMemo(() => lifecycleOf(props.part))
  const status = createMemo(() => resolvedStatus(props.part, parsed()?.status))
  const planReady = createMemo(() => inputPlanAvailable(props.tool, props.input))
  const sections = createMemo(() => parsed()?.sections?.map((name) => ({ status: sectionStatus(name), label: name.toLowerCase(), meta: "evidence" })) ?? [])
  const summary = createMemo(() => parsed()?.summary ?? (planReady() ? String(props.input?.project ?? props.input?.action) : "index input pending"))
  const details = () => {
    const result = parsed()
    if (result) return <><OutcomeOverview skin={props.skin} status={result.status} summary={result.summary} facts={[["evidence sections", sections().length], ["strong", sections().filter((item) => item.status === "SUCCESS").length], ["partial", sections().filter((item) => item.status === "PARTIAL SUCCESS").length], ["failed", sections().filter((item) => item.status === "FAILED").length]]} meaning={result.status === "SUCCESS" ? ["Indexed evidence is ready; begin with priority source or call-chain sections."] : ["Use successful sections, but do not infer facts from missing or inconsistent evidence."]} /><Section title="Evidence in reading order" skin={props.skin}>{result.sectionBodies.map((section, index) => <InspectorCard title={`${index + 1}. ${section.name}`} skin={props.skin} status={sectionStatus(section.name)} meta="indexed evidence"><ContentPane skin={props.skin} lines={section.body.split(/\r?\n/)} limit={sectionStatus(section.name) === "SUCCESS" ? 20 : 14} tail={false} /></InspectorCard>)}</Section>{result.sectionBodies.length ? null : <InspectorDegraded skin={props.skin} message="The CBM response was classified, but bounded output contained no named evidence sections." />}</>
    if (statusPending(status())) return <InspectorCard title={planReady() ? `${labelFor(props.tool)} plan` : `Preparing ${labelFor(props.tool).toLowerCase()}`} skin={props.skin} status={status()} pending meta={planReady() ? "input ready" : "input pending"}><text fg={props.skin.muted}>{planReady() ? summary() : "Waiting for OpenCode to attach the validated index request."}</text></InspectorCard>
    if (lifecycle().phase === "error") return <InspectorUnavailable skin={props.skin} message={lifecycle().error} />
    return <InspectorDegraded skin={props.skin} message={`The completed ${props.tool} response was bounded before indexed evidence could be classified.`} />
  }
  return <Activity label={labelFor(props.tool)} summary={summary().slice(0, 120)} meta={statusLabel(status())} status={status()} pending={statusPending(status())} skin={props.skin} preview={sections().length ? <PreviewList skin={props.skin} items={sections()} /> : null} details={details} />
}
