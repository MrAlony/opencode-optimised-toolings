/** @jsxImportSource @opentui/solid */
import { parseReportBlocks, reportStatus, reportSummary } from "../lib/report.js"
import { Activity, DetailLines, MetaGrid } from "./kit.jsx"

export function highlightParts(text, skin) {
  const parts = String(text ?? "").split(/(PARTIAL SUCCESS|SUCCESS|READY|FAILED|ERROR|PASS\b|OK\b|yes\b|complete\b|running\b|stopped\b)/im)
  return parts.map((part) => {
    if (!part) return null
    const up = part.toUpperCase()
    if (["SUCCESS", "READY", "PASS", "OK", "YES"].includes(up)) return <span style={{ fg: skin.success }}><b>{part}</b></span>
    if (["FAILED", "ERROR"].includes(up)) return <span style={{ fg: skin.error }}><b>{part}</b></span>
    if (["PARTIAL SUCCESS", "COMPLETE", "RUNNING"].includes(up)) return <span style={{ fg: skin.accent }}><b>{part}</b></span>
    return part
  })
}

export function ReportView(props) {
  const skin = props.skin
  const text = String(props.output ?? "").trim()
  const status = reportStatus(text, props.tool)
  const nodes = parseReportBlocks(text)
  const details = nodes.flatMap((node) => {
    if (node.type === "kv") return [[node.key, node.value]]
    if (node.type === "list") return node.items.map((item) => ["•", item])
    if (node.type === "section") return [[node.title, ""]]
    return node.lines.map((line) => ["", line])
  })
  return (
    <Activity
      label={props.tool}
      summary={reportSummary(text, props.tool)}
      meta={status === "SUCCESS" ? "done" : status === "FAILED" ? "failed" : "partial"}
      status={status}
      skin={skin}
      pending={!text}
    >
      {details.length ? <MetaGrid skin={skin} entries={details} limit={12} /> : <DetailLines skin={skin} lines={[text || "Waiting for output…"]} />}
    </Activity>
  )
}
