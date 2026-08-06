import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, copyFileSync, chmodSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"
import { applyEdits, modify, parse, printParseErrorCode } from "jsonc-parser"

export const ALONIX_PLUGIN_SPEC = "opencode-optimised-toolings@latest"
export const DCP_PLUGIN_SPEC = "@tarquinen/opencode-dcp@latest"
export const INSTRUCTION_REFERENCE = "alonix/AGENTS.md"
export const AGENTS_BLOCK_START = "<!-- ALONIX OPTIMIZED TOOL INSTRUCTIONS: START -->"
export const AGENTS_BLOCK_END = "<!-- ALONIX OPTIMIZED TOOL INSTRUCTIONS: END -->"

export const TOOL_GROUPS = [
  {
    id: "alonix",
    title: "Alonix tools",
    description: "High-information filesystem, terminal, web, privacy, tooling, and codebase-memory tools.",
    tools: [
      "alonix-read-many", "alonix-edit-many", "alonix-search", "alonix-explore", "alonix-shell",
      "alonix-background-process", "alonix-web-search", "alonix-web-fetch-many", "alonix-stealth-fetch-many",
      "alonix-stealth-search-many", "alonix-stealth-rotate-tor", "alonix-stealth-status", "alonix-toolings",
      "alonix-index-project", "alonix-index-context", "alonix-index-investigate", "alonix-index-memory",
    ],
  },
  {
    id: "opencode",
    title: "Built-in OpenCode tools",
    description: "Native tools remain independently configurable; Alonix never changes tools you do not touch.",
    tools: ["read", "edit", "glob", "grep", "list", "bash", "task", "webfetch", "websearch", "question", "skill", "lsp", "todowrite"],
  },
]

export const WEB_PROVIDERS = [
  { id: "serper_api_key", label: "Serper", env: "SERPER_API_KEY" },
  { id: "firecrawl_api_key", label: "Firecrawl", env: "FIRECRAWL_API_KEY" },
  { id: "tavily_api_key", label: "Tavily", env: "TAVILY_API_KEY" },
  { id: "exa_api_key", label: "Exa", env: "EXA_API_KEY" },
]

const packageRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)))

function normalizedPath(value) {
  return String(value ?? "").replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase()
}

function pluginName(entry) {
  const value = Array.isArray(entry) ? entry[0] : entry
  return String(value ?? "").replace(/@(?:latest|next|beta|\d.*)$/, "")
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

function formatOptions(text) {
  const tab = /\n\t+\S/.test(text)
  const eol = text.includes("\r\n") ? "\r\n" : "\n"
  return { formattingOptions: { insertSpaces: !tab, tabSize: 2, eol } }
}

function setJsonc(text, path, value) {
  return applyEdits(text, modify(text, path, value, formatOptions(text)))
}

function readText(path, fallback = "") {
  try { return readFileSync(path, "utf8") } catch { return fallback }
}

function existsFile(path) {
  try { return statSync(path).isFile() } catch { return false }
}

export function settingsPaths(options = {}) {
  const home = resolve(options.home ?? homedir())
  const configDir = resolve(options.configDir ?? join(home, ".config", "opencode"))
  const jsonc = join(configDir, "opencode.jsonc")
  const json = join(configDir, "opencode.json")
  const configPath = options.configPath ? resolve(options.configPath) : existsFile(jsonc) ? jsonc : json
  const alonixDir = join(configDir, "alonix")
  return {
    home,
    configDir,
    configPath,
    dcpPath: resolve(options.dcpPath ?? join(configDir, "dcp.jsonc")),
    alonixDir,
    instructionPath: resolve(options.instructionPath ?? join(alonixDir, "AGENTS.md")),
    agentsPath: resolve(options.agentsPath ?? join(configDir, "AGENTS.md")),
    secretsPath: resolve(options.secretsPath ?? join(alonixDir, "secrets.json")),
    backupsDir: resolve(options.backupsDir ?? join(alonixDir, "backups")),
    instructionDisablePath: resolve(options.instructionDisablePath ?? join(alonixDir, "instructions.disabled")),
    instructionSource: resolve(options.instructionSource ?? join(packageRoot, "config", "AGENTS.md")),
  }
}

function permissionValue(permission, tool) {
  const value = permission?.[tool]
  return value === "allow" || value === "ask" || value === "deny" ? value : value === undefined ? "inherit" : "custom"
}

function agentsBlockRange(text) {
  const start = text.indexOf(AGENTS_BLOCK_START)
  const end = text.indexOf(AGENTS_BLOCK_END)
  if (start < 0 && end < 0) return null
  if (start < 0 || end < 0 || end < start || text.indexOf(AGENTS_BLOCK_START, start + 1) >= 0 || text.indexOf(AGENTS_BLOCK_END, end + 1) >= 0) {
    throw new Error("AGENTS.md contains an incomplete or duplicate Alonix instruction block")
  }
  return { start, end: end + AGENTS_BLOCK_END.length }
}

function stripAgentsBlock(text) {
  const range = agentsBlockRange(text)
  if (!range) return text
  const before = text.slice(0, range.start).replace(/[ \t]+$/gm, "").replace(/\s*$/, "")
  const after = text.slice(range.end).replace(/^\s*/, "")
  if (!before) return after
  if (!after) return `${before}\n`
  return `${before}\n\n${after}`
}

function normalizeMarkdown(text) {
  return String(text ?? "").replaceAll("\r\n", "\n").trim()
}

function managedAgentsText(current, source, enabled) {
  const withoutBlock = stripAgentsBlock(current)
  if (!enabled) return withoutBlock
  const eol = current.includes("\r\n") ? "\r\n" : "\n"
  const body = source.replaceAll("\r\n", "\n").trim().replaceAll("\n", eol)
  const block = `${AGENTS_BLOCK_START}${eol}${body}${eol}${AGENTS_BLOCK_END}`
  // Migrate the original all-Alonix file without duplicating its contents.
  if (normalizeMarkdown(withoutBlock) === normalizeMarkdown(source)) return `${block}${eol}`
  const prefix = withoutBlock.replace(/\s*$/, "")
  return prefix ? `${prefix}${eol}${eol}${block}${eol}` : `${block}${eol}`
}

function dcpSettings(data) {
  return {
    minContextLimit: data?.compress?.minContextLimit ?? 50_000,
    maxContextLimit: data?.compress?.maxContextLimit ?? 100_000,
    notifications: data?.pruneNotification !== "off",
    turnProtection: typeof data?.turnProtection === "object"
      ? data.turnProtection.enabled === true
      : data?.turnProtection === true,
    deduplication: data?.strategies?.deduplication?.enabled !== false,
    purgeErrors: data?.strategies?.purgeErrors?.enabled !== false,
  }
}

export function readManagedSettings(options = {}) {
  const paths = settingsPaths(options)
  const configText = readText(paths.configPath, "{}")
  const config = parseDocument(configText, basename(paths.configPath))
  const dcpText = readText(paths.dcpPath, "{}")
  const dcp = parseDocument(dcpText, basename(paths.dcpPath))
  const secrets = parseDocument(readText(paths.secretsPath, "{}"), basename(paths.secretsPath))
  const permission = config.permission && typeof config.permission === "object" ? config.permission : {}
  const instructions = Array.isArray(config.instructions) ? config.instructions : []
  const plugins = Array.isArray(config.plugin) ? config.plugin : []
  const legacyInstructionEnabled = instructions.some((item) => {
    const value = normalizedPath(item)
    return value === normalizedPath(INSTRUCTION_REFERENCE) || value === normalizedPath(paths.instructionPath)
  })
  const agentsText = readText(paths.agentsPath)
  const web = secrets["alonix-web-search"] ?? {}
  return {
    paths,
    tools: Object.fromEntries(TOOL_GROUPS.flatMap((group) => group.tools).map((tool) => [tool, permissionValue(permission, tool)])),
    instructions: { enabled: Boolean(agentsBlockRange(agentsText) || legacyInstructionEnabled), installed: Boolean(agentsBlockRange(agentsText)) },
    dcp: { installed: plugins.some((entry) => pluginName(entry) === pluginName(DCP_PLUGIN_SPEC)), ...dcpSettings(dcp) },
    web: Object.fromEntries(WEB_PROVIDERS.map((provider) => [provider.id, Boolean(process.env[provider.env] || web[provider.id])])),
    plugin: {
      installed: plugins.some((entry) => pluginName(entry) === pluginName(ALONIX_PLUGIN_SPEC)),
      source: plugins.find((entry) => /opencode-optimised-toolings|optimised-toolings\/index\.js/i.test(String(Array.isArray(entry) ? entry[0] : entry))) ?? null,
    },
    restartRequired: false,
  }
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-")
}

function backupExisting(paths, targets) {
  const existing = targets.filter((path) => existsFile(path))
  if (!existing.length) return []
  mkdirSync(paths.backupsDir, { recursive: true })
  const stamp = timestamp()
  return existing.map((path) => {
    const backup = join(paths.backupsDir, `${stamp}-${basename(path)}`)
    copyFileSync(path, backup)
    try { chmodSync(backup, 0o600) } catch { /* Windows ACLs are inherited. */ }
    return backup
  })
}

function atomicTransaction(changes) {
  const snapshots = changes.map((change) => ({
    ...change,
    existed: existsSync(change.path),
    previous: readText(change.path),
  }))
  const applied = []
  try {
    for (const change of snapshots) {
      mkdirSync(dirname(change.path), { recursive: true })
      if (change.delete) {
        rmSync(change.path, { force: true })
      } else {
        const temporary = join(dirname(change.path), `.${basename(change.path)}.${process.pid}.${randomUUID()}.tmp`)
        writeFileSync(temporary, change.content, "utf8")
        if (change.mode) {
          try { chmodSync(temporary, change.mode) } catch { /* Windows ACLs are inherited. */ }
        }
        renameSync(temporary, change.path)
      }
      applied.push(change)
    }
  } catch (error) {
    for (const change of applied.toReversed()) {
      try {
        if (change.existed) writeFileSync(change.path, change.previous, "utf8")
        else rmSync(change.path, { force: true })
      } catch { /* Preserve the primary error. */ }
    }
    throw error
  }
}

function validLimit(value, fallback) {
  if (typeof value === "string" && /^\s*(?:100|\d{1,2})(?:\.\d+)?%\s*$/.test(value)) return value.trim()
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(10_000, Math.round(number)) : fallback
}

function orderedLimits(minimum, maximum) {
  if (typeof minimum === "number" && typeof maximum === "number") return [minimum, Math.max(minimum, maximum)]
  const percent = (value) => typeof value === "string" && value.endsWith("%") ? Number(value.slice(0, -1)) : null
  const minPercent = percent(minimum)
  const maxPercent = percent(maximum)
  if (minPercent !== null && maxPercent !== null && maxPercent < minPercent) return [minimum, minimum]
  return [minimum, maximum]
}

export function applyManagedSettings(input, options = {}) {
  const paths = settingsPaths(options)
  let configText = readText(paths.configPath, "{}")
  const config = parseDocument(configText, basename(paths.configPath))
  const permission = config.permission && typeof config.permission === "object" && !Array.isArray(config.permission)
    ? { ...config.permission }
    : typeof config.permission === "string"
      ? { "*": config.permission }
      : {}
  for (const [tool, value] of Object.entries(input?.tools ?? {})) {
    if (!TOOL_GROUPS.some((group) => group.tools.includes(tool))) continue
    if (value === "inherit") delete permission[tool]
    else if (value === "allow" || value === "ask" || value === "deny") permission[tool] = value
  }
  configText = setJsonc(configText, ["permission"], permission)

  const instructions = Array.isArray(config.instructions) ? [...config.instructions] : []
  // Remove the legacy separate-file reference. The managed profile now lives in
  // a clearly marked block inside the user's real global AGENTS.md.
  const withoutOwned = instructions.filter((item) => {
    const value = normalizedPath(item)
    return value !== normalizedPath(INSTRUCTION_REFERENCE) && value !== normalizedPath(paths.instructionPath)
  })
  configText = setJsonc(configText, ["instructions"], withoutOwned)

  const plugins = Array.isArray(config.plugin) ? [...config.plugin] : []
  const withoutDcp = plugins.filter((entry) => pluginName(entry) !== pluginName(DCP_PLUGIN_SPEC))
  if (input?.dcp?.installed) withoutDcp.push(DCP_PLUGIN_SPEC)
  configText = setJsonc(configText, ["plugin"], withoutDcp)
  parseDocument(configText, basename(paths.configPath))

  let dcpText = readText(paths.dcpPath, "{}")
  parseDocument(dcpText, basename(paths.dcpPath))
  const [minimum, maximum] = orderedLimits(
    validLimit(input?.dcp?.minContextLimit, dcpSettings(parseDocument(dcpText, basename(paths.dcpPath))).minContextLimit),
    validLimit(input?.dcp?.maxContextLimit, dcpSettings(parseDocument(dcpText, basename(paths.dcpPath))).maxContextLimit),
  )
  dcpText = setJsonc(dcpText, ["compress", "minContextLimit"], minimum)
  dcpText = setJsonc(dcpText, ["compress", "maxContextLimit"], maximum)
  // DCP's schema uses an enum for notifications and an object for turn
  // protection. Remove the invalid legacy key previously emitted by Settings.
  dcpText = setJsonc(dcpText, ["notifications"], undefined)
  dcpText = setJsonc(dcpText, ["pruneNotification"], input?.dcp?.notifications !== false ? "detailed" : "off")
  const currentDcp = parseDocument(dcpText, basename(paths.dcpPath))
  const currentTurns = Number(currentDcp?.turnProtection?.turns)
  dcpText = setJsonc(dcpText, ["turnProtection"], {
    enabled: input?.dcp?.turnProtection === true,
    turns: Number.isFinite(currentTurns) ? Math.max(0, Math.round(currentTurns)) : 4,
  })
  dcpText = setJsonc(dcpText, ["strategies", "deduplication", "enabled"], input?.dcp?.deduplication !== false)
  dcpText = setJsonc(dcpText, ["strategies", "purgeErrors", "enabled"], input?.dcp?.purgeErrors !== false)
  parseDocument(dcpText, basename(paths.dcpPath))

  const secrets = parseDocument(readText(paths.secretsPath, "{}"), basename(paths.secretsPath))
  const web = { ...(secrets["alonix-web-search"] ?? {}) }
  for (const provider of WEB_PROVIDERS) {
    if (!Object.hasOwn(input?.web ?? {}, provider.id)) continue
    const value = input.web[provider.id]
    if (value === null || value === "") delete web[provider.id]
    else if (typeof value === "string") web[provider.id] = value.trim()
  }
  const nextSecrets = { ...secrets, "alonix-web-search": web }
  const secretsText = `${JSON.stringify(nextSecrets, null, 2)}\n`

  const instructionText = readText(paths.instructionSource)
  if (input?.instructions?.enabled && !instructionText) throw new Error("The packaged Alonix instruction profile is missing")
  const instructionsEnabled = input?.instructions?.enabled === true
  const agentsText = managedAgentsText(readText(paths.agentsPath), instructionText, instructionsEnabled)

  const intended = [
    { path: paths.configPath, content: configText },
    { path: paths.dcpPath, content: dcpText },
    { path: paths.secretsPath, content: secretsText, mode: 0o600 },
    instructionsEnabled || existsFile(paths.agentsPath)
      ? { path: paths.agentsPath, content: agentsText }
      : { path: paths.agentsPath, delete: true },
    instructionsEnabled
      ? { path: paths.instructionDisablePath, delete: true }
      : { path: paths.instructionDisablePath, content: "Alonix optimized instructions disabled by user.\n", mode: 0o600 },
    // Clean up the superseded owned file after migrating its content into the
    // user's marked AGENTS.md block.
    { path: paths.instructionPath, delete: true },
  ]
  // UI frameworks may occasionally deliver duplicate activation events. Make
  // the persistence boundary idempotent: byte-identical saves perform no write,
  // create no backup, and cannot trigger repeated config-file observations.
  const changes = intended.filter((change) => change.delete ? existsFile(change.path) : !existsFile(change.path) || readText(change.path) !== change.content)
  if (!changes.length) return { ...readManagedSettings(options), restartRequired: false, backups: [], changed: false }
  const backups = backupExisting(paths, changes.map((item) => item.path))
  atomicTransaction(changes)
  return { ...readManagedSettings(options), restartRequired: true, backups, changed: true }
}

export function userSecretsPath(options = {}) {
  return settingsPaths(options).secretsPath
}

export { packageRoot }
