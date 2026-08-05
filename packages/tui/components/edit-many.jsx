/** @jsxImportSource @opentui/solid */
import { parseEditResult } from "../lib/edit-many.js"
import { Badge, displayPath, Expandable, MetaGrid, MetaLine, SectionHeader, StatusGlyph } from "./kit.jsx"

export function EditManyView(props) {
  const skin = props.skin
  const parsed = parseEditResult(String(props.output ?? ""))
  if (!parsed) {
    const body = String(props.output ?? "").trim().split("\n").slice(-30)
    return (
      <box border borderColor={skin.border} paddingTop={0} paddingBottom={1} paddingLeft={1} paddingRight={1} flexDirection="column" gap={1}>
        <text fg={skin.accent}>
          <b>fs_edit_many</b>
        </text>
        {body.map((line) => (
          <text fg={skin.text}>{line}</text>
        ))}
      </box>
    )
  }
  const borderColor =
    parsed.status === "SUCCESS" ? skin.success : parsed.status === "FAILED" ? skin.error : skin.accent
  const summary = parsed.technicalSummary
  const counts = [
    parsed.applied.length ? `${parsed.applied.length} applied` : null,
    parsed.unchanged.length ? `${parsed.unchanged.length} unchanged` : null,
    parsed.rejected.length ? `${parsed.rejected.length} rejected` : null,
    summary["Requested actions"] ? `${summary["Requested actions"]} actions` : null,
  ]
    .filter(Boolean)
    .join(" · ")
  return (
    <box border borderColor={borderColor} paddingTop={0} paddingBottom={1} paddingLeft={1} paddingRight={1} flexDirection="column" gap={1}>
      <box flexDirection="row" gap={1}>
        <StatusGlyph status={parsed.status} skin={skin} />
        <text fg={skin.text}>
          <b>fs_edit_many</b>
        </text>
        <Badge text={parsed.status} color={parsed.status === "SUCCESS" ? skin.success : parsed.status === "FAILED" ? skin.error : skin.accent} skin={skin} />
      </box>
      <MetaLine skin={skin}>{counts}</MetaLine>
      <MetaLine skin={skin}>{String(parsed.outcome || "").slice(0, 160)}</MetaLine>
      {parsed.applied.length ? (
        <box flexDirection="column" gap={0}>
          <SectionHeader title={`Applied (${parsed.applied.length})`} skin={skin} color={skin.success} />
          {parsed.applied.map((file) => (
            <Expandable
              skin={skin}
              header={
                <box flexDirection="row" gap={1}>
                  <Badge
                    text={file.kind === "created" ? "created" : file.kind === "updated" ? "updated" : "no-op"}
                    color={file.kind === "created" ? skin.success : file.kind === "updated" ? skin.accent : skin.muted}
                    skin={skin}
                  />
                  <text fg={skin.text}>{displayPath(file.path)}</text>
                  {file.size ? <text fg={skin.muted}>{file.size}</text> : null}
                </box>
              }
            >
              <MetaGrid
                skin={skin}
                entries={[
                  ["actions", file.actions],
                  ["sha256", file.sha256],
                  ["equivalent paths", file.aliases ? file.aliases.join(", ") : null],
                  ...file.recovery.map((entry) => ["recovery", entry]),
                  ...file.noOps.map((entry) => ["no-op", entry]),
                ]}
              />
            </Expandable>
          ))}
        </box>
      ) : null}
      {parsed.unchanged.length ? (
        <box flexDirection="column" gap={0}>
          <SectionHeader title={`Unchanged (${parsed.unchanged.length})`} skin={skin} />
          {parsed.unchanged.map((file) => (
            <text fg={skin.muted}>{displayPath(file.path)}</text>
          ))}
        </box>
      ) : null}
      {parsed.rejected.length ? (
        <box flexDirection="column" gap={0}>
          <SectionHeader title={`Rejected (${parsed.rejected.length})`} skin={skin} color={skin.error} />
          {parsed.rejected.map((file) => (
            <Expandable
              skin={skin}
              header={
                <box flexDirection="row" gap={1}>
                  <Badge text="rejected" color={skin.error} skin={skin} />
                  <text fg={skin.error}>{displayPath(file.path)}</text>
                </box>
              }
            >
              <MetaGrid
                skin={skin}
                entries={[
                  ["failed step", file.failedStep],
                  ["expected", file.expected],
                  ["observed", file.observed],
                  ["safety outcome", file.safety],
                ]}
              />
            </Expandable>
          ))}
        </box>
      ) : null}
      {parsed.notes.length ? (
        <text fg={skin.muted}>{parsed.notes[0].split("\n").slice(0, 3).join(" · ").slice(0, 160)}</text>
      ) : null}
      {parsed.safetyModel ? <MetaLine skin={skin}>{String(parsed.safetyModel).slice(0, 140)}</MetaLine> : null}
    </box>
  )
}
