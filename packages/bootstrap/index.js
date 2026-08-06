import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { basename, dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { applyEdits, modify, parse, printParseErrorCode } from "jsonc-parser"
import { PACKAGE_NAME, PACKAGE_SPEC, installedPackageSpec, isDevelopmentCheckout, openCodeConfigDir } from "../shared/paths.js"
export { PACKAGE_SPEC } from "../shared/paths.js"

export const AGENTS_BLOCK_START = "<!-- ALONIX OPTIMIZED TOOL INSTRUCTIONS: START -->"
export const AGENTS_BLOCK_END = "<!-- ALONIX OPTIMIZED TOOL INSTRUCTIONS: END -->"

export const ALONIX_TOOLS = [
  "alonix-read", "alonix-edit", "alonix-search", "alonix-explore", "alonix-shell",
  "alonix-background-process", "alonix-web-search", "alonix-web-fetch", "alonix-stealth-fetch",
  "alonix-stealth-search", "alonix-stealth-rotate-tor", "alonix-stealth-status", "alonix-toolings",
  "alonix-index-project", "alonix-index-context", "alonix-index-investigate", "alonix-index-memory",
]

export const LEGACY_TOOL_IDS = {
  "alonix-read-many": "alonix-read",
  "alonix-edit-many": "alonix-edit",
  "alonix-web-fetch-many": "alonix-web-fetch",
  "alonix-stealth-fetch-many": "alonix-stealth-fetch",
  "alonix-stealth-search-many": "alonix-stealth-search",
}

function pluginSpec(entry) {
  return String(Array.isArray(entry) ? entry[0] : entry ?? "")
}

export function isAlonixLocalReference(value) {
  const text = String(value ?? "").replaceAll("\\", "/").toLowerCase()
  return text.includes("opencode-optimised-toolings") && (text.startsWith("file:") || /^[a-z]:\//.test(text) || text.startsWith("/") || text.startsWith("."))
}

export function isLegacyCbmSkillPath(value) {
  const text = String(value ?? "").replaceAll("\\", "/").toLowerCase()
  return text.includes("opencode-optimised-toolings/packages/cbm") || text.includes("/oc-cbm")
}

export function isLegacyInstructionPath(value) {
  const text = String(value ?? "").replaceAll("\\", "/").toLowerCase()
  return text === "alonix/agents.md" || text.includes("opencode-optimised-toolings/config/agents.md") || text.includes("/alonix/agents.md")
}

function addUnique(list, value) {
  if (!list.some((item) => String(item).replaceAll("\\", "/").toLowerCase() === String(value).replaceAll("\\", "/").toLowerCase())) list.push(value)
}

export function applyRuntimeDefaults(config, packageRoot) {
  const permission = typeof config.permission === "string"
    ? { "*": config.permission }
    : config.permission && typeof config.permission === "object" && !Array.isArray(config.permission)
      ? config.permission
      : {}
  for (const [legacy, current] of Object.entries(LEGACY_TOOL_IDS)) {
    if (permission[current] === undefined && permission[legacy] !== undefined) permission[current] = permission[legacy]
    delete permission[legacy]
  }
  for (const tool of ALONIX_TOOLS) {
    if (permission[tool] === undefined) permission[tool] = tool === "alonix-background-process" ? "deny" : "allow"
  }
  config.permission = permission

  // Instructions are installed as one owned block in the user's global
  // AGENTS.md during installed-package migration. Do not inject an immutable
  // package path here: that would bypass the Settings opt-out toggle.
  config.skills = config.skills && typeof config.skills === "object" && !Array.isArray(config.skills) ? config.skills : {}
  config.skills.paths = Array.isArray(config.skills.paths) ? config.skills.paths : []
  addUnique(config.skills.paths, resolve(packageRoot, "packages", "cbm"))
  return config
}

function parseDocument(text, label) {
  const errors = []
  const data = parse(text || "{}", errors, { allowTrailingComma: true, disallowComments: false })
  if (errors.length) {
    const detail = errors.slice(0, 3).map((item) => `${printParseErrorCode(item.error)} at ${item.offset}`).join(", ")
    throw new Error(`${label} is not valid JSON/JSONC (${detail})`)
  }
  return data && typeof data === "object" && !Array.isArray(data) ? data : {}
}

function setJsonc(text, path, value) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n"
  return applyEdits(text, modify(text, path, value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol } }))
}

function writeAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = join(dirname(file), `.${basename(file)}.${process.pid}.${randomUUID()}.tmp`)
  writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600 })
  renameSync(temporary, file)
}

function ownedAgentsText(current, source) {
  const start = current.indexOf(AGENTS_BLOCK_START)
  const end = current.indexOf(AGENTS_BLOCK_END)
  if ((start < 0) !== (end < 0) || (start >= 0 && (end < start || current.indexOf(AGENTS_BLOCK_START, start + 1) >= 0 || current.indexOf(AGENTS_BLOCK_END, end + 1) >= 0))) {
    throw new Error("AGENTS.md contains an incomplete or duplicate Alonix instruction block")
  }
  const eol = current.includes("\r\n") ? "\r\n" : "\n"
  const block = `${AGENTS_BLOCK_START}${eol}${source.replaceAll("\r\n", "\n").trim().replaceAll("\n", eol)}${eol}${AGENTS_BLOCK_END}`
  if (start >= 0) return `${current.slice(0, start)}${block}${current.slice(end + AGENTS_BLOCK_END.length)}`
  if (current.trim() === source.trim()) return `${block}${eol}`
  const prefix = current.replace(/\s*$/, "")
  return prefix ? `${prefix}${eol}${eol}${block}${eol}` : `${block}${eol}`
}

export function migrateInstalledConfig(packageRoot, options = {}) {
  if (isDevelopmentCheckout(packageRoot) && options.force !== true) return { changed: false, skipped: "development-checkout" }
  const configDir = resolve(options.configDir ?? openCodeConfigDir(options.env))
  const jsonc = join(configDir, "opencode.jsonc")
  const json = join(configDir, "opencode.json")
  const configPath = options.configPath ?? (existsSync(jsonc) ? jsonc : json)
  if (!existsSync(configPath)) return { changed: false, skipped: "missing-config", configPath }
  const before = readFileSync(configPath, "utf8")
  const config = parseDocument(before, basename(configPath))
  const managedSpec = options.pluginSpec ?? installedPackageSpec(packageRoot)
  const plugins = Array.isArray(config.plugin) ? config.plugin : []
  const nextPlugins = plugins.filter((entry) => {
    const spec = pluginSpec(entry)
    return !isAlonixLocalReference(spec) && !new RegExp(`^${PACKAGE_NAME}(?:@|$)`, "i").test(spec)
  })
  nextPlugins.unshift(managedSpec)

  const skills = config.skills && typeof config.skills === "object" && !Array.isArray(config.skills) ? config.skills : {}
  const paths = Array.isArray(skills.paths) ? skills.paths.filter((entry) => !isLegacyCbmSkillPath(entry)) : []
  const instructions = Array.isArray(config.instructions) ? config.instructions.filter((entry) => !isLegacyInstructionPath(entry)) : []
  const permission = typeof config.permission === "string"
    ? { "*": config.permission }
    : config.permission && typeof config.permission === "object" && !Array.isArray(config.permission)
      ? { ...config.permission }
      : {}
  for (const [legacy, current] of Object.entries(LEGACY_TOOL_IDS)) {
    if (permission[current] === undefined && permission[legacy] !== undefined) permission[current] = permission[legacy]
    delete permission[legacy]
  }

  let after = setJsonc(before, ["plugin"], nextPlugins)
  if (config.skills !== undefined || paths.length) after = setJsonc(after, ["skills", "paths"], paths)
  if (config.instructions !== undefined || instructions.length) after = setJsonc(after, ["instructions"], instructions)
  if (config.permission !== undefined || Object.keys(permission).length) after = setJsonc(after, ["permission"], permission)
  parseDocument(after, basename(configPath))

  const alonixDir = join(configDir, "alonix")
  const agentsPath = join(configDir, "AGENTS.md")
  const disableInstructions = join(alonixDir, "instructions.disabled")
  const source = readFileSync(join(packageRoot, "config", "AGENTS.md"), "utf8")
  const agentsBefore = existsSync(agentsPath) ? readFileSync(agentsPath, "utf8") : ""
  const agentsAfter = existsSync(disableInstructions) ? agentsBefore : ownedAgentsText(agentsBefore, source)
  const configChanged = after !== before
  const agentsChanged = agentsAfter !== agentsBefore
  if (!configChanged && !agentsChanged) return { changed: false, configPath }

  const backupDir = join(alonixDir, "backups")
  mkdirSync(backupDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const backupPath = configChanged ? join(backupDir, `${stamp}-${basename(configPath)}`) : null
  const agentsBackupPath = agentsChanged && existsSync(agentsPath) ? join(backupDir, `${stamp}-AGENTS.md`) : null
  if (backupPath) writeFileSync(backupPath, before, { encoding: "utf8", mode: 0o600 })
  if (agentsBackupPath) writeFileSync(agentsBackupPath, agentsBefore, { encoding: "utf8", mode: 0o600 })
  try {
    if (configChanged) writeAtomic(configPath, after)
    if (agentsChanged) writeAtomic(agentsPath, agentsAfter)
  } catch (error) {
    if (configChanged) writeAtomic(configPath, before)
    if (agentsChanged) agentsBefore ? writeAtomic(agentsPath, agentsBefore) : rmSync(agentsPath, { force: true })
    throw error
  }
  return { changed: true, configPath, backupPath, agentsPath, agentsBackupPath, plugin: managedSpec }
}

export function packageTuiSpec(packageRoot) {
  return installedPackageSpec(packageRoot)
}

export function developmentTuiSpec(packageRoot) {
  return pathToFileURL(join(packageRoot, "packages", "tui", "index.tsx")).href
}
