/** @jsxImportSource @opentui/solid */
import { createMemo } from "solid-js"
import { inputItems, parseStealth } from "../lib/inspect.js"
import { Activity, ContentPane, InspectorCard, lifecycleOf, MetaGrid, OutcomeOverview, PreviewList, RawEvidence, resolvedStatus, Section, statusLabel } from "./kit.jsx"

function statusResult(text, tool) {
  if (!text) return null
  if (tool === "alonix-stealth-status") { const ready = /^STEALTH STATUS: READY$/m.test(text); return { status: ready ? "SUCCESS" : "PARTIAL SUCCESS", summary: ready ? "Managed Tor and worker boundary ready" : "Managed stealth boundary is not ready" } }
  if (tool === "alonix-stealth-rotate-tor") { const value = text.match(/^STEALTH TOR ROTATION: (SUCCESS|PARTIAL SUCCESS|FAILED)$/m)?.[1]; return { status: value ?? (/FAILED|Error/i.test(text) ? "FAILED" : "PARTIAL SUCCESS"), summary: value === "SUCCESS" ? "Tor circuit rotation completed" : value === "FAILED" ? "Tor circuit rotation failed" : "Tor circuit rotation returned a partial result" } }
  return null
}

function labelFor(tool) { return tool.replace("alonix-stealth-", "stealth ").replace("-many", "") }

export function StealthView(props) {
  const parsed = createMemo(() => parseStealth(props.output ?? ""))
  const simple = createMemo(() => statusResult(props.output ?? "", props.tool))
  const lifecycle = createMemo(() => lifecycleOf(props.part))
  const resultStatus = createMemo(() => parsed()?.status ?? simple()?.status ?? (/FAILED|Error/i.test(props.output ?? "") ? "FAILED" : "PARTIAL SUCCESS"))
  const status = createMemo(() => resolvedStatus(props.part, resultStatus()))
  const items = createMemo(() => parsed()?.items?.map((item) => ({ status: item.status, label: item.titleText || item.title, meta: item.http || item.outcome })) ?? inputItems(props.tool, props.input))
  const summary = createMemo(() => lifecycle().phase === "completed" ? parsed()?.summary ?? simple()?.summary ?? `${labelFor(props.tool)} completed` : props.tool === "alonix-stealth-rotate-tor" ? "Rotating Tor circuit" : props.tool === "alonix-stealth-status" ? "Checking managed stealth boundary" : `Processing ${items().length} item${items().length === 1 ? "" : "s"} through Tor`)
  const details = () => parsed() ? <><OutcomeOverview skin={props.skin} status={parsed().status} summary={parsed().summary} facts={[["items", parsed().items.length], ["successful", parsed().items.filter((item) => item.status === "SUCCESS").length], ["failed", parsed().items.filter((item) => item.status === "FAILED").length], ["mode", parsed().kind]]} meaning={["Every item retains its own outcome; Tor readiness is shown separately from page or query success."]} /><InspectorCard title="Privacy boundary" skin={props.skin} status={parsed().status} meta="Tor"><text fg={props.skin.text}>{parsed().tor}</text></InspectorCard><Section title="Item results" skin={props.skin}>{parsed().items.map((item) => <InspectorCard title={`Item ${item.number} · ${item.titleText || item.title}`} skin={props.skin} status={item.status} meta={item.http || item.outcome} subtitle={item.status === "FAILED" ? item.error : item.finalUrl}>{item.content ? <ContentPane title="Useful evidence returned" skin={props.skin} lines={item.content.split(/\r?\n/)} limit={18} tail={false} /> : null}<MetaGrid skin={props.skin} entries={[["outcome", item.outcome], ["completeness", item.completeness], ["error", item.error]]} /></InspectorCard>)}</Section></> : <><OutcomeOverview skin={props.skin} status={simple()?.status ?? resultStatus()} summary={simple()?.summary ?? summary()} meaning={[props.tool === "alonix-stealth-status" ? "This checks readiness only; it does not fetch a page." : "Review the raw boundary response below."]} /><RawEvidence skin={props.skin} text={lifecycle().error || props.output} limit={28} tail={false} /></>
  return <Activity label={labelFor(props.tool)} summary={summary()} meta={statusLabel(status(), lifecycle())} status={status()} pending={lifecycle().pending} skin={props.skin} preview={items().length ? <PreviewList skin={props.skin} items={items()} /> : null} details={details} />
}
