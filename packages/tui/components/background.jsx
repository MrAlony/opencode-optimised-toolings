/** @jsxImportSource @opentui/solid */
import { parseOperations } from "../lib/background.js"
import { Activity, DetailLines, MetaGrid } from "./kit.jsx"
import { ReportView } from "./report.jsx"

function operationStatus(op) {
  if (/FAILED|ERROR/i.test(op.headline)) return "FAILED"
  if (/RUNNING|STARTING|PENDING/i.test(op.headline)) return "PARTIAL SUCCESS"
  if (/READY|STARTED|COMPLETED|REMOVED|STOPPED/i.test(op.headline)) return "SUCCESS"
  return "PARTIAL SUCCESS"
}

export function BackgroundView(props) {
  const skin = props.skin
  const text = String(props.output ?? "").trim()
  const ops = parseOperations(text)
  if (!ops.length) return <ReportView {...props} />
  const failures = ops.filter((op) => operationStatus(op) === "FAILED").length
  const status = failures ? "PARTIAL SUCCESS" : "SUCCESS"
  const summary = text.match(/^WHAT HAPPENED: (.+)$/m)?.[1] ?? `Processed ${ops.length} background operation${ops.length === 1 ? "" : "s"}`
  return (
    <Activity label="process" summary={summary.slice(0, 120)} meta={`${ops.length} op${ops.length === 1 ? "" : "s"}${failures ? ` · ${failures} failed` : ""}`} status={status} skin={skin}>
      {ops.slice(0, 10).map((op) => (
        <Activity label={`#${op.num}`} summary={op.label} meta={op.headline.slice(0, 36)} status={operationStatus(op)} skin={skin}>
          <MetaGrid skin={skin} entries={op.kv} />
          <DetailLines skin={skin} lines={op.body} limit={8} />
        </Activity>
      ))}
    </Activity>
  )
}
