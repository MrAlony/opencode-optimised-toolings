/** @jsxImportSource @opentui/solid */
import { parseShellCommands } from "../lib/shell.js"
import { Activity, DetailLines, displayPath, MetaGrid } from "./kit.jsx"

export function ShellView(props) {
  const skin = props.skin
  const text = String(props.output ?? "").trim()
  const status = text.match(/^TERMINAL RESULT: (SUCCESS|PARTIAL SUCCESS|FAILED)$/m)?.[1] ?? (text ? "PARTIAL SUCCESS" : "PARTIAL SUCCESS")
  const meaning = text.match(/^WHAT HAPPENED: (.+)$/m)?.[1] ?? "Running terminal command"
  const commands = parseShellCommands(text)
  const failed = commands.filter((command) => command.exit != null && command.exit !== 0).length
  const running = commands.filter((command) => command.exit == null).length
  const meta = commands.length ? `${commands.length} cmd${commands.length === 1 ? "" : "s"}${failed ? ` · ${failed} failed` : running ? ` · ${running} running` : ""}` : status === "SUCCESS" ? "done" : ""
  return (
    <Activity label="shell" summary={meaning.slice(0, 120)} meta={meta} status={status} skin={skin} pending={!text}>
      {commands.length ? commands.slice(0, 8).map((command) => (
        <Activity
          label={command.exit === 0 ? "✓" : command.exit == null ? "◌" : "✕"}
          summary={displayPath(command.label || command.command, 72)}
          meta={command.duration || (command.exit == null ? "running" : `exit ${command.exit}`)}
          status={command.exit === 0 ? "SUCCESS" : command.exit == null ? "PARTIAL SUCCESS" : "FAILED"}
          skin={skin}
        >
          <MetaGrid skin={skin} entries={[["command", command.command], ["directory", displayPath(command.workdir, 90)], ["result", command.meaning]]} />
          <DetailLines skin={skin} lines={command.body} limit={10} color={skin.text} />
        </Activity>
      )) : <DetailLines skin={skin} lines={text.split(/\r?\n/)} limit={12} />}
    </Activity>
  )
}
