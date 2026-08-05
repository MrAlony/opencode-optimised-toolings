import { promises as fs } from "node:fs"
import { randomBytes } from "node:crypto"
import { homedir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

const LOCK_WAIT_MS = 10_000
const LOCK_STALE_MS = 30_000

export function openCodeConfigDirectory(env = process.env) {
  return env.OPENCODE_CONFIG_DIR || path.join(homedir(), ".config", "opencode")
}

export function tuiCompanionSpec(root) {
  return pathToFileURL(path.join(root, "packages", "tui", "index.tsx")).href
}

function entrySpec(entry) {
  return Array.isArray(entry) ? entry[0] : entry
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code !== "ESRCH"
  }
}

async function acquireLock(file) {
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      const handle = await fs.open(file, "wx", 0o600)
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), "utf8")
      await handle.close()
      return
    } catch (error) {
      if (error?.code !== "EEXIST") throw error
      let owner = null
      let age = Infinity
      try {
        const [text, stat] = await Promise.all([fs.readFile(file, "utf8"), fs.stat(file)])
        owner = JSON.parse(text)
        age = Date.now() - stat.mtimeMs
      } catch {
        owner = null
      }
      if (!pidAlive(owner?.pid) || age > LOCK_STALE_MS) {
        await fs.rm(file, { force: true }).catch(() => {})
        continue
      }
      if (Date.now() >= deadline) throw new Error(`TUI registration lock is still held by pid ${owner.pid}`)
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
}

async function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.${randomBytes(5).toString("hex")}.tmp`
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
  try {
    await fs.rename(temporary, file)
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

export async function ensureTuiCompanion(root, options = {}) {
  const directory = options.configDirectory ?? openCodeConfigDirectory(options.env)
  const configPath = path.join(directory, "tui.json")
  const markerPath = path.join(directory, ".sparkly-toolings-tui.json")
  const lockPath = path.join(directory, ".sparkly-toolings-tui.lock")
  const spec = tuiCompanionSpec(root)
  await fs.mkdir(directory, { recursive: true })
  await acquireLock(lockPath)
  try {
    let config = { $schema: "https://opencode.ai/tui.json", plugin: [] }
    try {
      const source = await fs.readFile(configPath, "utf8")
      const parsed = JSON.parse(source)
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("root value must be an object")
      config = parsed
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw new Error(`Cannot register the rich TUI companion because ${configPath} is invalid: ${error.message}`)
      }
    }
    if (config.plugin !== undefined && !Array.isArray(config.plugin)) {
      throw new Error(`Cannot register the rich TUI companion because ${configPath} has a non-array plugin field`)
    }
    const plugins = config.plugin ?? []
    let previousSpec = null
    try {
      const marker = JSON.parse(await fs.readFile(markerPath, "utf8"))
      if (typeof marker?.spec === "string") previousSpec = marker.spec
    } catch {
      previousSpec = null
    }
    const present = plugins.some((entry) => entrySpec(entry) === spec)
    const nextPlugins = present
      ? plugins
      : [...plugins.filter((entry) => !previousSpec || entrySpec(entry) !== previousSpec), spec]
    if (!present) {
      await writeJsonAtomic(configPath, {
        ...config,
        $schema: config.$schema ?? "https://opencode.ai/tui.json",
        plugin: nextPlugins,
      })
    }
    await writeJsonAtomic(markerPath, { spec, updatedAt: new Date().toISOString() })
    return { changed: !present, configPath, spec, restartRequired: !present, replaced: previousSpec && previousSpec !== spec ? previousSpec : null }
  } finally {
    await fs.rm(lockPath, { force: true }).catch(() => {})
  }
}
