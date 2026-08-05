/** @jsxImportSource @opentui/solid */
import { createMemo } from "solid-js"
import { parseCbm } from "../lib/inspect.js"
import { Activity, ContentPane, InspectorCard, lifecycleOf, PreviewList, RawEvidence, resolvedStatus, statusLabel } from "./kit.jsx"

function sectionStatus(name) {
  if (/FAILED|INCONSISTENT/i.test(name)) return "FAILED"
  if (/READINESS|FRESHNESS|ARCHITECTURE|SUMMARY|RESULT|SOURCE|CHAIN/i.test(name)) return "SUCCESS"
  return "PARTIAL SUCCESS"
}

export function CbmView(props) {
  const parsed = createMemo(() => parseCbm(props.output ?? ""))
  const lifecycle = createMemo(() => lifecycleOf(props.part))
  const status = createMemo(() => resolvedStatus(props.part, parsed()?.status))
  const sections = createMemo(() => parsed()?.sections?.map((name) => ({ status: sectionStatus(name), label: name.toLowerCase(), meta: "evidence" })) ?? [])
  const summary = createMemo(() => lifecycle().phase === "completed" ? parsed()?.summary ?? `${props.tool} completed` : `${props.tool.replace("cbm_", "CBM ")} · ${props.input?.project ?? props.input?.action ?? "working"}`)
  return <Activity label={props.tool.replace("cbm_", "CBM ")} summary={summary()} meta={statusLabel(status(), lifecycle())} status={status()} pending={lifecycle().pending} skin={props.skin} preview={sections().length ? <PreviewList skin={props.skin} items={sections()} /> : null} details={() => parsed() ? <><InspectorCard title="Evidence map" skin={props.skin} status={parsed().status} meta={`${sections().length} sections`}><PreviewList skin={props.skin} items={sections()} limit={12} /></InspectorCard>{parsed().sectionBodies.map((section, index) => <InspectorCard title={`${index + 1}. ${section.name}`} skin={props.skin} status={sectionStatus(section.name)} meta="indexed evidence"><ContentPane skin={props.skin} lines={section.body.split(/\r?\n/)} limit={18} tail={false} /></InspectorCard>)}{parsed().sectionBodies.length ? null : <RawEvidence skin={props.skin} text={parsed().raw} limit={40} tail={false} />}</> : <RawEvidence skin={props.skin} text={lifecycle().error || props.output} />} />
}
