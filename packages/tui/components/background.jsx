/** @jsxImportSource @opentui/solid */
import { opColor, parseOperations } from "../lib/background.js"
import { Badge, Expandable, MetaLine, StatusGlyph } from "./kit.jsx"
import { highlightParts, ReportView } from "./report.jsx"

export function BackgroundView(props) {
  const skin = props.skin
  const text = String(props.output ?? "").trim()
  const ops = parseOperations(text)
  if (!ops.length) return <ReportView {...props} />
  return (
    <box border borderColor={skin.accent} paddingTop={0} paddingBottom={1} paddingLeft={1} paddingRight={1} flexDirection="column" gap={1}>
      <box flexDirection="row" gap={1}>
        <StatusGlyph status="PARTIAL SUCCESS" skin={skin} />
        <text fg={skin.text}><b>background_process</b> <span style={{ fg: skin.muted }}>{ops.length} operation{ops.length === 1 ? "" : "s"}</span></text>
      </box>
      <MetaLine skin={skin}>{text.match(/^WHAT HAPPENED: (.+)$/m)?.[1] ?? ""}</MetaLine>
      {ops.map((op) => (
        <Expandable
          key={op.num}
          skin={skin}
          header={
            <box flexDirection="row" gap={1}>
              <text fg={skin.accent}><b>{op.label}</b></text>
              {op.headline ? <Badge text={op.headline.slice(0, 32)} color={opColor(op.headline, skin)} skin={skin} /> : null}
              <text fg={skin.muted}>#{op.num}</text>
            </box>
          }
        >
          <box paddingLeft={2} flexDirection="column" gap={0}>
            {op.kv.map(([key, value], index) => (
              <text key={index} fg={skin.text}><span style={{ fg: skin.muted }}>{key}:</span> {highlightParts(value, skin)}</text>
            ))}
            {op.body.slice(0, 16).map((line, index) => <text key={index} fg={skin.text}>{highlightParts(line, skin)}</text>)}
          </box>
        </Expandable>
      ))}
    </box>
  )
}
