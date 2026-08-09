// Canonical current-state health for a chat/agent.
//
// Presentation surfaces must not infer health independently. States are emitted
// only from authoritative evidence: blockers, current-turn activity, a proven
// in-flight stall, or a lifecycle completion receipt.

export const SESSION_STALL_MS = 10 * 60 * 1000

function number(value) {
  const result = Number(value)
  return Number.isFinite(result) ? result : 0
}

export function sessionHealth(input = {}) {
  const activity = input.activity ?? {}
  const attention = Math.max(0, number(input.attention))
  const running = input.running === true
  const now = number(input.now) || Date.now()
  const hydrated = activity.hydrated === true
  const progressAt = number(activity.progressAt)
  const progressAge = progressAt > 0 ? Math.max(0, now - progressAt) : 0
  const completedAt = number(input.completedAt)
  const age = completedAt > 0 ? Math.max(0, now - completedAt) : 0
  const terminalState = String(input.terminalState ?? "")
  const acknowledged = terminalState === "seen"
  const hasError = !acknowledged && (terminalState === "error" || (hydrated && activity.latestToolFailed === true))
  const toolRunning = number(activity.runningCount) > 0
  const stalled = running && attention === 0 && !hasError && hydrated && toolRunning && activity.inFlight === true && progressAt > 0 && progressAge >= SESSION_STALL_MS
  const busy = activity.busy === true
  const headline = String(activity.headline ?? "").trim()
  const effectiveAttention = acknowledged ? 0 : attention
  const completed = !running && !effectiveAttention && !hasError && (terminalState === "completed" || input.completed === true) && completedAt > 0

  if (terminalState === "needs-input" || effectiveAttention > 0) return { state: "needs-input", label: "needs you", detail: headline || "Waiting for your input", tone: "warning", pulse: false, attention: effectiveAttention, running, age, hydrated }
  if (hasError) return { state: "error", label: "error", detail: headline || "Latest tool failed", tone: "error", pulse: false, attention, running, age, hydrated }
  if (stalled) return { state: "stalled", label: "stalled", detail: headline || "No progress in the current operation", tone: "error", pulse: false, attention, running, age, hydrated }
  if (running && toolRunning) return { state: "working", label: "working", detail: headline || "Working", tone: "accent", pulse: true, attention, running, age, hydrated }
  if (running && busy && /^thinking$/i.test(headline)) return { state: "thinking", label: "thinking", detail: headline, tone: "accent", pulse: true, attention, running, age, hydrated }
  if (running && busy && /^responding$/i.test(headline)) return { state: "responding", label: "responding", detail: headline, tone: "accent", pulse: true, attention, running, age, hydrated }
  if (running) return { state: "working", label: "working", detail: hydrated && headline && !/^idle$/i.test(headline) ? headline : "Working in another window", tone: "accent", pulse: true, attention, running, age, hydrated }
  if (completed) return { state: "completed", label: "completed", detail: headline && !/^waiting for you$|^idle$/i.test(headline) ? headline : "Work completed", tone: "success", pulse: false, attention, running, age, hydrated }
  return { state: "idle", label: "idle", detail: headline && hydrated && !/^waiting for you$|^idle$/i.test(headline) ? headline : "Idle", tone: "neutral", pulse: false, attention, running, age, hydrated }
}

export function healthIsVisible(health, input = {}) {
  if (!health) return false
  if (health.state !== "idle" && health.state !== "completed") return true
  if (health.state === "completed") return true
  return false
}
