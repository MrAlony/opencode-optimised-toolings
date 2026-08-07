import { randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"
import { promises as fs } from "node:fs"
import path from "node:path"
import { patchedBinaryPath, runtimeDir, sha256File } from "./state.js"

const CONTROLLER_SCHEMA_VERSION = 1

async function exists(file) {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

function normalize(value) {
  const resolved = path.resolve(String(value ?? ""))
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

function controllerFile(root) {
  return path.join(runtimeDir(root), "host-controller.json")
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"))
  } catch {
    return null
  }
}

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
    await fs.rename(temporary, file)
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {})
  }
}

function controllerIdentity(value) {
  if (!value || typeof value !== "object") return null
  if (typeof value.version !== "string" || typeof value.manifestSha256 !== "string" || typeof value.binaryPath !== "string") return null
  return `${value.version}\u0000${value.manifestSha256}\u0000${normalize(value.binaryPath)}`
}

function commandArguments(commandLine) {
  return String(commandLine ?? "").trim().split(/\s+/).map((part) => part.replace(/^['"]|['"]$/g, ""))
}

export function isDedicatedOpenCodeServer(candidate, options = {}) {
  const pid = Number(candidate?.pid ?? candidate?.ProcessId)
  const currentPid = Number(options.currentPid ?? process.pid)
  if (!Number.isInteger(pid) || pid <= 0 || pid === currentPid) return false
  const executable = candidate?.executablePath ?? candidate?.ExecutablePath
  if (!executable || normalize(executable) !== normalize(options.binaryPath)) return false
  const args = commandArguments(candidate?.commandLine ?? candidate?.CommandLine)
  const executableIndex = args.findIndex((part) => /(?:^|[\\/])opencode(?:\.exe)?$/i.test(part))
  return args.slice(executableIndex >= 0 ? executableIndex + 1 : 0).some((part) => part.toLowerCase() === "serve")
}

export function listOpenCodeProcessesWindows() {
  if (process.platform !== "win32") return []
  const script = [
    "$items = Get-CimInstance Win32_Process | Where-Object { $_.Name -ieq 'opencode.exe' } | ForEach-Object {",
    "  [pscustomobject]@{ pid = [int]$_.ProcessId; executablePath = $_.ExecutablePath; commandLine = $_.CommandLine }",
    "}",
    "$items | ConvertTo-Json -Compress",
  ].join("; ")
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  })
  if (result.error || result.status !== 0 || !String(result.stdout ?? "").trim()) return []
  try {
    const parsed = JSON.parse(result.stdout)
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    return []
  }
}

export function terminateProcess(pid) {
  try {
    process.kill(pid, "SIGTERM")
    return true
  } catch {
    return false
  }
}

async function quarantineMismatchedArtifact(root, version, manifestSha256) {
  const binary = patchedBinaryPath(root, version)
  const marker = `${binary}.manifest.json`
  const [hasBinary, hasMarker] = await Promise.all([exists(binary), exists(marker)])
  if (!hasBinary && !hasMarker) return { quarantined: false, files: [] }
  const metadata = await readJson(marker)
  if (hasBinary && metadata?.manifestSha256 === manifestSha256 && typeof metadata?.binarySha256 === "string") {
    const actualSha256 = await sha256File(binary).catch(() => null)
    if (actualSha256 === metadata.binarySha256) return { quarantined: false, files: [] }
  }

  const directory = path.join(runtimeDir(root), "quarantine", "host-artifacts", `${Date.now()}-${randomUUID()}`)
  await fs.mkdir(directory, { recursive: true })
  const files = []
  for (const source of [binary, marker]) {
    if (!(await exists(source))) continue
    const destination = path.join(directory, path.basename(source))
    await fs.rename(source, destination)
    files.push(destination)
  }
  await writeJsonAtomic(path.join(directory, "recovery.json"), {
    schemaVersion: 1,
    reason: "manifest-mismatch",
    expectedManifestSha256: manifestSha256,
    previousMarker: metadata,
    quarantinedAt: new Date().toISOString(),
  })
  return { quarantined: true, directory, files }
}

export async function reconcileHostRuntime(root, input, options = {}) {
  const current = {
    schemaVersion: CONTROLLER_SCHEMA_VERSION,
    version: input.version,
    manifestSha256: input.manifestSha256,
    binaryPath: path.resolve(input.binaryPath),
    updatedAt: new Date().toISOString(),
    pid: process.pid,
  }
  const file = options.controllerFile ?? controllerFile(root)
  const previous = await readJson(file)
  const artifact = await quarantineMismatchedArtifact(root, input.version, input.manifestSha256)
  const previousIdentity = controllerIdentity(previous)
  const changed = Boolean(previousIdentity && previousIdentity !== controllerIdentity(current))
  const firstClaim = !previousIdentity
  await writeJsonAtomic(file, current)

  // A controller file persists across normal launches. Its absence means this
  // runtime has never reconciled the currently configured host, so one existing
  // dedicated server may still carry pre-controller or withdrawn code in memory.
  // Retire that server once; interactive OpenCode processes are never selected.
  const shouldRetire = firstClaim || artifact.quarantined || changed
  const retired = []
  if (shouldRetire) {
    const listProcesses = options.listProcesses ?? listOpenCodeProcessesWindows
    const terminate = options.terminate ?? terminateProcess
    for (const candidate of await listProcesses()) {
      if (!isDedicatedOpenCodeServer(candidate, { binaryPath: input.binaryPath, currentPid: options.currentPid })) continue
      const pid = Number(candidate.pid ?? candidate.ProcessId)
      if (await terminate(pid)) retired.push(pid)
    }
  }
  return { controllerChanged: changed, firstClaim, artifact, retired }
}
