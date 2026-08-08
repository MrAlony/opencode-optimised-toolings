import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"

const VERSION = 1
const ACTIVE_TYPES = new Set(["busy", "retry", "compacting"])
const DEFAULT_TTL_MS = 20_000
const MAX_FILES = 512
let sequence = 0

function stateRoot(api) {
  return String(api?.state?.path?.state ?? "").trim()
}

function leaseDirectory(api) {
  const root = stateRoot(api)
  return root ? path.join(root, "alonix", "presence") : ""
}

function sessionToken(sessionID) {
  return Buffer.from(String(sessionID), "utf8").toString("base64url")
}

function leasePrefix(sessionID) {
  return `${sessionToken(sessionID)}.`
}

function parseLease(file, now, ttlMs) {
  try {
    const value = JSON.parse(readFileSync(file, "utf8"))
    const sessionID = String(value?.sessionID ?? "").trim()
    const type = String(value?.type ?? "")
    const observedAt = Number(value?.observedAt)
    if (value?.version !== VERSION || !sessionID || !ACTIVE_TYPES.has(type)) return null
    if (!Number.isFinite(observedAt) || now - observedAt > ttlMs) return null
    const metadata = value?.session && typeof value.session === "object" ? value.session : {}
    const session = {
      id: sessionID,
      title: String(metadata.title ?? "Working session").slice(0, 240),
      directory: String(metadata.directory ?? "").slice(0, 2_000),
      projectID: typeof metadata.projectID === "string" ? metadata.projectID.slice(0, 240) : undefined,
      parentID: typeof metadata.parentID === "string" ? metadata.parentID.slice(0, 240) : undefined,
      time: { updated: Number(metadata?.time?.updated ?? observedAt) || observedAt },
      alonixPresenceOnly: true,
    }
    return { sessionID, type, observedAt, source: "shared-presence", session }
  } catch {
    return null
  }
}

export function readPresenceSnapshot(api, options = {}) {
  const directory = leaseDirectory(api)
  if (!directory) return { statuses: {}, sessions: [] }
  const now = Number(options.now ?? Date.now())
  const ttlMs = Math.max(1, Number(options.ttlMs ?? DEFAULT_TTL_MS))
  let names
  try {
    names = readdirSync(directory).filter((name) => name.endsWith(".json")).slice(-MAX_FILES)
  } catch {
    return { statuses: {}, sessions: [] }
  }
  const leases = {}
  for (const name of names) {
    const file = path.join(directory, name)
    const lease = parseLease(file, now, ttlMs)
    if (!lease) {
      try { rmSync(file, { force: true }) } catch {}
      continue
    }
    const previous = leases[lease.sessionID]
    if (!previous || lease.observedAt > previous.observedAt) leases[lease.sessionID] = lease
  }
  return {
    statuses: Object.fromEntries(Object.entries(leases).map(([id, lease]) => [id, lease])),
    sessions: Object.values(leases).map((lease) => lease.session),
  }
}

export function readPresenceLeases(api, options = {}) {
  return readPresenceSnapshot(api, options).statuses
}

export function publishPresenceLease(api, sessionID, status, options = {}) {
  const id = String(sessionID ?? "").trim()
  const type = String(status?.type ?? status ?? "")
  const directory = leaseDirectory(api)
  if (!directory || !id || !ACTIVE_TYPES.has(type)) return false
  const observedAt = Number(options.now ?? Date.now())
  const owner = `${process.pid}-${String(options.owner ?? "tui").replace(/[^a-zA-Z0-9_-]/g, "_")}`
  const prefix = leasePrefix(id)
  try {
    mkdirSync(directory, { recursive: true })
    const name = `${prefix}${owner}.${observedAt}.${sequence++}.json`
    const source = options.session && typeof options.session === "object" ? options.session : {}
    const session = {
      title: String(source.title ?? "Working session").slice(0, 240),
      directory: String(source.directory ?? "").slice(0, 2_000),
      projectID: typeof source.projectID === "string" ? source.projectID.slice(0, 240) : undefined,
      parentID: typeof source.parentID === "string" ? source.parentID.slice(0, 240) : undefined,
      time: { updated: Number(source?.time?.updated ?? observedAt) || observedAt },
    }
    writeFileSync(path.join(directory, name), `${JSON.stringify({ version: VERSION, sessionID: id, type, observedAt, owner, session })}\n`, { encoding: "utf8", flag: "wx" })
    for (const entry of readdirSync(directory)) {
      if (!entry.startsWith(`${prefix}${owner}.`) || entry === name) continue
      try { rmSync(path.join(directory, entry), { force: true }) } catch {}
    }
    return true
  } catch {
    return false
  }
}

export function clearPresenceLease(api, sessionID) {
  const id = String(sessionID ?? "").trim()
  const directory = leaseDirectory(api)
  if (!directory || !id) return false
  const prefix = leasePrefix(id)
  let removed = false
  try {
    for (const entry of readdirSync(directory)) {
      if (!entry.startsWith(prefix)) continue
      try {
        rmSync(path.join(directory, entry), { force: true })
        removed = true
      } catch {}
    }
  } catch {}
  return removed
}

export const presenceLeaseDefaults = Object.freeze({ ttlMs: DEFAULT_TTL_MS, maxFiles: MAX_FILES })
