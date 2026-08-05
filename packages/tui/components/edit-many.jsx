/** @jsxImportSource @opentui/solid */
import { parseEditResult } from "../lib/edit-many.js"
import { Activity, DetailLines, displayPath, MetaGrid } from "./kit.jsx"
import { ReportView } from "./report.jsx"

function FileResult({ file, skin, rejected = false }) {
  const status = rejected ? "FAILED" : "SUCCESS"
  return (
    <Activity label={rejected ? "✕" : file.kind === "created" ? "+" : "~"} summary={displayPath(file.path, 82)} meta={rejected ? "rejected" : file.kind} status={status} skin={skin}>
      <MetaGrid skin={skin} entries={rejected
        ? [["failed step", file.failedStep], ["expected", file.expected], ["observed", file.observed], ["safety", file.safety]]
        : [["actions", file.actions], ["size", file.size], ["sha256", file.sha256], ["aliases", file.aliases?.join(", ")]]} />
      {!rejected ? <DetailLines skin={skin} lines={[...file.recovery, ...file.noOps]} limit={4} /> : null}
    </Activity>
  )
}

export function EditManyView(props) {
  const skin = props.skin
  const parsed = parseEditResult(String(props.output ?? ""))
  if (!parsed) return <ReportView {...props} />
  const meta = [parsed.applied.length && `${parsed.applied.length} changed`, parsed.unchanged.length && `${parsed.unchanged.length} unchanged`, parsed.rejected.length && `${parsed.rejected.length} rejected`].filter(Boolean).join(" · ")
  return (
    <Activity label="edit" summary={(parsed.outcome || "Applied filesystem transaction").slice(0, 120)} meta={meta} status={parsed.status} skin={skin} openDefault={parsed.rejected.length > 0}>
      {parsed.applied.slice(0, 10).map((file) => <FileResult file={file} skin={skin} />)}
      {parsed.unchanged.slice(0, 6).map((file) => <Activity label="=" summary={displayPath(file.path, 82)} meta="unchanged" status="SUCCESS" skin={skin} />)}
      {parsed.rejected.slice(0, 8).map((file) => <FileResult file={file} skin={skin} rejected />)}
      <DetailLines skin={skin} lines={parsed.readWriteRecovery} limit={4} />
    </Activity>
  )
}
