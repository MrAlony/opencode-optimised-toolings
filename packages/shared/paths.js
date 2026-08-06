import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const PACKAGE_NAME = "opencode-optimised-toolings"
export const PACKAGE_SPEC = `${PACKAGE_NAME}@latest`

export function packageVersion(packageRoot) {
  try {
    const data = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"))
    return typeof data?.version === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(data.version)
      ? data.version
      : null
  } catch {
    return null
  }
}

export function installedPackageSpec(packageRoot) {
  const version = packageVersion(packageRoot)
  return version ? `${PACKAGE_NAME}@${version}` : PACKAGE_SPEC
}

export function packageRootFrom(importMetaUrl) {
  const entryDirectory = dirname(fileURLToPath(importMetaUrl))
  let current = entryDirectory
  let nearestPackage = null
  for (let depth = 0; depth < 12; depth += 1) {
    try {
      const packageFile = join(current, "package.json")
      if (existsSync(packageFile)) {
        nearestPackage ??= current
        const data = JSON.parse(readFileSync(packageFile, "utf8"))
        if (data?.name === PACKAGE_NAME) return current
      }
    } catch {}
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return nearestPackage ?? entryDirectory
}

export function isDevelopmentCheckout(root) {
  if (process.env.OPENCODE_TOOLINGS_PACKAGE_MODE === "installed") return false
  if (process.env.OPENCODE_TOOLINGS_PACKAGE_MODE === "development") return true
  const value = resolve(String(root ?? ""))
  // Immutable generations intentionally keep executable TSX source outside
  // node_modules so OpenCode's OpenTUI/Solid transform can process it. Their
  // parent marker is the authoritative installed-runtime identity.
  if (existsSync(join(dirname(value), ".alonix-generation.json"))) return false
  // npm-installed transport packages live below node_modules. All other roots
  // (a clone, linked checkout, or isolated test fixture) keep their own runtime
  // unless an explicit user data directory was supplied.
  return !value.replaceAll("\\", "/").toLowerCase().includes("/node_modules/")
}

export function openCodeConfigDir(env = process.env) {
  return resolve(env.OPENCODE_CONFIG_DIR || join(homedir(), ".config", "opencode"))
}

export function userDataRoot(env = process.env) {
  return resolve(env.OPENCODE_TOOLINGS_DATA_DIR || join(openCodeConfigDir(env), "alonix", "runtime"))
}

export function runtimeRootForPackage(packageRoot, env = process.env) {
  return isDevelopmentCheckout(packageRoot) && !env.OPENCODE_TOOLINGS_DATA_DIR
    ? join(packageRoot, "runtime")
    : userDataRoot(env)
}

export function packageFileUrl(importMetaUrl) {
  return fileURLToPath(importMetaUrl)
}
