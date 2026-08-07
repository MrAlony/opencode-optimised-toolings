// Pure real-time supervision model for Live Agents Mission Control.

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

export const MISSION_STALL_MS = 10 * 60 * 1000

export function missionControlModel(input = {}) {
  const now = number(input.now) || Date.now()
  const filter = ["all", "attention", "working", "stalled", "collisions"].includes(input.filter) ? input.filter : "all"
  const project = String(input.project ?? "")
  const agents = rows(input.agents).map((agent) => {
    const updated = number(agent.updated)
    const age = Math.max(0, now - updated)
    const attention = number(agent.attention)
    const failed = number(agent.failedCount)
    // A remote process may own the live transcript, so `busy:false` in this
    // process is not stall evidence. Only elapsed inactivity or repeated
    // failures may classify an otherwise-running agent as stalled.
    const stalled = agent.running === true && attention === 0 && (age >= MISSION_STALL_MS || failed >= 2)
    return { ...agent, updated, age, attention, failed, stalled, needsAttention: attention > 0 || failed > 0 }
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
    if (filter === "working") return agent.running && !agent.stalled && !agent.needsAttention
    if (filter === "stalled") return agent.stalled
    if (filter === "collisions") return agent.collision
    return agent.running || agent.needsAttention
  }).sort((a, b) => {
    if (a.needsAttention !== b.needsAttention) return a.needsAttention ? -1 : 1
    if (a.collision !== b.collision) return a.collision ? -1 : 1
    if (a.stalled !== b.stalled) return a.stalled ? -1 : 1
    return b.updated - a.updated
  })

  return {
    filter,
    project,
    agents: filtered,
    collisions,
    stats: {
      total: enriched.filter((agent) => agent.running || agent.needsAttention).length,
      attention: enriched.filter((agent) => agent.needsAttention).length,
      working: enriched.filter((agent) => agent.running && !agent.stalled && !agent.needsAttention).length,
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
