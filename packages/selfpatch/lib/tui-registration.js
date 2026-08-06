import { promises as fs } from "node:fs"
import { randomBytes } from "node:crypto"
import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { isDevelopmentCheckout } from "../../shared/paths.js"
import { developmentTuiSpec, packageTuiSpec } from "../../bootstrap/index.js"

const LOCK_WAIT_MS = 10_000
const LOCK_STALE_MS = 30_000

export function openCodeConfigDirectory(env = process.env) {
  return env.OPENCODE_CONFIG_DIR || path.join(homedir(), ".config", "opencode")
}

export function tuiCompanionSpec(root, options = {}) {
  if (typeof options.spec === "string" && options.spec.trim()) return options.spec.trim()
  return isDevelopmentCheckout(root) ? developmentTuiSpec(root) : packageTuiSpec(root)
}

function entrySpec(entry) {
  return Array.isArray(entry) ? entry[0] : entry
}

function packageIdentity(spec) {
  const value = String(spec ?? "").trim()
  const match = /^(?:npm:)?(opencode-optimised-toolings)(?:@.*)?$/i.exec(value)
  return match ? `npm:${match[1].toLowerCase()}` : null
}

function specIdentity(spec) {
  if (typeof spec !== "string") return null
  const packageID = packageIdentity(spec)
  if (packageID) return packageID
  try {
    if (spec.startsWith("file:")) {
      const value = path.resolve(fileURLToPath(spec)).replaceAll("\\", "/")
      return `file:${process.platform === "win32" ? value.toLowerCase() : value}`
    }
  } catch {
    return spec
  }
  return spec
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

async function retryWindowsReplace(operation, attempts = 6) {
  let last
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      last = error
      if (!new Set(["EACCES", "EBUSY", "EPERM"]).has(error?.code) || attempt === attempts - 1) throw error
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)))
    }
  }
  throw last
}

async function writeJsonAtomic(file, value) {
  const nonce = `${process.pid}.${randomBytes(5).toString("hex")}`
  const temporary = `${file}.${nonce}.tmp`
  const displaced = `${file}.${nonce}.old`
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
  let movedExisting = false
  try {
    try {
      await retryWindowsReplace(() => fs.rename(file, displaced))
      movedExisting = true
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
    }
    await retryWindowsReplace(() => fs.rename(temporary, file))
    if (movedExisting) await fs.rm(displaced, { force: true })
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {})
    if (movedExisting) {
      let targetExists = true
      try { await fs.access(file) } catch { targetExists = false }
      if (!targetExists) {
        try { await retryWindowsReplace(() => fs.rename(displaced, file)) }
        catch (rollbackError) { throw new AggregateError([error, rollbackError], `Could not replace ${file} and could not restore the previous file`) }
      }
    }
    throw error
  } finally {
    let targetExists = true
    try { await fs.access(file) } catch { targetExists = false }
    if (targetExists) await fs.rm(displaced, { force: true }).catch(() => {})
  }
}

export async function ensureTuiCompanion(root, options = {}) {
  const directory = options.configDirectory ?? openCodeConfigDirectory(options.env)
  const configPath = path.join(directory, "tui.json")
  const markerPath = path.join(directory, ".sparkly-toolings-tui.json")
  const lockPath = path.join(directory, ".sparkly-alonix-toolings-tui.lock")
  const spec = tuiCompanionSpec(root, options)
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
    const identity = specIdentity(spec)
    const previousIdentity = specIdentity(previousSpec)
    let keptCompanion = false
    const nextPlugins = []
    for (const entry of plugins) {
      const entryIdentity = specIdentity(entrySpec(entry))
      if (entryIdentity === identity) {
        if (!keptCompanion) nextPlugins.push(spec)
        keptCompanion = true
        continue
      }
      if (previousIdentity && previousIdentity !== identity && entryIdentity === previousIdentity) continue
      // Clean checkout-based companion entries even when an old marker was
      // lost. This is narrowly scoped to this package's TUI entry.
      if (identity?.startsWith("npm:") && typeof entrySpec(entry) === "string" && /opencode-optimised-toolings[\\/]packages[\\/]tui[\\/]index\.tsx/i.test(entrySpec(entry))) continue
      nextPlugins.push(entry)
    }
    if (!keptCompanion) nextPlugins.push(spec)
    const changed = JSON.stringify(nextPlugins) !== JSON.stringify(plugins)
    if (changed) {
      await writeJsonAtomic(configPath, {
        ...config,
        $schema: config.$schema ?? "https://opencode.ai/tui.json",
        plugin: nextPlugins,
      })
    }
    await writeJsonAtomic(markerPath, { spec, updatedAt: new Date().toISOString() })
    return { changed, configPath, spec, restartRequired: changed, replaced: previousSpec && previousSpec !== spec ? previousSpec : null }
  } finally {
    await fs.rm(lockPath, { force: true }).catch(() => {})
  }
}
