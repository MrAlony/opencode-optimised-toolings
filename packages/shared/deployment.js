import { createHash, randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { promises as fs } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parse } from "jsonc-parser"
import {
  activatePackageGeneration,
  deploymentRecordPath,
  ensurePackageGeneration,
  generationSpecs,
  runtimeAttestation,
  tuiCoordinationPath,
  validateGeneration,
} from "./generation.js"
import { PACKAGE_NAME, openCodeConfigDir, packageVersion, runtimeRootForPackage } from "./paths.js"

function normalize(value) {
  const result = resolve(String(value ?? ""))
  return process.platform === "win32" ? result.toLowerCase() : result
}

async function atomicWrite(file, text) {
  await fs.mkdir(dirname(file), { recursive: true })
  try { if (await fs.readFile(file, "utf8") === text) return false } catch {}
  const temporary = join(dirname(file), `.${basename(file)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    await fs.writeFile(temporary, text, { encoding: "utf8", mode: 0o600 })
    await fs.rename(temporary, file)
    return true
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {})
  }
}

async function sha256File(file) {
  const hash = createHash("sha256")
  const handle = await fs.open(file, "r")
  try {
    const buffer = Buffer.alloc(1024 * 1024)
    for (;;) {
      const result = await handle.read(buffer, 0, buffer.length, null)
      const count = typeof result === "number" ? result : result.bytesRead
      if (!count) break
      hash.update(buffer.subarray(0, count))
    }
  } finally {
    await handle.close()
  }
  return hash.digest("hex")
}

function configFiles(configDir) {
  const jsonc = join(configDir, "opencode.jsonc")
  return {
    server: existsSync(jsonc) ? jsonc : join(configDir, "opencode.json"),
    tui: join(configDir, "tui.json"),
    pointer: tuiCoordinationPath(configDir),
    deployment: deploymentRecordPath(configDir),
  }
}

function parseConfig(text) {
  const errors = []
  const value = parse(String(text ?? "").replace(/^\uFEFF/, "") || "{}", errors, { allowTrailingComma: true, disallowComments: false })
  return errors.length || !value || typeof value !== "object" || Array.isArray(value) ? null : value
}

function entrySpec(entry) {
  return String(Array.isArray(entry) ? entry[0] : entry ?? "")
}

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, "utf8")) } catch { return null }
}

async function configuredSpec(file) {
  try {
    const data = parseConfig(await fs.readFile(file, "utf8"))
    if (!data) return { valid: false, spec: null }
    const managed = (Array.isArray(data.plugin) ? data.plugin : []).map(entrySpec).find((spec) => spec.toLowerCase().includes(PACKAGE_NAME)) ?? null
    return { valid: true, spec: managed }
  } catch (error) {
    return { valid: error?.code === "ENOENT", spec: null }
  }
}

function packageRootFromSpec(spec, role) {
  if (typeof spec !== "string" || !spec.startsWith("file:")) return null
  try {
    const file = resolve(fileURLToPath(spec))
    return role === "server" ? dirname(file) : resolve(file, "..", "..", "..")
  } catch {
    return null
  }
}

export async function discoverConfiguredDeployment(options = {}) {
  const configDir = resolve(options.configDir ?? openCodeConfigDir(options.env))
  const files = configFiles(configDir)
  const [server, tui] = await Promise.all([configuredSpec(files.server), configuredSpec(files.tui)])
  const serverRoot = packageRootFromSpec(server.spec, "server")
  const tuiRoot = packageRootFromSpec(tui.spec, "tui")
  if (!server.valid || !tui.valid || !serverRoot || !tuiRoot || normalize(serverRoot) !== normalize(tuiRoot)) {
    return { valid: false, reason: "configured-server-tui-roots-do-not-match", serverSpec: server.spec, tuiSpec: tui.spec }
  }
  const validation = await validateGeneration(serverRoot)
  if (!validation.valid) return { valid: false, reason: validation.reason, root: serverRoot }
  return { valid: true, root: serverRoot, validation }
}

export async function readDeployment(options = {}) {
  const configDir = resolve(options.configDir ?? openCodeConfigDir(options.env))
  return readJson(deploymentRecordPath(configDir))
}

export async function writeHostDeployment(packageRoot, state, options = {}) {
  const configDir = resolve(options.configDir ?? openCodeConfigDir(options.env))
  const file = deploymentRecordPath(configDir)
  const record = await readJson(file)
  if (!record?.desired?.root || normalize(record.desired.root) !== normalize(packageRoot)) return { changed: false, skipped: "different-deployment" }
  const artifact = state?.patchedPath ? await readJson(`${state.patchedPath}.manifest.json`) : null
  const host = {
    policy: "exact-compatible-profile",
    version: state?.version ?? null,
    profile: state?.compatibilityProfile ?? artifact?.profileVersion ?? null,
    manifestSha256: state?.manifestSha256 ?? artifact?.manifestSha256 ?? null,
    binaryPath: state?.binaryPath ?? null,
    expectedSha256: state?.patchedSha256 ?? null,
  }
  const next = { ...record, desired: { ...record.desired, host }, updatedAt: new Date().toISOString() }
  if (JSON.stringify(record.desired.host ?? null) === JSON.stringify(host)) return { changed: false, record }
  await atomicWrite(file, `${JSON.stringify(next, null, 2)}\n`)
  return { changed: true, record: next }
}

export async function deploymentStatus(options = {}) {
  const configDir = resolve(options.configDir ?? openCodeConfigDir(options.env))
  const files = configFiles(configDir)
  const record = await readJson(files.deployment)
  const desired = record?.desired ?? null
  const checks = []
  const add = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail })
  add("canonical deployment record", record?.authority === "opencode-optimised-toolings-control-plane" && desired?.package === PACKAGE_NAME, files.deployment)

  let generation = null
  if (desired?.root && desired?.version) generation = await validateGeneration(desired.root, desired.version)
  add("desired package root", generation?.valid === true, generation?.valid ? desired.root : generation?.reason ?? "missing desired deployment")

  const [server, tui, pointer] = await Promise.all([configuredSpec(files.server), configuredSpec(files.tui), readJson(files.pointer)])
  add("server config derived", server.valid && server.spec === desired?.serverSpec, server.spec ?? "missing")
  add("TUI config derived", tui.valid && tui.spec === desired?.tuiSpec, tui.spec ?? "missing")
  add("coordination pointer derived", pointer?.spec === desired?.tuiSpec && (!desired?.root || normalize(pointer?.generation) === normalize(desired.root)), pointer?.spec ?? "missing")

  const state = desired?.root ? await readJson(join(runtimeRootForPackage(desired.root, options.env), "selfpatch-state.json")) : null
  let actualSha256 = null
  if (state?.binaryPath && existsSync(state.binaryPath)) actualSha256 = await sha256File(state.binaryPath).catch(() => null)
  const expectedSha256 = desired?.host?.expectedSha256 ?? state?.patchedSha256 ?? null
  const hostPortable = ["portable", "unsupported-version", "dev-mode", "idle"].includes(state?.status)
  const hostExact = expectedSha256 ? actualSha256 === expectedSha256 : hostPortable || !state
  add("host runtime reconciled", hostExact, expectedSha256 ? `${actualSha256 ?? "missing"} expected ${expectedSha256}` : state?.status ?? "pending first controller observation")

  return { ok: checks.every((check) => check.ok), configDir, desired, files, checks, host: { state, actualSha256, expectedSha256 } }
}

export async function reconcileDeployment(packageRoot, options = {}) {
  const root = resolve(packageRoot)
  const generation = options.generation ?? await ensurePackageGeneration(root, options)
  // Host preparation happens before the desired generation becomes active. A
  // failed optional enhancement therefore cannot leave package pointers moved
  // to a deployment whose host boundary was never examined.
  let host = null
  if (typeof options.reconcileHost === "function") host = await options.reconcileHost(generation.root)
  const activation = await activatePackageGeneration(generation, options)
  if (typeof options.reconcileHost === "function") {
    const state = await readJson(join(runtimeRootForPackage(generation.root, options.env), "selfpatch-state.json"))
    if (state) await writeHostDeployment(generation.root, state, options)
  }
  const status = await deploymentStatus(options)
  return { generation, activation, host, status }
}

export async function developmentDeployment(packageRoot, options = {}) {
  const root = resolve(packageRoot)
  const attestation = await runtimeAttestation(root, { role: "deployment" })
  const generation = {
    valid: true,
    root,
    version: packageVersion(root),
    fingerprint: attestation.sourceFingerprint,
    specs: generationSpecs(root),
    development: true,
  }
  return reconcileDeployment(root, { ...options, generation })
}

export function deploymentSummary(status) {
  const lines = [`Deployment: ${status.ok ? "consistent" : "DRIFTED"}`, `Desired: ${status.desired ? `v${status.desired.version} · ${status.desired.root}` : "not declared"}`]
  for (const check of status.checks) lines.push(`- [${check.ok ? "PASS" : "FAIL"}] ${check.name}: ${check.detail}`)
  return lines.join("\n")
}
