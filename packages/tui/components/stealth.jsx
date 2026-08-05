/** @jsxImportSource @opentui/solid */
import { createMemo } from "solid-js"
import { inputItems, parseStealth } from "../lib/inspect.js"
import { Activity, DetailLines, lifecycleOf, MetaGrid, PreviewList, RawEvidence, resolvedStatus, Section, statusLabel } from "./kit.jsx"

function statusResult(text, tool) {
  if (!text) return null
  if (tool === "stealth_status") {
    const ready = /^STEALTH STATUS: READY$/m.test(text)
    return { status: ready ? "SUCCESS" : "PARTIAL SUCCESS", summary: ready ? "Managed Tor and worker boundary ready" : "Managed stealth boundary is not ready" }
  }
  if (tool === "stealth_rotate_tor") {
    const value = text.match(/^STEALTH TOR ROTATION: (SUCCESS|PARTIAL SUCCESS|FAILED)$/m)?.[1]
    return { status: value ?? (/FAILED|Error/i.test(text) ? "FAILED" : "PARTIAL SUCCESS"), summary: value === "SUCCESS" ? "Tor circuit rotation completed" : value === "FAILED" ? "Tor circuit rotation failed" : "Tor circuit rotation returned a partial result" }
  }
  return null
}

export function StealthView(props) {
  const parsed = createMemo(() => parseStealth(props.output ?? ""))
  const simple = createMemo(() => statusResult(props.output ?? "", props.tool))
  const lifecycle = createMemo(() => lifecycleOf(props.part))
  const resultStatus = createMemo(() => parsed()?.status ?? simple()?.status ?? (/FAILED|Error/i.test(props.output ?? "") ? "FAILED" : "PARTIAL SUCCESS"))
  const status = createMemo(() => resolvedStatus(props.part, resultStatus()))
  const items = createMemo(() => parsed()?.items?.map((item) => ({ status: item.status, label: item.titleText || item.title, meta: item.http || item.outcome })) ?? inputItems(props.tool, props.input))
  const summary = createMemo(() => lifecycle().phase === "completed" ? parsed()?.summary ?? simple()?.summary ?? (props.tool === "stealth_rotate_tor" ? "Tor circuit rotation completed" : `${props.tool} completed`) : props.tool === "stealth_rotate_tor" ? "Rotating Tor circuit" : props.tool === "stealth_status" ? "Checking managed stealth boundary" : `Processing ${items().length} item${items().length === 1 ? "" : "s"} through Tor`)
  return <Activity label={props.tool.replace("stealth_", "stealth ").replace("_many", "")} summary={summary()} meta={statusLabel(status(), lifecycle())} status={status()} pending={lifecycle().pending} skin={props.skin} preview={items().length ? <PreviewList skin={props.skin} items={items()} /> : null} details={() => parsed() ? <><Section title="Tor boundary" skin={props.skin}><text fg={props.skin.text}>{parsed().tor}</text></Section>{parsed().items.map((item) => <Section title={`Item ${item.number} · ${item.titleText || item.title}`} skin={props.skin} color={item.status === "FAILED" ? props.skin.error : props.skin.success}><MetaGrid skin={props.skin} entries={[["outcome", item.outcome], ["final URL", item.finalUrl], ["HTTP", item.http], ["completeness", item.completeness], ["error", item.error]]} /><DetailLines skin={props.skin} lines={item.content.split(/\r?\n/)} limit={16} color={props.skin.text} tail={false} /></Section>)}</> : <RawEvidence skin={props.skin} text={lifecycle().error || props.output} limit={32} />} />
}
