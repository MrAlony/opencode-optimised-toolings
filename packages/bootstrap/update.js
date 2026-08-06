import { isDevelopmentCheckout, packageVersion } from "../shared/paths.js"
import { activatePackageGeneration, ensurePackageGeneration, validateActivationConfig } from "../shared/generation.js"

const PACKAGE_NAME = "opencode-optimised-toolings"
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`
const CHECK_DELAY_MS = 1_500
const CHECK_TIMEOUT_MS = 5_000

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

  // Reject malformed destination config before any network or filesystem-heavy
  // provisioning work. A broken user file is never partially bypassed.
  await validateActivationConfig(options)

  // The complete next generation is installed and validated before either
  // config file is touched. Server and TUI then switch to direct files from the
  // same immutable root in one rollback-capable transaction.
  const generation = await ensurePackageGeneration(packageRoot, {
    ...options,
    version: latest,
    source: "registry",
  })
  const activation = await activatePackageGeneration(generation, options)
  return {
    changed: activation.changed,
    current,
    latest,
    generation: generation.root,
    serverSpec: generation.specs.server,
    tuiSpec: generation.specs.tui,
    restartRequired: activation.changed,
    files: activation.files,
    backups: activation.backups ?? [],
  }
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
