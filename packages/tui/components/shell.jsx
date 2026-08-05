/** @jsxImportSource @opentui/solid */
import { parseShellCommands } from "../lib/shell.js"
import { Badge, displayPath, Expandable, MetaLine, StatusGlyph } from "./kit.jsx"
import { highlightParts } from "./report.jsx"

export function ShellView(props) {
  const skin = props.skin
  const text = String(props.output ?? "").trim()
  const status = /^TERMINAL RESULT: (SUCCESS|PARTIAL SUCCESS|FAILED)$/m.test(text)
    ? text.match(/^TERMINAL RESULT: (\w+ ?\w*)$/m)[1]
    : "SUCCESS"
  const borderColor = status === "SUCCESS" ? skin.success : status === "FAILED" ? skin.error : skin.accent
  const meaning = text.match(/^WHAT HAPPENED: (.+)$/m)?.[1] ?? ""
  const commands = parseShellCommands(text)
  if (!commands.length) {
    const lines = text.split("\n").slice(-30)
    return (
      <box border borderColor={borderColor} paddingLeft={1} paddingRight={1} paddingBottom={1} flexDirection="column" gap={1}>
        <box flexDirection="row" gap={1}>
          <StatusGlyph status={status} skin={skin} />
          <text fg={skin.text}><b>shell</b></text>
          <Badge text={status} color={borderColor} skin={skin} />
        </box>
        <MetaLine skin={skin}>{meaning}</MetaLine>
        {lines.map((line) => <text fg={skin.text}>{line.slice(0, 220)}</text>)}
      </box>
    )
  }
  return (
    <box border borderColor={borderColor} paddingTop={0} paddingBottom={1} paddingLeft={1} paddingRight={1} flexDirection="column" gap={1}>
      <box flexDirection="row" gap={1}>
        <StatusGlyph status={status} skin={skin} />
        <text fg={skin.text}><b>shell</b> <span style={{ fg: skin.muted }}>{commands.length} command{commands.length === 1 ? "" : "s"}</span></text>
        <Badge text={status} color={borderColor} skin={skin} />
      </box>
      <MetaLine skin={skin}>{meaning}</MetaLine>
      {commands.map((command) => (
        <Expandable
          skin={skin}
          header={
            <box flexDirection="row" gap={1}>
              <text fg={skin.accent}><b>CMD {command.num}</b></text>
              <text fg={skin.text}>{displayPath(command.label, 48)}</text>
              <Badge
                text={command.exit === 0 ? "exit 0" : command.exit == null ? "running" : `exit ${command.exit}`}
                color={command.exit === 0 ? skin.success : command.exit == null ? skin.accent : skin.error}
                skin={skin}
              />
              {command.duration ? <text fg={skin.muted}>{command.duration}</text> : null}
            </box>
          }
        >
          <box paddingLeft={2} flexDirection="column" gap={0}>
            {command.command ? <text fg={skin.text}><span style={{ fg: skin.muted }}>$ </span>{highlightParts(command.command, skin)}</text> : null}
            {command.meaning ? <text fg={skin.text}>{highlightParts(command.meaning, skin)}</text> : null}
            {command.workdir ? <text fg={skin.muted}>in {displayPath(command.workdir, 60)}</text> : null}
            {command.body.length ? (
              <box flexDirection="column" gap={0}>
                {command.body.slice(-40).map((line, index) => <text key={index} fg={skin.text}>{highlightParts(line, skin)}</text>)}
              </box>
            ) : null}
            {command.technical.slice(-6).map((line, index) => <text key={index} fg={skin.muted}>{String(line).slice(0, 200)}</text>)}
          </box>
        </Expandable>
      ))}
    </box>
  )
}
