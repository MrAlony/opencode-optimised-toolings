import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const PACKAGE_NAME = "opencode-optimised-toolings"
export const PACKAGE_SPEC = `${PACKAGE_NAME}@latest`

export function packageRootFrom(importMetaUrl) {
  let current = dirname(fileURLToPath(importMetaUrl))
  for (let depth = 0; depth < 10; depth += 1) {
    try {
      const packageFile = join(current, "package.json")
      if (existsSync(packageFile)) return current
    } catch {}
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return dirname(fileURLToPath(importMetaUrl))
}

export function isDevelopmentCheckout(root) {
  if (process.env.OPENCODE_TOOLINGS_PACKAGE_MODE === "installed") return false
  if (process.env.OPENCODE_TOOLINGS_PACKAGE_MODE === "development") return true
  // npm-installed plugins live below node_modules. All other roots (a clone,
  // linked checkout, or isolated test fixture) keep their own runtime unless an
  // explicit user data directory was supplied.
  return !String(root ?? "").replaceAll("\\", "/").toLowerCase().includes("/node_modules/")
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
