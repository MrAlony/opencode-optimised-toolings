import { promises as fs } from "node:fs"
import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { isDevelopmentCheckout } from "../../shared/paths.js"
import { developmentTuiSpec } from "../../bootstrap/index.js"
import { ensureAndActivateGeneration } from "../../shared/generation.js"

export function openCodeConfigDirectory(env = process.env) {
  return env.OPENCODE_CONFIG_DIR || path.join(homedir(), ".config", "opencode")
}

export function tuiCompanionSpec(root) {
  return developmentTuiSpec(root)
}

function entrySpec(entry) {
  return Array.isArray(entry) ? entry[0] : entry
}

function specIdentity(spec) {
  if (typeof spec !== "string") return null
  try {
    if (spec.startsWith("file:")) {
      const value = path.resolve(fileURLToPath(spec)).replaceAll("\\", "/")
      return `file:${process.platform === "win32" ? value.toLowerCase() : value}`
    }
  } catch {}
  return spec.trim().toLowerCase()
}

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`)
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
  await fs.rename(temporary, file)
}

export async function ensureTuiCompanion(root, options = {}) {
  if (!isDevelopmentCheckout(root)) {
    const result = await ensureAndActivateGeneration(root, { env: options.env, configDir: options.configDirectory })
    return {
      changed: result.activation.changed,
      configPath: result.activation.files.find((file) => /tui\.json$/i.test(file)) ?? path.join(options.configDirectory ?? openCodeConfigDirectory(options.env), "tui.json"),
      spec: result.generation.specs.tui,
      generation: result.generation.root,
      restartRequired: result.activation.changed,
      replaced: null,
    }
  }

  const directory = options.configDirectory ?? openCodeConfigDirectory(options.env)
  const configPath = path.join(directory, "tui.json")
  const markerPath = path.join(directory, ".sparkly-toolings-tui.json")
  await fs.mkdir(directory, { recursive: true })
  let config = { $schema: "https://opencode.ai/tui.json", plugin: [] }
  try {
    const source = await fs.readFile(configPath, "utf8")
    try { config = JSON.parse(source) } catch (error) { throw new Error(`Cannot register the rich TUI companion because ${configPath} is invalid: ${error.message}`) }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error
  }
  if (config.plugin !== undefined && !Array.isArray(config.plugin)) throw new Error(`Cannot register the rich TUI companion because ${configPath} has a non-array plugin field`)
  let previousSpec = null
  try { previousSpec = JSON.parse(await fs.readFile(markerPath, "utf8"))?.spec ?? null } catch {}
  const spec = options.spec ?? tuiCompanionSpec(root)
  const identity = specIdentity(spec)
  const previousIdentity = specIdentity(previousSpec)
  const next = []
  let inserted = false
  for (const entry of config.plugin ?? []) {
    const itemIdentity = specIdentity(entrySpec(entry))
    if (itemIdentity === identity) {
      if (!inserted) next.push(spec)
      inserted = true
      continue
    }
    if (previousIdentity && itemIdentity === previousIdentity) continue
    if (typeof entrySpec(entry) === "string" && /opencode-optimised-toolings[\\/]packages[\\/]tui[\\/]index\.tsx/i.test(entrySpec(entry))) continue
    next.push(entry)
  }
  if (!inserted) next.push(spec)
  const changed = JSON.stringify(next) !== JSON.stringify(config.plugin ?? [])
  if (changed) await writeJsonAtomic(configPath, { ...config, $schema: config.$schema ?? "https://opencode.ai/tui.json", plugin: next })
  await writeJsonAtomic(markerPath, { spec, updatedAt: new Date().toISOString() })
  return { changed, configPath, spec, restartRequired: changed, replaced: previousSpec && previousSpec !== spec ? previousSpec : null }
}
