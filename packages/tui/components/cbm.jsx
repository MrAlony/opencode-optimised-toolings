/** @jsxImportSource @opentui/solid */
import { createMemo } from "solid-js"
import { parseCbm } from "../lib/inspect.js"
import { Activity, ContentPane, InspectorCard, lifecycleOf, OutcomeOverview, PreviewList, RawEvidence, resolvedStatus, Section, statusLabel } from "./kit.jsx"

function sectionStatus(name) { if (/FAILED|INCONSISTENT/i.test(name)) return "FAILED"; if (/READINESS|FRESHNESS|ARCHITECTURE|SUMMARY|RESULT|SOURCE|CHAIN/i.test(name)) return "SUCCESS"; return "PARTIAL SUCCESS" }
function labelFor(tool) { return tool.replace("alonix-index-", "index ") }

export function CbmView(props) {
  const parsed = createMemo(() => parseCbm(props.output ?? ""))
  const lifecycle = createMemo(() => lifecycleOf(props.part))
  const status = createMemo(() => resolvedStatus(props.part, parsed()?.status))
  const sections = createMemo(() => parsed()?.sections?.map((name) => ({ status: sectionStatus(name), label: name.toLowerCase(), meta: "evidence" })) ?? [])
  const summary = createMemo(() => lifecycle().phase === "completed" ? parsed()?.summary ?? `${props.tool} completed` : `${labelFor(props.tool)} · ${props.input?.project ?? props.input?.action ?? "working"}`)
  const details = () => parsed() ? <><OutcomeOverview skin={props.skin} status={parsed().status} summary={parsed().summary} facts={[["evidence sections", sections().length], ["strong sections", sections().filter((item) => item.status === "SUCCESS").length], ["partial sections", sections().filter((item) => item.status === "PARTIAL SUCCESS").length], ["failed sections", sections().filter((item) => item.status === "FAILED").length]]} meaning={parsed().status === "SUCCESS" ? ["The indexed evidence is ready to use; start with the highest-priority source or call chain below."] : ["Some indexed evidence is incomplete or failed verification.", "Use successful sections, but do not infer facts from missing or inconsistent sections."]} /><Section title="Evidence in recommended reading order" skin={props.skin}>{parsed().sectionBodies.map((section, index) => <InspectorCard title={`${index + 1}. ${section.name}`} skin={props.skin} status={sectionStatus(section.name)} meta="indexed evidence" subtitle={index === 0 ? "Start here." : null}><ContentPane skin={props.skin} lines={section.body.split(/\r?\n/)} limit={sectionStatus(section.name) === "SUCCESS" ? 20 : 14} tail={false} /></InspectorCard>)}</Section>{parsed().sectionBodies.length ? null : <RawEvidence skin={props.skin} text={parsed().raw} limit={36} tail={false} />}</> : <RawEvidence skin={props.skin} text={lifecycle().error || props.output} />
  return <Activity label={labelFor(props.tool)} summary={summary()} meta={statusLabel(status(), lifecycle())} status={status()} pending={lifecycle().pending} skin={props.skin} preview={sections().length ? <PreviewList skin={props.skin} items={sections()} /> : null} details={details} />
}
