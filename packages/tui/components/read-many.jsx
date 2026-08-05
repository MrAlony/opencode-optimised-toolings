/** @jsxImportSource @opentui/solid */
import { parseReadResult } from "../lib/read-many.js"
import { Badge, displayPath, Expandable, MetaGrid, MetaLine, SectionHeader, StatusGlyph } from "./kit.jsx"

export function ReadManyView(props) {
  const skin = props.skin
  const parsed = parseReadResult(String(props.output ?? ""))
  if (!parsed) {
    const body = String(props.output ?? "").trim().split("\n").slice(-30)
    return (
      <box border borderColor={skin.border} paddingTop={0} paddingBottom={1} paddingLeft={1} paddingRight={1} flexDirection="column" gap={1}>
        <text fg={skin.accent}>
          <b>fs_read_many</b>
        </text>
        {body.map((line) => (
          <text fg={skin.text}>{line}</text>
        ))}
      </box>
    )
  }
  const counts = [
    parsed.files.length ? `${parsed.files.length} file${parsed.files.length === 1 ? "" : "s"}` : null,
    parsed.unavailable.length ? `${parsed.unavailable.length} unavailable` : null,
    parsed.omitted.length ? `${parsed.omitted.length} omitted` : null,
  ]
    .filter(Boolean)
    .join(" · ")
  const budget = parsed.budget["Complete-file evidence used"] && parsed.budget["Shared total"]
    ? ` · ${parsed.budget["Complete-file evidence used"]} / ${parsed.budget["Shared total"]} bytes`
    : ""
  return (
    <box
      border
      borderColor={parsed.status === "SUCCESS" ? skin.success : parsed.status === "FAILED" ? skin.error : skin.accent}
      paddingTop={0}
      paddingBottom={1}
      paddingLeft={1}
      paddingRight={1}
      flexDirection="column"
      gap={1}
    >
      <box flexDirection="row" gap={1}>
        <StatusGlyph status={parsed.status} skin={skin} />
        <text fg={skin.text}>
          <b>fs_read_many</b>
        </text>
        <Badge text={parsed.status} color={parsed.status === "SUCCESS" ? skin.success : parsed.status === "FAILED" ? skin.error : skin.accent} skin={skin} />
      </box>
      <MetaLine skin={skin}>
        {counts}
        {budget}
      </MetaLine>
      <MetaLine skin={skin}>{String(parsed.outcome || "").slice(0, 160)}</MetaLine>
      {parsed.files.map((file) => (
        <Expandable
          skin={skin}
          header={
            <box flexDirection="row" gap={1}>
              <Badge
                text={file.kind === "complete" ? (file.bounded ? "bounded" : "file") : file.kind}
                color={file.kind === "complete" && !file.bounded ? skin.success : skin.accent}
                skin={skin}
              />
              <text fg={skin.text}>{displayPath(file.path)}</text>
            </box>
          }
        >
          <MetaGrid
            skin={skin}
            entries={[
              ["encoding", file.encoding],
              ["rendered bytes", file.returnedRenderedBytes],
              ["source bytes", file.sourceBytes],
              ["ranged sections", file.ranges],
              ["sha256", file.sha256],
            ]}
          />
        </Expandable>
      ))}
      {parsed.unavailable.length ? (
        <box flexDirection="column" gap={0}>
          <SectionHeader title={`Unavailable (${parsed.unavailable.length})`} skin={skin} color={skin.error} />
          {parsed.unavailable.map((item) => (
            <text fg={skin.error}>
              {displayPath(item.path)} — {item.reason}
            </text>
          ))}
        </box>
      ) : null}
      {parsed.omitted.length ? (
        <box flexDirection="column" gap={0}>
          <SectionHeader title={`Omitted (${parsed.omitted.length})`} skin={skin} />
          {parsed.omitted.map((item) => (
            <text fg={skin.muted}>
              {item.lines ? `${displayPath(item.path)} omitted lines ${item.lines} (${item.bytes} bytes)` : displayPath(item.path)}
            </text>
          ))}
        </box>
      ) : null}
      {parsed.notes.length ? (
        <text fg={skin.muted}>{parsed.notes[0].split("\n").slice(0, 3).join(" · ").slice(0, 160)}</text>
      ) : null}
    </box>
  )
}
