// Live agent activity.
//
// Turns the host's message/part state into a readable "what is the agent doing
// right now" feed. This is the surface a non-developer watches, so it favours
// plain language over protocol detail and never blocks on missing data.
//
// Pure functions: every input is supplied by the caller, so behaviour is fully
// verifiable without a running session.

/** Tool name -> human phrasing. Unknown tools fall back to the raw name. */
const TOOL_VERBS = {
  read: "Reading",
  write: "Writing",
  edit: "Editing",
  patch: "Editing",
  multiedit: "Editing",
  bash: "Running",
  shell: "Running",
  glob: "Searching",
  grep: "Searching",
  list: "Browsing",
  webfetch: "Fetching",
  websearch: "Searching the web",
  todowrite: "Planning",
  todoread: "Reviewing the plan",
  task: "Delegating",
  question: "Asking you",
}

const STATE_LABEL = {
  pending: "queued",
  running: "working",
  completed: "done",
  error: "failed",
}

function basename(value) {
  const text = String(value ?? "").replaceAll("\\", "/").replace(/\/+$/, "")
  if (!text) return ""
  return text.slice(text.lastIndexOf("/") + 1) || text
}

/** Short, human description of a single tool invocation. */
export function describeTool(name, input = {}) {
  const tool = String(name ?? "").toLowerCase()
  const verb = TOOL_VERBS[tool] ?? (tool ? tool : "Working")
  const args = input && typeof input === "object" ? input : {}

  const target =
    basename(args.filePath ?? args.path ?? args.file) ||
    (typeof args.pattern === "string" ? args.pattern : "") ||
    (typeof args.query === "string" ? args.query : "") ||
    (typeof args.command === "string" ? args.command.split(/\s+/)[0] : "") ||
    (typeof args.url === "string" ? args.url : "") ||
    (typeof args.description === "string" ? args.description : "")

  return target ? `${verb} ${target}` : verb
}

function partState(part) {
  const raw = part?.state?.status ?? part?.state ?? part?.status
  const text = String(raw ?? "").toLowerCase()
  if (text === "running" || text === "pending" || text === "completed" || text === "error") return text
  // A tool with output but no explicit status has finished.
  if (part?.state?.output !== undefined || part?.state?.time?.end) return "completed"
  return "pending"
}

function partTime(part) {
  const value = part?.state?.time?.start ?? part?.state?.time?.end ?? part?.time?.start ?? 0
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : 0
}

/**
 * Build the activity feed for a session, newest first.
 *
 * `getParts` is called per message id so the caller controls how host state is
 * reached; failures are contained and simply yield no parts for that message.
 */
export function sessionActivity(input = {}) {
  const messages = Array.from(input.messages ?? [])
  const getParts = typeof input.getParts === "function" ? input.getParts : () => []
  const limit = Math.max(1, Math.floor(Number(input.limit) || 8))

  const events = []
  let assistantText = ""
  let lastRole = ""

  // Walk from the newest message backwards; a bounded scan keeps this cheap
  // even for very long transcripts.
  const recent = messages.slice(-12)
  for (const message of recent) {
    if (!message?.id) continue
    lastRole = String(message.role ?? lastRole)
    let parts = []
    try {
      parts = Array.from(getParts(message.id) ?? [])
    } catch {
      parts = []
    }

    for (const part of parts) {
      const type = String(part?.type ?? "")
      if (type === "text" && message.role === "assistant") {
        const text = String(part?.text ?? "").trim()
        if (text) assistantText = text
        continue
      }
      if (type !== "tool" && type !== "tool-invocation") continue

      const name = part?.tool ?? part?.toolName ?? part?.name
      const args = part?.state?.input ?? part?.input ?? {}
      const state = partState(part)
      events.push({
        id: String(part?.id ?? `${message.id}:${events.length}`),
        tool: String(name ?? ""),
        label: describeTool(name, args),
        state,
        stateLabel: STATE_LABEL[state] ?? state,
        running: state === "running",
        failed: state === "error",
        time: partTime(part),
      })
    }
  }

  // Newest first, stable for equal timestamps.
  const ordered = events.slice().reverse()
  const running = ordered.filter((event) => event.running)

  return {
    events: ordered.slice(0, limit),
    running,
    runningCount: running.length,
    failedCount: ordered.filter((event) => event.failed).length,
    // The single line that answers "what is happening right now".
    headline: headlineFor({ running, events: ordered, assistantText, busy: input.busy === true, lastRole }),
    assistantText,
  }
}

function headlineFor({ running, events, assistantText, busy, lastRole }) {
  if (running.length === 1) return running[0].label
  if (running.length > 1) return `${running[0].label} +${running.length - 1} more`
  if (busy) {
    // Busy with no tool running means the model is composing a reply.
    return lastRole === "user" ? "Thinking" : "Responding"
  }
  const failed = events.find((event) => event.failed)
  if (failed) return `${failed.label} failed`
  if (assistantText) return firstLine(assistantText, 80)
  if (events.length) return "Waiting for you"
  return "Idle"
}

function firstLine(text, width) {
  const line = String(text ?? "").split(/\r?\n/).find((item) => item.trim()) ?? ""
  const trimmed = line.trim()
  if (trimmed.length <= width) return trimmed
  return `${trimmed.slice(0, Math.max(1, width - 1))}\u2026`
}

/**
 * Read live activity straight from the host TUI state.
 *
 * Every host call is guarded because plugin state is only populated for
 * sessions the host has synced; an unsynced session must degrade to "idle"
 * rather than throwing inside a render.
 */
export function liveActivity(api, sessionID, options = {}) {
  const empty = {
    events: [],
    running: [],
    runningCount: 0,
    failedCount: 0,
    headline: "Idle",
    assistantText: "",
    busy: false,
  }
  if (!api || !sessionID) return empty

  let messages = []
  try {
    messages = Array.from(api.state?.session?.messages?.(sessionID) ?? [])
  } catch {
    return empty
  }

  let busy = false
  try {
    const status = api.state?.session?.status?.(sessionID)
    const type = String(status?.type ?? "")
    busy = type === "busy" || type === "retry"
  } catch {
    busy = false
  }

  const activity = sessionActivity({
    messages,
    busy,
    limit: options.limit,
    getParts: (messageID) => api.state?.part?.(messageID) ?? [],
  })
  return { ...activity, busy }
}
