// Pure project-delivery intelligence for the Workbench.
//
// Live telemetry belongs to Mission Control. This model only answers what must
// be delivered, reviewed, decided, or resumed across chats and folders.

function rows(value) {
  return Array.from(value ?? []).filter((item) => item && typeof item === "object")
}

function number(value) {
  const result = Number(value)
  return Number.isFinite(result) ? result : 0
}

function updated(item) {
  return number(item?.updated)
}

function changed(item) {
  return Math.max(0, number(item?.changedFiles))
}

function fileName(item) {
  return String(item?.file ?? item?.path ?? "").trim().replaceAll("\\", "/")
}

function todoStatus(item) {
  const value = String(item?.status ?? "pending").toLowerCase()
  if (value === "completed" || value === "cancelled" || value === "in_progress") return value
  return "pending"
}

function sessionProject(session, projects) {
  return projects.find((project) => project.id === session.projectID || project.stateKey === session.projectKey) ?? null
}

export function commandCenterModel(input = {}) {
  const allProjects = rows(input.projects)
  const allSessions = rows(input.sessions)
  const selectedProjectID = String(input.selectedProjectID ?? "")
  const scope = input.scope === "selected" && selectedProjectID ? "selected" : "all"
  const projects = scope === "selected"
    ? allProjects.filter((project) => project.id === selectedProjectID || project.stateKey === selectedProjectID)
    : allProjects
  const projectIDs = new Set(projects.flatMap((project) => [project.id, project.stateKey].filter(Boolean)))
  const sessions = scope === "selected"
    ? allSessions.filter((session) => projectIDs.has(session.projectID) || projectIDs.has(session.projectKey))
    : allSessions
  const reviewed = new Set(Array.from(input.reviewed ?? []).map(String))
  const decisions = rows(input.decisions).filter((decision) => {
    if (scope !== "selected") return true
    return projectIDs.has(decision.projectID) || projectIDs.has(decision.projectKey)
  }).sort((a, b) => number(b.createdAt) - number(a.createdAt))

  const tasks = []
  for (const session of sessions) {
    for (const [index, todo] of rows(session.todos).entries()) {
      const status = todoStatus(todo)
      if (status === "cancelled") continue
      tasks.push({
        id: String(todo.id ?? `${session.id}:${index}:${String(todo.content ?? "")}`),
        content: String(todo.content ?? "Untitled task"),
        status,
        sessionID: session.id,
        sessionTitle: session.title,
        projectID: session.projectID,
        projectName: session.projectName,
        updated: updated(session),
      })
    }
  }
  tasks.sort((a, b) => {
    const rank = { in_progress: 0, pending: 1, completed: 2 }
    return (rank[a.status] ?? 3) - (rank[b.status] ?? 3) || b.updated - a.updated
  })

  const idle = sessions.filter((session) => !session.running)
  const review = idle
    .filter((session) => changed(session) > 0 && !reviewed.has(String(session.id)))
    .sort((a, b) => {
      const riskA = number(a.attention) * 100 + changed(a) * 5 + number(a.activeTodos)
      const riskB = number(b.attention) * 100 + changed(b) * 5 + number(b.activeTodos)
      return riskB - riskA || updated(b) - updated(a)
    })
  const reviewIDs = new Set(review.map((session) => session.id))
  const unresolved = idle
    .filter((session) => !reviewIDs.has(session.id) && (number(session.activeTodos) > 0 || number(session.attention) > 0 || session.lastFailed === true))
    .sort((a, b) => number(b.attention) - number(a.attention) || number(b.activeTodos) - number(a.activeTodos) || updated(b) - updated(a))
  const outcomes = idle
    .filter((session) => !reviewIDs.has(session.id) && number(session.completedTodos) > 0 && number(session.activeTodos) === 0 && number(session.attention) === 0)
    .sort((a, b) => updated(b) - updated(a))

  const owners = new Map()
  for (const session of sessions) {
    for (const file of rows(session.files)) {
      const name = fileName(file)
      if (!name) continue
      const key = process.platform === "win32" ? name.toLowerCase() : name
      const list = owners.get(key) ?? []
      if (!list.some((item) => item.sessionID === session.id)) {
        list.push({ sessionID: session.id, sessionTitle: session.title, projectName: session.projectName, running: session.running === true })
      }
      owners.set(key, list)
    }
  }
  const collisions = [...owners.entries()]
    .filter(([, ownerRows]) => ownerRows.length > 1)
    .map(([file, ownerRows]) => ({ file, owners: ownerRows, active: ownerRows.some((owner) => owner.running) }))
    .sort((a, b) => Number(b.active) - Number(a.active) || b.owners.length - a.owners.length || a.file.localeCompare(b.file))

  const lanes = projects.map((project) => {
    const projectSessions = sessions.filter((session) => session.projectID === project.id || session.projectKey === project.stateKey)
    const latest = projectSessions.toSorted((a, b) => updated(b) - updated(a))[0] ?? null
    const projectTasks = tasks.filter((task) => task.projectID === project.id)
    return {
      ...project,
      latest,
      openTasks: projectTasks.filter((task) => task.status !== "completed").length,
      reviews: review.filter((session) => session.projectID === project.id).length,
      unresolved: unresolved.filter((session) => session.projectID === project.id).length,
      decisions: decisions.filter((decision) => decision.projectID === project.id || decision.projectKey === project.stateKey).length,
      health: review.some((session) => session.projectID === project.id) || unresolved.some((session) => session.projectID === project.id) ? "attention" : "healthy",
    }
  }).sort((a, b) => Number(b.health === "attention") - Number(a.health === "attention") || b.reviews - a.reviews || b.openTasks - a.openTasks || updated(b) - updated(a))

  const openTasks = tasks.filter((task) => task.status !== "completed")
  return {
    scope,
    projects,
    sessions,
    tasks,
    openTasks,
    review,
    unresolved,
    decisions,
    collisions,
    outcomes,
    lanes,
    stats: {
      projects: projects.length,
      chats: sessions.length,
      openTasks: openTasks.length,
      completedTasks: tasks.length - openTasks.length,
      review: review.length,
      unresolved: unresolved.length,
      decisions: decisions.length,
      collisions: collisions.length,
      changedFiles: review.reduce((sum, session) => sum + changed(session), 0),
    },
  }
}

export function decisionRecord(input = {}) {
  const text = String(input.text ?? "").trim()
  if (!text) return null
  const createdAt = number(input.createdAt) || Date.now()
  return {
    id: String(input.id ?? `decision:${createdAt}:${text.slice(0, 24)}`),
    text: text.slice(0, 500),
    projectID: String(input.projectID ?? ""),
    projectKey: String(input.projectKey ?? ""),
    projectName: String(input.projectName ?? ""),
    sourceSessionID: String(input.sourceSessionID ?? ""),
    createdAt,
  }
}

export function normalizeDeliveryState(value = {}) {
  const reviewed = [...new Set(Array.from(value?.reviewed ?? []).map(String).filter(Boolean))].slice(0, 500)
  const decisions = rows(value?.decisions).map(decisionRecord).filter(Boolean).slice(0, 300)
  return { reviewed, decisions }
}
