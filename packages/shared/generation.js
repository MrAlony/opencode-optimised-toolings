import { createHash, randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs"
import { promises as fs } from "node:fs"
import { createRequire } from "node:module"
import { basename, delimiter, dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { applyEdits, modify, parse, printParseErrorCode } from "jsonc-parser"
import { PACKAGE_NAME, isDevelopmentCheckout, openCodeConfigDir, packageVersion, userDataRoot } from "./paths.js"

const LOCK_STALE_MS = 5 * 60_000
const LOCK_WAIT_MS = 30_000
const GENERATION_MARKER = ".alonix-generation.json"
const PRESERVE_MARKER = ".alonix-preserve-file-spec"

function normalize(value) {
  const result = resolve(String(value ?? ""))
  return process.platform === "win32" ? result.toLowerCase() : result
}

export function generationsRoot(env = process.env) {
  return resolve(env.OPENCODE_TOOLINGS_GENERATIONS_DIR || join(userDataRoot(env), "generations"))
}

export function generationDirectory(version, env = process.env, fingerprint = null) {
  return join(generationsRoot(env), `v${version}${fingerprint ? `--${fingerprint.slice(0, 16)}` : ""}`)
}

export function generationPackageRoot(version, env = process.env, fingerprint = null) {
  return join(generationDirectory(version, env, fingerprint), PACKAGE_NAME)
}

export async function packageFingerprint(packageRoot) {
  const root = resolve(packageRoot)
  const hash = createHash("sha256")
  const manifest = JSON.parse(await fs.readFile(join(root, "package.json"), "utf8"))
  const selected = Array.isArray(manifest.files) && manifest.files.length
    ? ["package.json", ...manifest.files]
    : ["."]
  const visited = new Set()
  async function visit(file, relative) {
    const normalizedRelative = String(relative).replaceAll("\\", "/").replace(/^\.\//, "")
    if (visited.has(normalizedRelative) || normalizedRelative.split("/").some((part) => ["node_modules", "runtime", "test", ".git"].includes(part))) return
    visited.add(normalizedRelative)
    let stat
    try { stat = await fs.stat(file) } catch { return }
    if (stat.isDirectory()) {
      const entries = await fs.readdir(file, { withFileTypes: true })
      entries.sort((a, b) => a.name.localeCompare(b.name))
      for (const entry of entries) await visit(join(file, entry.name), normalizedRelative === "." ? entry.name : `${normalizedRelative}/${entry.name}`)
      return
    }
    if (!stat.isFile() || basename(file) === PRESERVE_MARKER || basename(file) === GENERATION_MARKER) return
    hash.update(normalizedRelative)
    hash.update("\0")
    hash.update(await fs.readFile(file))
    hash.update("\0")
  }
  for (const relative of selected) await visit(resolve(root, relative), relative)
  return hash.digest("hex")
}

export function generationSpecs(packageRoot) {
  return {
    server: pathToFileURL(join(packageRoot, "index.js")).href,
    tui: pathToFileURL(join(packageRoot, "packages", "tui", "index.tsx")).href,
  }
}

function withoutBom(text) {
  return String(text ?? "").replace(/^\uFEFF/, "")
}

function parseDocument(text, label) {
  const errors = []
  const data = parse(withoutBom(text) || "{}", errors, { allowTrailingComma: true, disallowComments: false })
  if (errors.length) {
    const detail = errors.slice(0, 3).map((item) => `${printParseErrorCode(item.error)} at ${item.offset}`).join(", ")
    throw new Error(`${label} is not valid JSON/JSONC (${detail})`)
  }
  return data && typeof data === "object" && !Array.isArray(data) ? data : {}
}

function setJsonc(text, path, value) {
  const bom = String(text ?? "").startsWith("\uFEFF") ? "\uFEFF" : ""
  const body = withoutBom(text)
  const eol = body.includes("\r\n") ? "\r\n" : "\n"
  return `${bom}${applyEdits(body, modify(body, path, value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol } }))}`
}

function entrySpec(entry) {
  return String(Array.isArray(entry) ? entry[0] : entry ?? "")
}

function isManagedEntry(entry) {
  const spec = entrySpec(entry).replaceAll("\\", "/")
  return new RegExp(`^(?:npm:)?${PACKAGE_NAME}(?:@|$)`, "i").test(spec)
    || spec.toLowerCase().includes(`/${PACKAGE_NAME.toLowerCase()}/index.js`)
    || spec.toLowerCase().includes(`/${PACKAGE_NAME.toLowerCase()}/packages/tui/index.tsx`)
    || spec.toLowerCase().includes("/alonix/runtime/tui-loader.mjs")
}

function generationVersionFromSpec(value) {
  const normalized = String(value ?? "").replaceAll("\\", "/")
  const match = /\/generations\/v([^/]+)\/opencode-optimised-toolings\//i.exec(normalized)
  if (!match) return null
  const version = match[1].replace(/--[a-f0-9]{16}$/i, "")
  return versionParts(version) ? version : null
}

function versionParts(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(value ?? ""))
  return match ? { numbers: match.slice(1, 4).map(Number), prerelease: match[4] ?? "" } : null
}

function compareVersions(left, right) {
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

function replaceManaged(list, spec) {
  const output = []
  let inserted = false
  for (const entry of Array.isArray(list) ? list : []) {
    if (!isManagedEntry(entry)) {
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

async function atomicWrite(file, text) {
  await fs.mkdir(dirname(file), { recursive: true })
  const temporary = join(dirname(file), `.${basename(file)}.${process.pid}.${randomUUID()}.tmp`)
  await fs.writeFile(temporary, text, { encoding: "utf8", mode: 0o600 })
  await fs.rename(temporary, file)
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
      } catch {}
      if (!pidAlive(owner?.pid) || age > LOCK_STALE_MS) {
        await fs.rm(file, { force: true }).catch(() => {})
        continue
      }
      if (Date.now() >= deadline) throw new Error(`Package generation lock is held by pid ${owner.pid}`)
      await new Promise((done) => setTimeout(done, 100))
    }
  }
}

function resolveDependencyManifest(issuerRoot, name) {
  const require = createRequire(pathToFileURL(join(issuerRoot, "package.json")))
  // Package exports may deliberately hide package.json and even omit a root
  // export (as @opencode-ai/plugin does). Node's lookup roots still identify
  // the exact installed package without bypassing normal resolution order.
  for (const base of require.resolve.paths(name) ?? []) {
    const file = join(base, name, "package.json")
    try {
      const data = JSON.parse(readFileSync(file, "utf8"))
      if (data?.name === name) return { data, manifest: resolve(file), entry: resolve(file), root: dirname(file) }
    } catch {}
  }
  let entry
  try { entry = require.resolve(`${name}/package.json`) }
  catch { entry = require.resolve(name) }
  let directory = dirname(entry)
  for (let depth = 0; depth < 12; depth += 1) {
    try {
      const file = join(directory, "package.json")
      const data = JSON.parse(readFileSync(file, "utf8"))
      if (data?.name === name) return { data, manifest: resolve(file), entry: resolve(entry), root: directory }
    } catch {}
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  throw new Error(`Cannot resolve the package manifest for ${name} from ${issuerRoot}`)
}

export function dependencyAttestation(packageRoot) {
  const root = resolve(packageRoot)
  const rootManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
  const queue = Object.keys(rootManifest.dependencies ?? {}).sort().map((name) => ({ issuer: root, name, direct: true }))
  const visited = new Set()
  const graph = []
  const dependencies = {}
  while (queue.length) {
    const item = queue.shift()
    try {
      const found = resolveDependencyManifest(item.issuer, item.name)
      const identity = `${found.data.name}@${found.data.version ?? "unknown"}`
      if (item.direct) dependencies[item.name] = { version: found.data.version ?? null, manifest: found.manifest, entry: found.entry }
      if (visited.has(identity)) continue
      visited.add(identity)
      graph.push(identity)
      for (const child of Object.keys(found.data.dependencies ?? {}).sort()) queue.push({ issuer: found.root, name: child, direct: false })
    } catch (error) {
      const identity = `${item.name}@unresolved`
      if (item.direct) dependencies[item.name] = { version: null, error: error?.message ?? String(error) }
      if (!visited.has(identity)) { visited.add(identity); graph.push(identity) }
    }
  }
  graph.sort()
  if (graph.some((identity) => identity.endsWith("@unresolved"))) {
    throw new Error(`Required runtime dependency graph is incomplete: ${graph.filter((identity) => identity.endsWith("@unresolved")).join(", ")}`)
  }
  const fingerprint = createHash("sha256").update(JSON.stringify(graph)).digest("hex")
  return { fingerprint, graph, dependencies }
}

export function directDependencyAttestation(packageRoot) {
  const root = resolve(packageRoot)
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
  const expected = Object.fromEntries(Object.entries(manifest.dependencies ?? {}).sort(([left], [right]) => left.localeCompare(right)))
  const actual = dependencyAttestation(root).dependencies
  const mismatches = []
  for (const [name, version] of Object.entries(expected)) {
    const resolved = actual[name]?.version ?? null
    if (resolved !== version) mismatches.push({ name, expected: version, actual: resolved })
  }
  const graph = Object.entries(actual).sort(([left], [right]) => left.localeCompare(right)).map(([name, detail]) => `${name}@${detail.version ?? "unresolved"}`)
  return {
    matchesExpected: mismatches.length === 0,
    expected,
    actual: Object.fromEntries(Object.entries(actual).sort(([left], [right]) => left.localeCompare(right)).map(([name, detail]) => [name, detail.version ?? null])),
    mismatches,
    fingerprint: createHash("sha256").update(JSON.stringify(graph)).digest("hex"),
  }
}

function expectedDependencyAttestation(packageRoot) {
  try {
    const data = JSON.parse(readFileSync(join(packageRoot, "config", "runtime-dependencies.json"), "utf8"))
    return Array.isArray(data?.graph) && typeof data?.fingerprint === "string" ? data : null
  } catch {
    return null
  }
}

export async function runtimeAttestation(packageRoot, options = {}) {
  const root = resolve(packageRoot)
  const version = packageVersion(root)
  const sourceFingerprint = await packageFingerprint(root)
  const dependencies = dependencyAttestation(root)
  const directDependencies = directDependencyAttestation(root)
  const expectedDependencies = expectedDependencyAttestation(root)
  const dependencyMatchesExpected = expectedDependencies ? expectedDependencies.fingerprint === dependencies.fingerprint : null
  let marker = null
  try { marker = JSON.parse(await fs.readFile(join(generationRootForPackage(root) ?? dirname(root), GENERATION_MARKER), "utf8")) } catch {}
  const sourceMatchesMarker = marker?.fingerprint ? marker.fingerprint === sourceFingerprint : null
  return {
    name: PACKAGE_NAME,
    version,
    root,
    sourceFingerprint,
    expectedSourceFingerprint: marker?.fingerprint ?? null,
    sourceMatchesMarker,
    dependencyFingerprint: dependencies.fingerprint,
    dependencyGraph: dependencies.graph,
    expectedDependencyFingerprint: expectedDependencies?.fingerprint ?? null,
    dependencyMatchesExpected,
    dependencies: dependencies.dependencies,
    directDependencyFingerprint: directDependencies.fingerprint,
    directDependencyMatchesExpected: directDependencies.matchesExpected,
    directDependencyMismatches: directDependencies.mismatches,
    role: options.role ?? "unknown",
  }
}

export async function validateGeneration(packageRoot, expectedVersion = null, options = {}) {
  const root = resolve(packageRoot)
  try {
    const data = JSON.parse(await fs.readFile(join(root, "package.json"), "utf8"))
    if (data?.name !== PACKAGE_NAME) return { valid: false, reason: "wrong-package-name", root }
    if (expectedVersion && data.version !== expectedVersion) return { valid: false, reason: "wrong-package-version", root, version: data.version }
    for (const relative of ["index.js", join("packages", "tui", "index.tsx"), join("packages", "tui", "package.json"), join("packages", "cbm", "dist", "index.js")]) {
      const file = resolve(root, relative)
      if (!normalize(file).startsWith(`${normalize(root)}${process.platform === "win32" ? "\\" : "/"}`) || !existsSync(file)) {
        return { valid: false, reason: `missing-${relative.replaceAll("\\", "-").replaceAll("/", "-")}`, root }
      }
    }
    if (options.verifyMarker !== false) {
      const attestation = await runtimeAttestation(root, { role: "validation" })
      if (attestation.expectedSourceFingerprint && attestation.sourceMatchesMarker !== true) {
        return { valid: false, reason: "generation-fingerprint-mismatch", root, version: data.version, attestation }
      }
      if (attestation.dependencyMatchesExpected === false) {
        return { valid: false, reason: "generation-dependency-mismatch", root, version: data.version, attestation }
      }
    }
    return { valid: true, root, version: data.version, specs: generationSpecs(root) }
  } catch (error) {
    return { valid: false, reason: "invalid-generation", root, error: error?.message ?? String(error) }
  }
}

function installationRoot(packageRoot) {
  const root = resolve(packageRoot)
  const nodeModules = dirname(root)
  if (basename(nodeModules).toLowerCase() !== "node_modules" || basename(root).toLowerCase() !== PACKAGE_NAME) return null
  return dirname(nodeModules)
}

function generationRootForPackage(packageRoot) {
  const root = resolve(packageRoot)
  const parent = dirname(root)
  if (basename(root).toLowerCase() === PACKAGE_NAME && /^v\d+\.\d+\.\d+(?:-[^/\\]+)?--[a-f0-9]{16}$/i.test(basename(parent))) return parent
  const installation = installationRoot(root)
  if (installation && /^v\d+\.\d+\.\d+(?:-[^/\\]+)?--[a-f0-9]{16}$/i.test(basename(installation))) return installation
  return null
}

async function copyPackageSource(packageRoot, destination) {
  await fs.mkdir(dirname(destination), { recursive: true })
  await fs.cp(packageRoot, destination, {
    recursive: true,
    force: false,
    errorOnExist: false,
    // The package source and its publishable shrinkwrap are authoritative.
    // Never inherit npm/OpenCode's ambient dependency tree.
    filter: (sourcePath) => basename(sourcePath) !== "node_modules" && !basename(sourcePath).startsWith(".alonix-generation-stage-"),
  })
}

async function copyCurrentInstallation(packageRoot, staging) {
  if (!installationRoot(packageRoot)) throw new Error("The loaded package is not inside a complete npm installation")
  await copyPackageSource(packageRoot, join(staging, PACKAGE_NAME))
}

async function materializeRegistryPackage(staging) {
  const downloaded = join(staging, "node_modules", PACKAGE_NAME)
  if (!existsSync(downloaded)) throw new Error(`Registry installation did not contain ${PACKAGE_NAME}`)
  const destination = join(staging, PACKAGE_NAME)
  await copyPackageSource(downloaded, destination)
  await Promise.all([
    fs.rm(join(staging, "node_modules"), { recursive: true, force: true }),
    fs.rm(join(staging, "package.json"), { force: true }),
    fs.rm(join(staging, "package-lock.json"), { force: true }),
  ])
}

function pathEntries(env = process.env) {
  return String(env.PATH ?? env.Path ?? "").split(delimiter).map((entry) => entry.trim().replace(/^"|"$/g, "")).filter(Boolean)
}

export function resolveNpmCommand(env = process.env) {
  const npmCandidates = [
    env.npm_execpath,
    ...pathEntries(env).map((entry) => join(entry, "node_modules", "npm", "bin", "npm-cli.js")),
    env.ProgramFiles && join(env.ProgramFiles, "nodejs", "node_modules", "npm", "bin", "npm-cli.js"),
    env["ProgramFiles(x86)"] && join(env["ProgramFiles(x86)"], "nodejs", "node_modules", "npm", "bin", "npm-cli.js"),
    process.platform === "win32" ? "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js" : "/usr/local/lib/node_modules/npm/bin/npm-cli.js",
    process.platform === "win32" ? "C:\\Program Files (x86)\\nodejs\\node_modules\\npm\\bin\\npm-cli.js" : "/usr/lib/node_modules/npm/bin/npm-cli.js",
  ].filter(Boolean)
  for (const npmCli of npmCandidates) {
    if (!existsSync(npmCli)) continue
    const nodeCandidates = [
      env.NODE_BINARY,
      env.NODE,
      ...pathEntries(env).map((entry) => join(entry, process.platform === "win32" ? "node.exe" : "node")),
      basename(process.execPath).toLowerCase().replace(/\.exe$/, "") === "node" ? process.execPath : null,
      resolve(dirname(dirname(dirname(dirname(npmCli)))), process.platform === "win32" ? "node.exe" : "bin/node"),
      env.ProgramFiles && join(env.ProgramFiles, "nodejs", "node.exe"),
      process.platform === "win32" ? "C:\\Program Files\\nodejs\\node.exe" : "/usr/bin/node",
      process.platform === "win32" ? null : "/usr/local/bin/node",
    ].filter(Boolean)
    const node = nodeCandidates.find((file) => existsSync(file))
    if (node) return { executable: node, args: [npmCli], npmCli }
  }
  if (process.platform !== "win32") return { executable: "npm", args: [], npmCli: null }
  throw new Error("Node.js npm runtime is unavailable for package generation provisioning")
}

function npmCommand() {
  return resolveNpmCommand(process.env)
}

async function installExactPackage(version, staging, options = {}) {
  if (typeof options.install === "function") return options.install(version, staging)
  await fs.mkdir(staging, { recursive: true })
  await fs.writeFile(join(staging, "package.json"), `${JSON.stringify({ private: true }, null, 2)}\n`, "utf8")
  const command = npmCommand()
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command.executable, [...command.args, "install", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", "--save-exact", `${PACKAGE_NAME}@${version}`], {
      cwd: staging,
      env: { ...process.env, NODE_AUTH_TOKEN: "", NPM_TOKEN: "", npm_config_provenance: "false" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })
    let output = ""
    child.stdout.on("data", (chunk) => { output = `${output}${chunk}`.slice(-16_000) })
    child.stderr.on("data", (chunk) => { output = `${output}${chunk}`.slice(-16_000) })
    child.once("error", reject)
    child.once("close", (code) => code === 0 ? resolvePromise() : reject(new Error(`npm could not provision ${PACKAGE_NAME}@${version} (exit ${code})\n${output}`)))
  })
}

async function installLockedDependencies(packageRoot, options = {}) {
  if (!existsSync(join(packageRoot, "npm-shrinkwrap.json"))) throw new Error("Package generation is missing npm-shrinkwrap.json")
  if (typeof options.installDependencies === "function") {
    await options.installDependencies(packageRoot)
  } else {
    const command = npmCommand()
    await new Promise((resolvePromise, reject) => {
      const child = spawn(command.executable, [...command.args, "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--workspaces=false"], {
        cwd: packageRoot,
        env: { ...process.env, NODE_AUTH_TOKEN: "", NPM_TOKEN: "", npm_config_provenance: "false" },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      })
      let output = ""
      child.stdout.on("data", (chunk) => { output = `${output}${chunk}`.slice(-16_000) })
      child.stderr.on("data", (chunk) => { output = `${output}${chunk}`.slice(-16_000) })
      child.once("error", reject)
      child.once("close", (code) => code === 0 ? resolvePromise() : reject(new Error(`npm could not install the locked Alonix runtime dependencies (exit ${code})\n${output}`)))
    })
  }
  const attestation = await runtimeAttestation(packageRoot, { role: "provisioning" })
  if (attestation.dependencyMatchesExpected !== true) {
    throw new Error(`Provisioned dependency graph does not match the packaged runtime attestation (${attestation.dependencyFingerprint} != ${attestation.expectedDependencyFingerprint ?? "missing"})`)
  }
}

const generationFlights = new Map()

async function ensurePackageGenerationImpl(packageRoot, options = {}) {
  const version = options.version ?? packageVersion(packageRoot)
  if (!version) throw new Error("Cannot provision an unknown package version")
  if (isDevelopmentCheckout(packageRoot) && options.force !== true) {
    const validation = await validateGeneration(packageRoot, version)
    if (!validation.valid) throw new Error(`Development package is incomplete: ${validation.reason}`)
    return { ...validation, created: false, development: true }
  }
  const base = generationsRoot(options.env)
  const sourceFingerprint = options.source === "registry" ? undefined : await packageFingerprint(packageRoot)
  if (sourceFingerprint) {
    const existingTarget = generationDirectory(version, options.env, sourceFingerprint)
    const existingPackage = generationPackageRoot(version, options.env, sourceFingerprint)
    const existing = await validateGeneration(existingPackage, version)
    if (existing.valid) return { ...existing, fingerprint: sourceFingerprint, created: false, directory: existingTarget }
  }

  await fs.mkdir(base, { recursive: true })
  const lock = join(base, ".generation.lock")
  await acquireLock(lock)
  try {
    if (sourceFingerprint) {
      const existingTarget = generationDirectory(version, options.env, sourceFingerprint)
      const existingPackage = generationPackageRoot(version, options.env, sourceFingerprint)
      const afterLock = await validateGeneration(existingPackage, version)
      if (afterLock.valid) return { ...afterLock, fingerprint: sourceFingerprint, created: false, directory: existingTarget }
    }

    const staging = join(base, `.alonix-generation-stage-${version}-${process.pid}-${randomUUID()}`)
    try {
      if (options.source === "registry") {
        await installExactPackage(version, staging, options)
        await materializeRegistryPackage(staging)
      } else {
        await copyCurrentInstallation(packageRoot, staging)
      }
      const stagedPackage = join(staging, PACKAGE_NAME)
      const validation = await validateGeneration(stagedPackage, version, { verifyMarker: false })
      if (!validation.valid) throw new Error(`Provisioned package generation is invalid: ${validation.reason}`)
      await installLockedDependencies(stagedPackage, options)

      // The immutable generation identity must come from the bytes that will
      // actually run. Registry updates therefore derive their target only
      // after the exact package has been downloaded into staging.
      const fingerprint = await packageFingerprint(stagedPackage)
      const target = generationDirectory(version, options.env, fingerprint)
      const targetPackage = generationPackageRoot(version, options.env, fingerprint)
      const existing = await validateGeneration(targetPackage, version)
      if (existing.valid) {
        await fs.rm(staging, { recursive: true, force: true })
        return { ...existing, fingerprint, created: false, directory: target }
      }
      if (existsSync(target)) await fs.rename(target, `${target}.invalid-${Date.now()}-${randomUUID()}`)

      await fs.writeFile(join(stagedPackage, PRESERVE_MARKER), "managed immutable generation\n", { encoding: "utf8", mode: 0o600 })
      await fs.writeFile(join(staging, GENERATION_MARKER), `${JSON.stringify({ name: PACKAGE_NAME, version, fingerprint, createdAt: new Date().toISOString(), source: options.source ?? "loaded-installation" }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
      await fs.rename(staging, target)
      const finalValidation = await validateGeneration(targetPackage, version)
      if (!finalValidation.valid) throw new Error(`Final package generation attestation failed: ${finalValidation.reason}`)
      return { ...finalValidation, fingerprint, root: targetPackage, specs: generationSpecs(targetPackage), created: true, directory: target }
    } catch (error) {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => {})
      throw error
    }
  } finally {
    await fs.rm(lock, { force: true }).catch(() => {})
  }
}

export function ensurePackageGeneration(packageRoot, options = {}) {
  const version = options.version ?? packageVersion(packageRoot) ?? "unknown"
  const key = `${normalize(packageRoot)}\u0000${version}\u0000${options.source ?? "loaded-installation"}\u0000${normalize(generationsRoot(options.env))}`
  if (!generationFlights.has(key)) {
    const flight = ensurePackageGenerationImpl(packageRoot, options)
    generationFlights.set(key, flight)
    void flight.finally(() => {
      if (generationFlights.get(key) === flight) generationFlights.delete(key)
    }).catch(() => {})
  }
  return generationFlights.get(key)
}

export async function validateActivationConfig(options = {}) {
  const configDir = resolve(options.configDir ?? openCodeConfigDir(options.env))
  const paths = configPaths(configDir)
  for (const [role, file] of Object.entries(paths)) {
    const source = existsSync(file) ? await fs.readFile(file, "utf8") : role === "tui" ? '{\n  "$schema": "https://opencode.ai/tui.json",\n  "plugin": []\n}\n' : "{}\n"
    parseDocument(source, basename(file))
  }
  return paths
}

function configPaths(configDir) {
  const jsonc = join(configDir, "opencode.jsonc")
  return {
    server: existsSync(jsonc) ? jsonc : join(configDir, "opencode.json"),
    tui: join(configDir, "tui.json"),
  }
}

export async function activatePackageGeneration(generation, options = {}) {
  if (!generation?.valid || !generation?.root || !generation?.specs) throw new Error("Cannot activate an unverified package generation")
  const configDir = resolve(options.configDir ?? openCodeConfigDir(options.env))
  const paths = configPaths(configDir)
  const documents = []
  let newestConfiguredVersion = null
  for (const [role, file] of Object.entries(paths)) {
    const before = existsSync(file) ? await fs.readFile(file, "utf8") : role === "tui" ? '{\n  "$schema": "https://opencode.ai/tui.json",\n  "plugin": []\n}\n' : "{}\n"
    const data = parseDocument(before, basename(file))
    for (const entry of Array.isArray(data.plugin) ? data.plugin : []) {
      const version = generationVersionFromSpec(entrySpec(entry))
      if (version && (!newestConfiguredVersion || compareVersions(version, newestConfiguredVersion) > 0)) newestConfiguredVersion = version
    }
    documents.push({ role, file, before, data })
  }
  if (newestConfiguredVersion && compareVersions(generation.version, newestConfiguredVersion) < 0) {
    return { changed: false, skipped: "newer-generation-configured", configuredVersion: newestConfiguredVersion, generation: generation.root, version: generation.version, files: [] }
  }
  const planned = []
  for (const { role, file, before, data } of documents) {
    const spec = role === "server" ? generation.specs.server : generation.specs.tui
    const after = setJsonc(before, ["plugin"], replaceManaged(data.plugin, spec))
    parseDocument(after, basename(file))
    if (after !== before) planned.push({ role, file, before, after })
  }
  if (!planned.length) return { changed: false, generation: generation.root, version: generation.version, files: [] }

  const backupDir = join(configDir, "alonix", "backups")
  await fs.mkdir(backupDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const applied = []
  try {
    for (const item of planned) {
      item.backup = join(backupDir, `${stamp}-generation-${basename(item.file)}`)
      await fs.writeFile(item.backup, item.before, { encoding: "utf8", mode: 0o600 })
      await atomicWrite(item.file, item.after)
      applied.push(item)
    }
  } catch (error) {
    for (const item of applied.reverse()) await atomicWrite(item.file, item.before).catch(() => {})
    throw error
  }
  return { changed: true, generation: generation.root, version: generation.version, restartRequired: true, files: planned.map((item) => item.file), backups: planned.map((item) => item.backup) }
}

export async function ensureAndActivateGeneration(packageRoot, options = {}) {
  const generation = await ensurePackageGeneration(packageRoot, options)
  const activation = await activatePackageGeneration(generation, options)
  return { generation, activation }
}

function writeRuntimeRecord(packageRoot, role, status, detail = {}, options = {}) {
  const runtime = userDataRoot(options.env)
  const file = options.file ?? join(runtime, `${role}-activation-${process.pid}.json`)
  const body = { status, role, pid: process.pid, at: new Date().toISOString(), root: resolve(packageRoot), ...detail }
  mkdirSync(dirname(file), { recursive: true })
  const temporary = join(dirname(file), `.${basename(file)}.${process.pid}.${randomUUID()}.tmp`)
  writeFileSync(temporary, `${JSON.stringify(body, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
  renameSync(temporary, file)
  return { file, lifecycle: body }
}

export function writeServerLifecycle(packageRoot, status, detail = {}, options = {}) {
  return writeRuntimeRecord(packageRoot, "server", status, detail, options)
}

export function writeTuiLifecycle(packageRoot, status, detail = {}, options = {}) {
  return writeRuntimeRecord(packageRoot, "tui", status, detail, options)
}

function newestRecord(role, env = process.env, expectedRoot = null) {
  const runtime = userDataRoot(env)
  if (!existsSync(runtime)) return null
  const prefix = `${role}-activation-`
  const expected = expectedRoot ? normalize(expectedRoot) : null
  let newest = null
  for (const name of readdirSync(runtime)) {
    if (!name.startsWith(prefix) || !name.endsWith(".json")) continue
    try {
      const value = JSON.parse(readFileSync(join(runtime, name), "utf8"))
      if (expected && normalize(value?.root) !== expected) continue
      const at = Date.parse(String(value?.at ?? ""))
      if (Number.isFinite(at) && (!newest || at > newest.atMs)) newest = { ...value, atMs: at, file: join(runtime, name) }
    } catch {}
  }
  return newest
}

export function runtimeHealth(env = process.env, expectedRoot = null) {
  // Health belongs to one immutable package generation. Unrelated test
  // consumers or older OpenCode generations may legitimately write newer
  // lifecycle files into the shared diagnostics directory; they must never be
  // paired with the TUI loaded from another root.
  const server = newestRecord("server", env, expectedRoot)
  const tui = newestRecord("tui", env, expectedRoot)
  const exact = Boolean(
    server && tui
    && server.status === "active"
    && tui.status === "active"
    && tui.stage === "complete"
    && server.version === tui.version
    && normalize(server.root) === normalize(tui.root)
    && server.sourceFingerprint === tui.sourceFingerprint
    && server.dependencyFingerprint === tui.dependencyFingerprint
    && server.sourceMatchesMarker !== false
    && tui.sourceMatchesMarker !== false
    && server.dependencyMatchesExpected !== false
    && tui.dependencyMatchesExpected !== false
  )
  return {
    exact,
    reason: exact ? "exact-runtime-parity" : !server ? "server-attestation-missing" : !tui ? "tui-attestation-missing" : "runtime-attestation-mismatch",
    server,
    tui,
  }
}
