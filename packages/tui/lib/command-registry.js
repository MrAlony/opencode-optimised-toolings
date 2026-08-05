// Unified action model for the Alonix palette.
//
// One search surface spans sessions, projects, and commands. Prefixes narrow
// the scope explicitly, matching the muscle memory of editor palettes:
//
//   >  commands      @  sessions      #  projects      (none) everything
//
// Ranking is pure so relevance behaviour is verifiable and stable.

import { fuzzyMatch } from "./sessions.js"

export const MODES = {
  all: { prefix: "", label: "Everything", hint: "sessions, projects and actions" },
  command: { prefix: ">", label: "Commands", hint: "run an action" },
  session: { prefix: "@", label: "Sessions", hint: "jump to a session" },
  project: { prefix: "#", label: "Projects", hint: "switch project" },
}

/** Split a raw query into its mode and search term. */
export function parseQuery(raw) {
  const text = String(raw ?? "")
  for (const [mode, config] of Object.entries(MODES)) {
    if (!config.prefix) continue
    if (text.startsWith(config.prefix)) {
      return { mode, prefix: config.prefix, term: text.slice(config.prefix.length).trim() }
    }
  }
  return { mode: "all", prefix: "", term: text.trim() }
}

const KIND_WEIGHT = { session: 3, project: 2, command: 1 }

/**
 * Build the ranked candidate list.
 *
 * Scoring blends three signals: text-match quality, an intrinsic kind weight so
 * sessions surface first on an empty query, and recency/priority boosts. When
 * there is no search term the list stays in a stable, meaningful default order
 * rather than an arbitrary one.
 */
export function buildActions(input = {}) {
  const { mode, term } = parseQuery(input.query)
  const now = Number(input.now) || Date.now()
  const items = []

  if (mode === "all" || mode === "session") {
    for (const session of Array.from(input.sessions ?? [])) {
      items.push({
        kind: "session",
        id: `session:${session.id}`,
        targetID: session.id,
        title: session.title,
        subtitle: session.projectName || session.directory || "",
        meta: session.relative,
        running: session.running === true,
        active: session.active === true,
        updated: Number(session.updated) || 0,
        changedFiles: Number(session.changedFiles) || 0,
        session,
      })
    }
  }

  if (mode === "all" || mode === "project") {
    for (const project of Array.from(input.projects ?? [])) {
      items.push({
        kind: "project",
        id: `project:${project.id}`,
        targetID: project.id,
        title: project.name,
        subtitle: project.worktree,
        meta: project.sessionCount ? `${project.sessionCount} sessions` : "no sessions",
        running: (project.running ?? 0) > 0,
        active: project.current === true,
        updated: Number(project.updated) || 0,
        changedFiles: Number(project.changedFiles) || 0,
        project,
      })
    }
  }

  if (mode === "all" || mode === "command") {
    for (const command of Array.from(input.commands ?? [])) {
      if (command?.enabled === false) continue
      items.push({
        kind: "command",
        id: `command:${command.name}`,
        targetID: command.name,
        title: command.title,
        subtitle: command.category ?? "",
        meta: command.hint ?? "",
        priority: Number(command.priority) || 0,
        run: command.run,
        command,
      })
    }
  }

  const scored = []
  for (const item of items) {
    let score = 0
    let positions = []
    if (term) {
      const title = fuzzyMatch(item.title, term)
      const subtitle = item.subtitle ? fuzzyMatch(item.subtitle, term) : null
      if (!title && !subtitle) continue
      // A subtitle hit is real but weaker than a title hit.
      score = Math.max(title?.score ?? 0, (subtitle?.score ?? 0) * 0.55)
      positions = title?.positions ?? []
    }

    // Kind weight only breaks ties on an empty query; a strong text match must
    // always outrank an intrinsically-preferred but poorly-matching item.
    score += (KIND_WEIGHT[item.kind] ?? 0) * (term ? 1 : 40)
    if (item.active) score += term ? 15 : 260
    if (item.running) score += term ? 12 : 180
    if (item.changedFiles > 0) score += term ? 4 : 45
    score += Number(item.priority ?? 0) * (term ? 3 : 30)
    // Recency, saturating over a week so old items still rank by relevance.
    if (item.updated > 0) {
      const ageDays = Math.max(0, (now - item.updated) / 86_400_000)
      score += Math.max(0, 60 - Math.min(60, ageDays * 8.5))
    }

    scored.push({ ...item, score, positions })
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    if (b.updated !== a.updated) return b.updated - a.updated
    return String(a.title).localeCompare(String(b.title))
  })

  return scored.map((item, index) => ({ ...item, slot: index < 9 ? index + 1 : null }))
}

/** Group ranked actions by kind for display, preserving relevance order. */
export function groupActions(actions) {
  const order = ["session", "project", "command"]
  const labels = { session: "Sessions", project: "Projects", command: "Actions" }
  const groups = []
  for (const kind of order) {
    const rows = Array.from(actions ?? []).filter((action) => action.kind === kind)
    if (rows.length) groups.push({ kind, label: labels[kind], rows })
  }
  return groups
}

/**
 * The workbench command set.
 *
 * Declared as data so the palette, help surface, and keybinding layer all stay
 * consistent from one source. `run` receives the workbench controller.
 */
export function workbenchCommands(context = {}) {
  const hasSession = Boolean(context.activeSessionID)
  const tabCount = Number(context.tabCount) || 0
  return [
    {
      name: "alonix.session.new",
      title: "New session in current project",
      category: "Session",
      priority: 5,
      hint: "ctrl+n",
      run: (api) => api.newSession?.(),
    },
    {
      name: "alonix.session.new.project",
      title: "New session in another project…",
      category: "Session",
      priority: 3,
      run: (api) => api.chooseProjectForNewSession?.(),
    },
    {
      name: "alonix.tab.close",
      title: "Close current tab",
      category: "Workbench",
      enabled: tabCount > 0,
      hint: "ctrl+w",
      run: (api) => api.closeActiveTab?.(),
    },
    {
      name: "alonix.tab.pin",
      title: "Pin or unpin current tab",
      category: "Workbench",
      enabled: tabCount > 0,
      run: (api) => api.togglePinActiveTab?.(),
    },
    {
      name: "alonix.tab.closeOthers",
      title: "Close other tabs",
      category: "Workbench",
      enabled: tabCount > 1,
      run: (api) => api.closeOtherTabs?.(),
    },
    {
      name: "alonix.workbench.open",
      title: "Open the workbench",
      category: "Workbench",
      priority: 4,
      run: (api) => api.openWorkbench?.(),
    },
    {
      name: "alonix.session.open",
      title: "Return to the session view",
      category: "Workbench",
      enabled: hasSession,
      run: (api) => api.openActiveSession?.(),
    },
    {
      name: "alonix.project.refresh",
      title: "Refresh projects and sessions",
      category: "Workbench",
      run: (api) => api.refresh?.(),
    },
  ]
}
