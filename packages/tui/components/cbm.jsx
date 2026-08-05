/** @jsxImportSource @opentui/solid */
import { createMemo } from "solid-js"
import { parseCbm } from "../lib/inspect.js"
import { Activity, DetailLines, lifecycleOf, PreviewList, RawEvidence, resolvedStatus, Section, statusLabel } from "./kit.jsx"

export function CbmView(props) {
  const parsed = createMemo(() => parseCbm(props.output ?? ""))
  const lifecycle = createMemo(() => lifecycleOf(props.part))
  const status = createMemo(() => resolvedStatus(props.part, parsed()?.status))
  const sections = createMemo(() => parsed()?.sections?.map((name) => ({ status: /FAILED|INCONSISTENT/i.test(name) ? "FAILED" : /READINESS|FRESHNESS|ARCHITECTURE|SUMMARY|RESULT|SOURCE|CHAIN/i.test(name) ? "SUCCESS" : "PARTIAL SUCCESS", label: name.toLowerCase(), meta: "evidence" })) ?? [])
  const summary = createMemo(() => lifecycle().phase === "completed" ? parsed()?.summary ?? `${props.tool} completed` : `${props.tool.replace("cbm_", "CBM ")} · ${props.input?.project ?? props.input?.action ?? "working"}`)
  return <Activity label={props.tool.replace("cbm_", "CBM ")} summary={summary()} meta={statusLabel(status(), lifecycle())} status={status()} pending={lifecycle().pending} skin={props.skin} preview={sections().length ? <PreviewList skin={props.skin} items={sections()} /> : null} details={() => parsed() ? <><Section title="Evidence map" skin={props.skin}><PreviewList skin={props.skin} items={sections()} limit={12} /></Section>{parsed().sectionBodies.map((section) => <Section title={section.name} skin={props.skin}><DetailLines skin={props.skin} lines={section.body.split(/\r?\n/)} limit={16} color={props.skin.text} tail={false} /></Section>)}{parsed().sectionBodies.length ? null : <RawEvidence skin={props.skin} text={parsed().raw} limit={40} tail={false} />}</> : <RawEvidence skin={props.skin} text={lifecycle().error || props.output} />} />
}
