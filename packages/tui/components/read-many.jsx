/** @jsxImportSource @opentui/solid */
import { parseReadResult } from "../lib/read-many.js"
import { Activity, DetailLines, displayPath, MetaGrid } from "./kit.jsx"
import { ReportView } from "./report.jsx"

export function ReadManyView(props) {
  const skin = props.skin
  const parsed = parseReadResult(String(props.output ?? ""))
  if (!parsed) return <ReportView {...props} />
  const summary = parsed.outcome || `Read ${parsed.files.length} file${parsed.files.length === 1 ? "" : "s"}`
  const meta = [
    parsed.files.length && `${parsed.files.length} read`,
    parsed.unavailable.length && `${parsed.unavailable.length} missing`,
    parsed.omitted.length && `${parsed.omitted.length} bounded`,
  ].filter(Boolean).join(" · ")
  return (
    <Activity label="read" summary={summary.slice(0, 120)} meta={meta} status={parsed.status} skin={skin}>
      {parsed.files.slice(0, 10).map((file) => (
        <Activity
          label={file.bounded ? "◐" : "·"}
          summary={displayPath(file.path, 82)}
          meta={file.bounded ? "bounded" : file.kind}
          status={file.bounded ? "PARTIAL SUCCESS" : "SUCCESS"}
          skin={skin}
        >
          <MetaGrid skin={skin} entries={[["encoding", file.encoding], ["source", file.sourceBytes && `${file.sourceBytes} bytes`], ["returned", file.returnedRenderedBytes && `${file.returnedRenderedBytes} bytes`], ["ranges", file.ranges], ["sha256", file.sha256]]} />
        </Activity>
      ))}
      {parsed.unavailable.length ? <DetailLines skin={skin} color={skin.error} lines={parsed.unavailable.map((item) => `${displayPath(item.path)} — ${item.reason}`)} limit={8} /> : null}
      {parsed.omitted.length ? <DetailLines skin={skin} lines={parsed.omitted.map((item) => item.note || `${displayPath(item.path)} · omitted ${item.lines}`)} limit={6} /> : null}
    </Activity>
  )
}
