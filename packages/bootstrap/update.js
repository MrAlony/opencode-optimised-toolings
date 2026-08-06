import { existsSync } from "node:fs"
import { promises as fs } from "node:fs"
import { basename, dirname, join } from "node:path"
import { randomUUID } from "node:crypto"
import { applyEdits, modify, parse, printParseErrorCode } from "jsonc-parser"
import {
  PACKAGE_NAME,
  installedPackageSpec,
  isDevelopmentCheckout,
  openCodeConfigDir,
  packageVersion,
} from "../shared/paths.js"

const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`
const CHECK_DELAY_MS = 1_500
const CHECK_TIMEOUT_MS = 5_000

function parseDocument(text, label) {
  const errors = []
  const data = parse(text || "{}", errors, { allowTrailingComma: true, disallowComments: false })
  if (errors.length) {
    const detail = errors.slice(0, 3).map((item) => `${printParseErrorCode(item.error)} at ${item.offset}`).join(", ")
    throw new Error(`${label} is not valid JSON/JSONC (${detail})`)
  }
  return data && typeof data === "object" && !Array.isArray(data) ? data : {}
}

function pluginSpec(entry) {
  return String(Array.isArray(entry) ? entry[0] : entry ?? "")
}

function isManagedSpec(value) {
  return new RegExp(`^(?:npm:)?${PACKAGE_NAME}(?:@|$)`, "i").test(String(value ?? "").trim())
}

function replaceManagedPlugin(list, spec) {
  const input = Array.isArray(list) ? list : []
  const output = []
  let inserted = false
  for (const entry of input) {
    if (!isManagedSpec(pluginSpec(entry))) {
      output.push(entry)
      continue
    }
    if (inserted) continue
    output.push(Array.isArray(entry) ? [spec, ...entry.slice(1)] : spec)
    inserted = true
  }
  if (!inserted) output.unshift(spec)
  return output
}

function setJsonc(text, path, value) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n"
  return applyEdits(text, modify(text, path, value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol } }))
}

function versionParts(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(value ?? ""))
  if (!match) return null
  return { numbers: match.slice(1, 4).map(Number), prerelease: match[4] ?? "" }
}

export function compareVersions(left, right) {
  const a = versionParts(left)
  const b = versionParts(right)
  if (!a || !b) return 0
  for (let index = 0; index < 3; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] < b.numbers[index] ? -1 : 1
  }
  if (a.prerelease === b.prerelease) return 0
  if (!a.prerelease) return 1
  if (!b.prerelease) return -1
  return a.prerelease.localeCompare(b.prerelease)
}

async function atomicWrite(file, text) {
  await fs.mkdir(dirname(file), { recursive: true })
  const temporary = join(dirname(file), `.${basename(file)}.${process.pid}.${randomUUID()}.tmp`)
  await fs.writeFile(temporary, text, { encoding: "utf8", mode: 0o600 })
  await fs.rename(temporary, file)
}

async function latestVersion(fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== "function") throw new Error("Package update check requires fetch")
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS)
  timer?.unref?.()
  try {
    const response = await fetchImpl(REGISTRY_URL, { headers: { accept: "application/json" }, signal: controller.signal })
    if (!response?.ok) throw new Error(`npm registry returned HTTP ${response?.status ?? "unknown"}`)
    const data = await response.json()
    if (!versionParts(data?.version)) throw new Error("npm registry returned an invalid package version")
    return data.version
  } finally {
    clearTimeout(timer)
  }
}

export async function stagePackageUpdate(packageRoot, options = {}) {
  if (isDevelopmentCheckout(packageRoot) && options.force !== true) return { changed: false, skipped: "development-checkout" }
  const current = packageVersion(packageRoot)
  if (!current) return { changed: false, skipped: "unknown-current-version" }
  const latest = options.latestVersion ?? await latestVersion(options.fetch)
  if (compareVersions(latest, current) <= 0) return { changed: false, current, latest }

  const configDir = options.configDir ?? openCodeConfigDir(options.env)
  const opencodeJsonc = join(configDir, "opencode.jsonc")
  const opencodeJson = join(configDir, "opencode.json")
  const configPath = existsSync(opencodeJsonc) ? opencodeJsonc : opencodeJson
  const tuiPath = join(configDir, "tui.json")
  const targetSpec = `${PACKAGE_NAME}@${latest}`
  const planned = []

  for (const file of [configPath, tuiPath]) {
    if (!existsSync(file)) continue
    const before = await fs.readFile(file, "utf8")
    const data = parseDocument(before, basename(file))
    const plugins = replaceManagedPlugin(data.plugin, targetSpec)
    const after = setJsonc(before, ["plugin"], plugins)
    parseDocument(after, basename(file))
    if (after !== before) planned.push({ file, before, after })
  }
  if (!planned.length) return { changed: false, current, latest, targetSpec }

  const backupDir = join(configDir, "alonix", "backups")
  await fs.mkdir(backupDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const applied = []
  try {
    for (const item of planned) {
      const backup = join(backupDir, `${stamp}-update-${basename(item.file)}`)
      await fs.writeFile(backup, item.before, { encoding: "utf8", mode: 0o600 })
      await atomicWrite(item.file, item.after)
      applied.push(item)
    }
  } catch (error) {
    for (const item of applied.reverse()) await atomicWrite(item.file, item.before).catch(() => {})
    throw error
  }
  return { changed: true, current, latest, targetSpec, restartRequired: true, files: planned.map((item) => item.file) }
}

let scheduled = false
export function schedulePackageUpdate(packageRoot, options = {}) {
  if (scheduled || isDevelopmentCheckout(packageRoot)) return false
  scheduled = true
  const timer = setTimeout(() => {
    void stagePackageUpdate(packageRoot, options).catch((error) => {
      if (process.env.OPENCODE_TOOLINGS_DEBUG === "1") console.warn(`[alonix] package update check skipped: ${error?.message ?? error}`)
    })
  }, options.delayMs ?? CHECK_DELAY_MS)
  timer?.unref?.()
  return true
}

export function currentInstalledSpec(packageRoot) {
  return installedPackageSpec(packageRoot)
}
