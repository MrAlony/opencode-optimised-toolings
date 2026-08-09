import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"

const VERSION = 2
const MAX_FILES = 2_048
const STATES = new Set(["completed", "error", "needs-input", "seen"])
let sequence = 0

function stateRoot(api) {
  return String(api?.state?.path?.state ?? "").trim()
}

function directory(api, name = "terminal") {
  const root = stateRoot(api)
  return root ? path.join(root, "alonix", name) : ""
}

function token(sessionID) {
  return Buffer.from(String(sessionID), "utf8").toString("base64url")
}

function legacyFile(api, sessionID) {
  const root = directory(api, "completions")
  return root ? path.join(root, `${token(sessionID)}.json`) : ""
}

function eventPrefix(sessionID) {
  return `${token(sessionID)}.`
}

function readDirectory(api, name, receipts) {
  const root = directory(api, name)
  if (!root) return
  let names
  try {
    names = readdirSync(root).filter((entry) => entry.endsWith(".json")).slice(-MAX_FILES)
  } catch {
    return
  }
  for (const name of names) {
    const file = path.join(root, name)
    try {
      const value = JSON.parse(readFileSync(file, "utf8"))
      const sessionID = String(value?.sessionID ?? "").trim()
      const legacy = value?.version === 1 && Number.isFinite(Number(value?.completedAt))
      const state = legacy ? "completed" : String(value?.state ?? "")
      const occurredAt = Number(legacy ? value.completedAt : value?.occurredAt)
      if ((!legacy && value?.version !== VERSION) || !sessionID || !STATES.has(state) || !Number.isFinite(occurredAt) || occurredAt <= 0) {
        rmSync(file, { force: true })
        continue
      }
      const current = receipts[sessionID]
      if (!current || occurredAt > current.occurredAt || (occurredAt === current.occurredAt && name > current._name)) {
        receipts[sessionID] = {
          state,
          occurredAt,
          completedAt: state === "completed" ? occurredAt : 0,
          detail: String(value?.detail ?? "").slice(0, 500),
          source: "terminal-receipt",
          _name: name,
        }
      }
    } catch {
      try { rmSync(file, { force: true }) } catch {}
    }
  }
}

/** Durable terminal lifecycle state. It remains until explicitly seen or new work starts. */
export function readCompletionReceipts(api) {
  const receipts = {}
  readDirectory(api, "completions", receipts)
  readDirectory(api, "terminal", receipts)
  for (const receipt of Object.values(receipts)) delete receipt._name
  return receipts
}

/**
 * Append one immutable lifecycle event. Separate files avoid cross-process
 * read/modify/write races and Windows rename-over-existing failures.
 */
export function publishTerminalReceipt(api, sessionID, state, options = {}) {
  const id = String(sessionID ?? "").trim()
  const normalizedState = String(state ?? "")
  const root = directory(api)
  if (!root || !id || !STATES.has(normalizedState)) return false
  const occurredAt = Number(options.occurredAt ?? options.completedAt ?? Date.now())
  if (!Number.isFinite(occurredAt) || occurredAt <= 0) return false
  const name = `${eventPrefix(id)}${String(Math.floor(occurredAt)).padStart(16, "0")}.${process.pid}.${sequence++}.json`
  try {
    mkdirSync(root, { recursive: true })
    const record = {
      version: VERSION,
      sessionID: id,
      state: normalizedState,
      occurredAt,
      detail: String(options.detail ?? "").slice(0, 500),
    }
    writeFileSync(path.join(root, name), `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "wx" })
    return true
  } catch {
    return false
  }
}

export function publishCompletionReceipt(api, sessionID, options = {}) {
  return publishTerminalReceipt(api, sessionID, "completed", options)
}

export function acknowledgeTerminalReceipt(api, sessionID, options = {}) {
  return publishTerminalReceipt(api, sessionID, "seen", { occurredAt: options.seenAt ?? Date.now() })
}

/** Remove all lifecycle history only when a producer proves genuinely new work. */
export function clearCompletionReceipt(api, sessionID) {
  const id = String(sessionID ?? "").trim()
  if (!id) return false
  let changed = false
  const root = directory(api)
  if (root) {
    try {
      for (const name of readdirSync(root)) {
        if (!name.startsWith(eventPrefix(id)) || !name.endsWith(".json")) continue
        rmSync(path.join(root, name), { force: true })
        changed = true
      }
    } catch {}
  }
  const legacy = legacyFile(api, id)
  if (legacy) {
    try {
      rmSync(legacy, { force: true })
      changed = true
    } catch {}
  }
  return changed
}

export const completionReceiptDefaults = Object.freeze({ maxFiles: MAX_FILES, states: [...STATES] })
