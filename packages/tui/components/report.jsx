/** @jsxImportSource @opentui/solid */
import { parseReportBlocks, reportStatus } from "../lib/report.js"
import { Badge, SectionHeader, StatusGlyph } from "./kit.jsx"

export function highlightParts(text, skin) {
  const parts = String(text ?? "").split(/(PARTIAL SUCCESS|SUCCESS|READY|FAILED|ERROR|PASS\b|OK\b|yes\b|complete\b|running\b|stopped\b)/im)
  return parts.map((part, index) => {
    if (!part) return null
    const up = part.toUpperCase()
    if (up === "SUCCESS" || up === "READY" || up === "PASS" || up === "OK" || up === "YES") {
      return <span style={{ fg: skin.success }}><b>{part}</b></span>
    }
    if (up === "FAILED" || up === "ERROR") {
      return <span style={{ fg: skin.error }}><b>{part}</b></span>
    }
    if (up === "PARTIAL SUCCESS" || up === "COMPLETE" || up === "RUNNING") {
      return <span style={{ fg: skin.accent }}><b>{part}</b></span>
    }
    return part
  })
}

function ToolBody({ skin, props }) {
  const text = String(props.output ?? "").trim()
  if (!text) {
    return <text fg={skin.muted}>no output</text>
  }
  const status = reportStatus(text, props.tool)
  const borderColor = status === "SUCCESS" ? skin.success : status === "FAILED" ? skin.error : skin.accent
  const nodes = parseReportBlocks(text)
  return (
    <box
      border
      borderColor={borderColor}
      paddingTop={0}
      paddingBottom={1}
      paddingLeft={1}
      paddingRight={1}
      flexDirection="column"
      gap={1}
    >
      <box flexDirection="row" gap={1}>
        <StatusGlyph status={status} skin={skin} />
        <text fg={skin.text}><b>{props.tool}</b></text>
        <Badge text={status} color={borderColor} skin={skin} />
      </box>
      {nodes.slice(-80).map((node) => {
        if (node.type === "section") {
          return <SectionHeader title={node.title} skin={skin} />
        }
        const pad = node.indented ? { paddingLeft: 2 } : {}
        if (node.type === "list") {
          return (
            <box flexDirection="column" gap={0} {...pad}>
              {node.items.slice(-24).map((item, index) => (
                <text key={index} fg={skin.text}><span style={{ fg: skin.muted }}>• </span>{highlightParts(item, skin)}</text>
              ))}
            </box>
          )
        }
        if (node.type === "kv") {
          return (
            <text fg={skin.text} {...pad}>
              <span style={{ fg: skin.accent }}>{node.key}:</span> {highlightParts(node.value, skin)}
            </text>
          )
        }
        return (
          <box flexDirection="column" gap={0} {...pad}>
            {node.lines.slice(-30).map((line, index) => (
              <text key={index} fg={skin.text}>{String(line).slice(0, 220)}</text>
            ))}
          </box>
        )
      })}
    </box>
  )
}

export function ReportView(props) {
  return <ToolBody skin={props.skin} props={props} />
}
