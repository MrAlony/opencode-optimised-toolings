// Pure real-time supervision model for Live Agents Mission Control.

import { healthIsVisible, sessionHealth, SESSION_STALL_MS } from "./session-health.js"

function rows(value) {
  return Array.from(value ?? []).filter((item) => item && typeof item === "object")
}

function number(value) {
  const result = Number(value)
  return Number.isFinite(result) ? result : 0
}

function fileName(item) {
  return String(item?.file ?? item?.path ?? "").trim().replaceAll("\\", "/")
}

export const MISSION_STALL_MS = SESSION_STALL_MS

const MISSION_DENSITIES = new Set(["cards", "compact", "table"])

/**
 * Geometry for the live-agent viewport.
 *
 * The monitor owns one cell of horizontal padding on each side. Capacity is
 * measured in agents, not visual rows: a three-column viewport with two rows
 * must mount six agents. Keeping this calculation pure prevents column-count
 * changes from silently hiding otherwise reachable agents.
 */
export function missionControlLayout(viewport = {}, requestedDensity = "cards") {
  const width = Math.max(1, Math.floor(Number(viewport.width) || 1))
  const height = Math.max(1, Math.floor(Number(viewport.height) || 1))
  const contentWidth = Math.max(1, width - 2)
  const density = MISSION_DENSITIES.has(requestedDensity) ? requestedDensity : "cards"
  const columns = density === "table" ? 1 : contentWidth >= 106 ? 3 : contentWidth >= 66 ? 2 : 1
  const rowHeight = density === "table" ? 1 : density === "compact" ? 6 : 10
  const measuredRows = Math.max(1, Math.floor(Math.max(1, height - 9) / rowHeight))
  // OpenCode route plugins can report a conservative terminal height while the
  // flex host gives the scrollbox substantially more room. Card modes keep two
  // virtual rows available so a three-column view never collapses four active
  // agents into a misleading single row; the scrollbox still clips and scrolls
  // genuinely short viewports.
  const visibleRows = density === "table" ? measuredRows : Math.max(2, measuredRows)
  const gap = columns > 1 ? 1 : 0
  const cardWidth = Math.max(1, Math.floor((contentWidth - gap * (columns - 1)) / columns))
  return {
    width,
    height,
    contentWidth,
    density,
    columns,
    rowHeight,
    visibleRows,
    capacity: visibleRows * columns,
    gap,
    cardWidth,
  }
}

export function missionScrollIndex(current, total, direction, step = 1) {
  const size = Math.max(0, Math.floor(Number(total) || 0))
  if (!size) return 0
  const index = Math.max(0, Math.min(size - 1, Math.floor(Number(current) || 0)))
  const amount = Math.max(1, Math.floor(Number(step) || 1))
  const text = String(direction ?? "").toLowerCase()
  const delta = ["up", "left", "-1"].includes(text) ? -amount : amount
  return Math.max(0, Math.min(size - 1, index + delta))
}

export function missionControlModel(input = {}) {
  const now = number(input.now) || Date.now()
  const filter = ["all", "attention", "errors", "working", "completed", "stalled", "collisions"].includes(input.filter) ? input.filter : "all"
  const project = String(input.project ?? "")
  const agents = rows(input.agents).map((agent) => {
    const updated = number(agent.updated)
    const age = Math.max(0, now - updated)
    const attention = number(agent.attention)
    const failed = number(agent.failedCount)
    const health = sessionHealth({
      activity: {
        busy: agent.busy,
        headline: agent.headline,
        runningCount: agent.runningCount,
        latestTool: agent.latestTool,
        latestToolFailed: agent.latestToolFailed,
        hydrated: agent.hydrated,
        progressAt: agent.progressAt,
        inFlight: agent.inFlight,
      },
      attention,
      running: agent.running,
      terminalState: agent.terminalState,
      completed: agent.completed,
      completedAt: agent.completedAt,
      now,
    })
    return {
      ...agent,
      updated,
      age,
      attention,
      failed,
      health,
      state: health.state,
      tone: health.tone,
      hasError: health.state === "error",
      stalled: health.state === "stalled",
      completed: health.state === "completed",
      needsAttention: health.state === "needs-input",
    }
  })

  const fileOwners = new Map()
  for (const agent of agents.filter((item) => item.running)) {
    for (const file of rows(agent.files)) {
      const name = fileName(file)
      if (!name) continue
      const key = process.platform === "win32" ? name.toLowerCase() : name
      const owners = fileOwners.get(key) ?? []
      if (!owners.includes(agent.id)) owners.push(agent.id)
      fileOwners.set(key, owners)
    }
  }
  const collisions = [...fileOwners.entries()]
    .filter(([, owners]) => owners.length > 1)
    .map(([file, owners]) => ({ file, owners }))
    .sort((a, b) => b.owners.length - a.owners.length || a.file.localeCompare(b.file))
  const collisionIDs = new Set(collisions.flatMap((collision) => collision.owners))
  const enriched = agents.map((agent) => ({ ...agent, collision: collisionIDs.has(agent.id) }))

  const filtered = enriched.filter((agent) => {
    if (project && agent.projectID !== project && agent.projectKey !== project) return false
    if (filter === "attention") return agent.needsAttention
    if (filter === "errors") return agent.hasError
    if (filter === "working") return ["working", "thinking", "responding"].includes(agent.state)
    if (filter === "completed") return agent.completed && healthIsVisible(agent.health, { active: agent.active })
    if (filter === "stalled") return agent.stalled
    if (filter === "collisions") return agent.collision
    return healthIsVisible(agent.health, { active: agent.active })
  }).sort((a, b) => {
    if (a.needsAttention !== b.needsAttention) return a.needsAttention ? -1 : 1
    if (a.hasError !== b.hasError) return a.hasError ? -1 : 1
    if (a.stalled !== b.stalled) return a.stalled ? -1 : 1
    if (a.collision !== b.collision) return a.collision ? -1 : 1
    return b.updated - a.updated
  })

  return {
    filter,
    project,
    agents: filtered,
    collisions,
    stats: {
      total: enriched.filter((agent) => healthIsVisible(agent.health, { active: agent.active })).length,
      attention: enriched.filter((agent) => agent.needsAttention).length,
      errors: enriched.filter((agent) => agent.hasError).length,
      working: enriched.filter((agent) => ["working", "thinking", "responding"].includes(agent.state)).length,
      completed: enriched.filter((agent) => agent.completed && healthIsVisible(agent.health, { active: agent.active })).length,
      stalled: enriched.filter((agent) => agent.stalled).length,
      collisions: collisions.length,
    },
  }
}

export function agentWindow(agents, selected, height) {
  const list = Array.from(agents ?? [])
  const size = Math.max(1, Math.floor(Number(height) || 1))
  const index = Math.max(0, Math.min(list.length - 1, Math.floor(Number(selected) || 0)))
  const start = Math.max(0, Math.min(index - Math.floor(size / 2), Math.max(0, list.length - size)))
  const end = Math.min(list.length, start + size)
  return { rows: list.slice(start, end), start, end, before: start, after: Math.max(0, list.length - end), selected: index }
}
