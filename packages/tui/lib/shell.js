function parseCommandBlock(block) {
  const item = { exit: null, duration: null, workdir: "", command: "", meaning: "", body: [], technical: [] }
  let mode = "meta"
  for (const raw of block.split(/\r?\n/)) {
    const exit = raw.match(/^Outcome: exit (-?\d+)/)
    if (exit) { item.exit = Number(exit[1]); continue }
    const duration = raw.match(/^Duration: ([\.\d]+ ?ms)/)
    if (duration) { item.duration = duration[1]; continue }
    if (raw.startsWith("Working directory: ")) { item.workdir = raw.slice("Working directory: ".length); continue }
    if (raw.startsWith("Command: ")) { item.command = raw.slice("Command: ".length); continue }
    if (raw.startsWith("Meaning: ")) { item.meaning = raw.slice("Meaning: ".length); continue }
    if (raw.startsWith("--- CAPTURED OUTPUT ---")) { mode = "body"; continue }
    if (raw.startsWith("--- TECHNICAL STATUS ---")) { mode = "tech"; continue }
    if (mode === "body") { if (raw.length) item.body.push(raw) }
    else if (mode === "tech" && raw.trim()) item.technical.push(raw)
  }
  return item
}

export function parseShellCommands(text) {
  const commands = []
  const re = /^=== COMMAND (\d+): (.*?) ===$/gm
  let match
  while ((match = re.exec(text))) {
    const start = re.lastIndex
    const next = text.indexOf("=== COMMAND", start)
    const end = next === -1 ? text.length : next
    const command = parseCommandBlock(text.slice(start, end))
    commands.push({ num: Number(match[1]), label: match[2], ...command })
  }
  return commands
}
