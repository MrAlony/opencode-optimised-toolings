import { createHash, randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { promises as fs } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"
import { parse } from "jsonc-parser"
import {
  activatePackageGeneration,
  deploymentRecordPath,
  ensurePackageGeneration,
  generationSpecs,
  liveRuntimeProcesses,
  packageFingerprint,
  publicPackageSpecs,
  runtimeAttestation,
  tuiCoordinationPath,
  validateGeneration,
} from "./generation.js"
import { PACKAGE_NAME, PACKAGE_SPEC, openCodeConfigDir, packageVersion, runtimeRootForPackage } from "./paths.js"

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

function openCodePackageCacheRoot(env = process.env) {
  return resolve(env.OPENCODE_PACKAGE_CACHE_DIR || join(homedir(), ".cache", "opencode", "packages"))
}

function packageCachePaths(spec, env = process.env) {
  const root = join(openCodePackageCacheRoot(env), spec)
  return {
    root,
    wrapper: join(root, "package.json"),
    installedRoot: join(root, "node_modules", PACKAGE_NAME),
    marker: join(root, ".alonix-cache-authority.json"),
  }
}

async function cachedPackageAuthority(spec, desired, env = process.env) {
  if (spec !== PACKAGE_SPEC) return null
  const paths = packageCachePaths(spec, env)
  const [wrapper, installed, marker] = await Promise.all([
    readJson(paths.wrapper),
    readJson(join(paths.installedRoot, "package.json")),
    readJson(paths.marker),
  ])
  const pinned = wrapper?.dependencies?.[PACKAGE_NAME]
  const version = typeof installed?.version === "string" ? installed.version : null
  let fingerprint = null
  if (desired?.version === version && marker?.version === desired.version && marker?.fingerprint === desired?.fingerprint) {
    fingerprint = await packageFingerprint(paths.installedRoot).catch(() => null)
  }
  return {
    ...paths,
    pinned: typeof pinned === "string" ? pinned : null,
    installed: version,
    fingerprint,
    exact: pinned === desired?.version && version === desired?.version && fingerprint === desired?.fingerprint,
  }
}

export async function reconcileOpenCodePackageCache(generation, options = {}) {
  if (!generation?.valid || !generation?.root || !generation?.version || !generation?.fingerprint) {
    throw new Error("Cannot reconcile OpenCode package cache from an unverified generation")
  }
  const spec = options.spec ?? PACKAGE_SPEC
  if (spec !== PACKAGE_SPEC) return { changed: false, skipped: "not-public-latest-spec" }
  const before = await cachedPackageAuthority(spec, generation, options.env)
  if (before?.exact) return { changed: false, root: before.root, version: generation.version, fingerprint: generation.fingerprint }

  const paths = packageCachePaths(spec, options.env)
  const parent = dirname(paths.root)
  const stage = `${paths.root}.alonix-stage-${process.pid}-${randomUUID()}`
  const backup = `${paths.root}.alonix-backup-${process.pid}-${randomUUID()}`
  await fs.mkdir(join(stage, "node_modules"), { recursive: true })
  try {
    await fs.cp(generation.root, join(stage, "node_modules", PACKAGE_NAME), { recursive: true, force: true, errorOnExist: false })
    const stagedRoot = join(stage, "node_modules", PACKAGE_NAME)
    const [manifest, fingerprint] = await Promise.all([
      readJson(join(stagedRoot, "package.json")),
      packageFingerprint(stagedRoot),
    ])
    if (manifest?.name !== PACKAGE_NAME || manifest?.version !== generation.version || fingerprint !== generation.fingerprint) {
      throw new Error(`OpenCode cache staging attestation failed for ${PACKAGE_NAME}@${generation.version}`)
    }
    await fs.writeFile(join(stage, "package.json"), `${JSON.stringify({ dependencies: { [PACKAGE_NAME]: generation.version } }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
    await fs.writeFile(join(stage, ".alonix-cache-authority.json"), `${JSON.stringify({ schemaVersion: 1, package: PACKAGE_NAME, version: generation.version, fingerprint: generation.fingerprint, generation: resolve(generation.root), updatedAt: new Date().toISOString() }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })

    let movedPrevious = false
    try {
      if (existsSync(paths.root)) {
        await fs.rm(backup, { recursive: true, force: true })
        await fs.rename(paths.root, backup)
        movedPrevious = true
      }
      await fs.rename(stage, paths.root)
      if (movedPrevious) await fs.rm(backup, { recursive: true, force: true }).catch(() => {})
    } catch (error) {
      await fs.rm(paths.root, { recursive: true, force: true }).catch(() => {})
      if (movedPrevious && existsSync(backup)) await fs.rename(backup, paths.root).catch(() => {})
      throw error
    }
  } finally {
    await fs.rm(stage, { recursive: true, force: true }).catch(() => {})
    await fs.rm(backup, { recursive: true, force: true }).catch(() => {})
  }
  const after = await cachedPackageAuthority(spec, generation, options.env)
  if (!after?.exact) throw new Error(`OpenCode cache reconciliation did not produce an exact ${PACKAGE_NAME}@${generation.version} fallback`)
  return { changed: true, root: after.root, version: generation.version, fingerprint: generation.fingerprint }
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
  const expectedTuiConfigSpec = Object.hasOwn(desired ?? {}, "tuiConfigSpec") ? desired.tuiConfigSpec : desired?.tuiSpec
  add("TUI config derived", tui.valid && tui.spec === expectedTuiConfigSpec, tui.spec ?? (expectedTuiConfigSpec === null ? "not declared (server package bridge)" : "missing"))
  add("coordination pointer derived", pointer?.spec === desired?.tuiSpec && (!desired?.root || normalize(pointer?.generation) === normalize(desired.root)), pointer?.spec ?? "missing")

  const cache = await cachedPackageAuthority(desired?.serverSpec, desired, options.env)
  const canonicalHostBridge = desired?.serverSpec !== PACKAGE_SPEC || Boolean(desired?.host?.manifestSha256)
  const exactCacheFallback = cache?.exact === true
  add(
    "runtime package authority",
    canonicalHostBridge || exactCacheFallback,
    exactCacheFallback
      ? `OpenCode @latest cache mirrors canonical generation v${desired?.version}`
      : cache?.installed && cache.installed !== desired?.version
        ? `canonical generation v${desired?.version} overrides stale OpenCode cache v${cache.installed}`
        : canonicalHostBridge ? "canonical immutable generation" : "host bridge and cache fallback are not yet attested",
  )

  const state = desired?.root ? await readJson(join(runtimeRootForPackage(desired.root, options.env), "selfpatch-state.json")) : null
  let actualSha256 = null
  if (state?.binaryPath && existsSync(state.binaryPath)) actualSha256 = await sha256File(state.binaryPath).catch(() => null)
  const expectedSha256 = desired?.host?.expectedSha256 ?? state?.patchedSha256 ?? null
  const hostPortable = ["portable", "unsupported-version", "dev-mode", "idle"].includes(state?.status)
  const hostExact = expectedSha256 ? actualSha256 === expectedSha256 : hostPortable || !state
  add("host runtime reconciled", hostExact, expectedSha256 ? `${actualSha256 ?? "missing"} expected ${expectedSha256}` : state?.status ?? "pending first controller observation")

  const live = liveRuntimeProcesses(options.env, { pidAlive: options.pidAlive })
  const stale = live.filter((item) => {
    const records = [item.server, item.tui].filter(Boolean)
    return records.some((record) => normalize(record.root) !== normalize(desired?.root) || (desired?.fingerprint && record.sourceFingerprint !== desired.fingerprint))
  })
  const matching = live.filter((item) => !stale.includes(item) && (item.server || item.tui))
  const liveDetail = stale.length
    ? stale.map((item) => {
        const roots = [...new Set([item.server?.root, item.tui?.root].filter(Boolean))]
        return `pid ${item.pid} loaded ${roots.join(" + ") || "unknown root"}`
      }).join("; ")
    : matching.length
      ? `${matching.length} live process${matching.length === 1 ? "" : "es"} loaded desired generation`
      : "no live Alonix process observed"
  add("live plugin generation", stale.length === 0, liveDetail)

  return { ok: checks.every((check) => check.ok), configDir, desired, files, checks, host: { state, actualSha256, expectedSha256 }, runtime: { live, stale, matching } }
}

export async function reconcileDeployment(packageRoot, options = {}) {
  const root = resolve(packageRoot)
  const generation = options.generation ?? await ensurePackageGeneration(root, options)
  const configSpecs = options.publicPackage === true ? publicPackageSpecs() : options.configSpecs ?? generation.specs
  // Host preparation happens before the desired generation becomes active. A
  // failed optional enhancement therefore cannot leave package pointers moved
  // to a deployment whose host boundary was never examined.
  let host = null
  if (typeof options.reconcileHost === "function") host = await options.reconcileHost(generation.root)
  // The verified fallback cache must exist before the public @latest declaration
  // becomes active. If cache staging fails, user configuration remains on the
  // previous deployment and cannot expose stale OpenCode package bytes.
  const cache = configSpecs.server === PACKAGE_SPEC
    ? await reconcileOpenCodePackageCache(generation, { ...options, spec: configSpecs.server })
    : null
  const activation = await activatePackageGeneration(generation, { ...options, configSpecs })
  if (typeof options.reconcileHost === "function") {
    const state = await readJson(join(runtimeRootForPackage(generation.root, options.env), "selfpatch-state.json"))
    if (state) await writeHostDeployment(generation.root, state, options)
  }
  const status = await deploymentStatus(options)
  return { generation, activation, cache, host, status }
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
