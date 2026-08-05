/** @jsxImportSource @opentui/solid */
import { createMemo } from "solid-js"
import { declaredCounts, inputPlanAvailable, pendingPlanSummary, reconcileBatch, visibleOutcome } from "../lib/batch.js"
import { inputItems, parseStealth } from "../lib/inspect.js"
import { Activity, ContentPane, InspectorCard, InspectorDegraded, InspectorUnavailable, lifecycleOf, MetaGrid, OutcomeOverview, PreviewList, resolvedStatus, Section, statusLabel, statusPending } from "./kit.jsx"
function statusResult(text, tool) {
  if (!text) return null
  if (tool === "alonix-stealth-status") { const ready = /^STEALTH STATUS: READY$/m.test(text); return { status: ready ? "SUCCESS" : "PARTIAL SUCCESS", summary: ready ? "Tor boundary ready" : "Tor boundary not ready", lines: String(text).split(/\r?\n/).filter(Boolean) } }
  if (tool === "alonix-stealth-rotate-tor") { const value = text.match(/^STEALTH TOR ROTATION: (SUCCESS|PARTIAL SUCCESS|FAILED)$/m)?.[1]; return { status: value ?? (/FAILED|Error/i.test(text) ? "FAILED" : "PARTIAL SUCCESS"), summary: value === "SUCCESS" ? "Circuit rotated" : value === "FAILED" ? "Rotation failed" : "Partial rotation result", lines: String(text).split(/\r?\n/).filter(Boolean) } }
  return null
}
function labelFor(tool) { if (tool === "alonix-stealth-fetch-many") return "Stealth fetch"; if (tool === "alonix-stealth-search-many") return "Stealth search"; if (tool === "alonix-stealth-rotate-tor") return "Tor rotate"; return "Stealth status" }
export function StealthView(props) {
  const parsed = createMemo(() => parseStealth(props.output ?? ""))
  const simple = createMemo(() => statusResult(props.output ?? "", props.tool))
  const lifecycle = createMemo(() => lifecycleOf(props.part))
  const resultStatus = createMemo(() => parsed()?.status ?? simple()?.status ?? null)
  const status = createMemo(() => resolvedStatus(props.part, resultStatus()))
  const plan = createMemo(() => inputItems(props.tool, props.input))
  const planReady = createMemo(() => inputPlanAvailable(props.tool, props.input))
  const batch = createMemo(() => reconcileBatch(plan(), parsed()?.items ?? [], { meta: (_requested, result) => result.http || result.outcome || result.meta }))
  const items = createMemo(() => batch().records)
  const counts = createMemo(() => declaredCounts(parsed()?.summary))
  const visible = createMemo(() => visibleOutcome(items()))
  const summary = createMemo(() => parsed() ? `${counts().succeeded ?? visible().succeeded}/${batch().plannedCount} items succeeded${batch().omitted.length ? ` · ${batch().omitted.length} details omitted` : ""}` : simple()?.summary ?? (props.tool === "alonix-stealth-status" ? "checking Tor readiness" : props.tool === "alonix-stealth-rotate-tor" ? "requesting a new Tor circuit" : pendingPlanSummary(planReady(), batch().plannedCount, "item")))
  const details = () => {
    const result = parsed()
    if (result) return <><OutcomeOverview skin={props.skin} status={result.status} summary={result.summary} facts={[["items requested", batch().plannedCount], ["successful (declared)", counts().succeeded], ["visible result blocks", batch().observedCount], ["omitted result blocks", batch().omitted.length], ["mode", result.kind]]} meaning={batch().omitted.length ? ["The original request plan remains authoritative even when bounded output omits item blocks."] : ["Tor/privacy readiness is separate from each page or query outcome."]} /><InspectorCard title="Privacy boundary" skin={props.skin} status={result.status} meta="Tor"><text fg={props.skin.text}>{result.tor}</text></InspectorCard><Section title="Item results" skin={props.skin}>{items().map((item) => item.detailAvailable ? <InspectorCard title={`${item.number}. ${item.titleText || item.title || item.label}`} skin={props.skin} status={item.status} meta={item.http || item.outcome} subtitle={item.status === "FAILED" ? item.error : item.finalUrl}>{item.content ? <ContentPane title="Returned evidence" skin={props.skin} lines={item.content.split(/\r?\n/)} limit={18} tail={false} /> : null}<MetaGrid skin={props.skin} entries={[["outcome", item.outcome], ["completeness", item.completeness], ["error", item.error]]} /></InspectorCard> : <InspectorDegraded skin={props.skin} title={`${item.number}. ${item.label}`} subtitle="This requested item was omitted from the bounded transcript output." />)}</Section></>
    if (simple()) return <><OutcomeOverview skin={props.skin} status={simple().status} summary={simple().summary} meaning={[props.tool === "alonix-stealth-status" ? "This checks readiness only; it does not fetch a page." : "The managed Tor boundary returned this rotation outcome."]} /><ContentPane title="Boundary details" skin={props.skin} lines={simple().lines} limit={12} tail={false} /></>
    if (statusPending(status())) return <InspectorCard title={planReady() ? `${labelFor(props.tool)} plan` : `Preparing ${labelFor(props.tool).toLowerCase()}`} skin={props.skin} status={status()} pending meta={planReady() && items().length ? `${items().length} item(s)` : "input pending"}>{items().length ? <PreviewList skin={props.skin} items={items()} limit={12} /> : <text fg={props.skin.muted}>{props.tool === "alonix-stealth-status" || props.tool === "alonix-stealth-rotate-tor" ? "Waiting for the managed Tor boundary response." : "Waiting for OpenCode to attach the validated request input."}</text>}</InspectorCard>
    if (lifecycle().phase === "error") return <InspectorUnavailable skin={props.skin} message={lifecycle().error} />
    return <InspectorDegraded skin={props.skin} items={items()} message="The completed response was bounded before its structured stealth report. The request plan remains intact." />
  }
  return <Activity evidence={props.output} label={labelFor(props.tool)} summary={summary()} meta={statusLabel(status())} status={status()} pending={statusPending(status())} skin={props.skin} preview={items().length ? <PreviewList skin={props.skin} items={items()} /> : null} details={details} />
}
