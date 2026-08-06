import { existsSync } from "node:fs"
import { delimiter, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { loadSecrets } from "../../web/lib/config.js"
import { runtimeRootForPackage } from "../../shared/paths.js"

export const packageRoot = resolve(fileURLToPath(new URL("../", import.meta.url)))
export const repositoryRoot = resolve(packageRoot, "../..")
export const runtimeRoot = resolve(runtimeRootForPackage(repositoryRoot), "stealth")

function executableCandidates(name) {
  const suffixes = process.platform === "win32" ? [`.exe`, `.cmd`, `.bat`, ``] : [``]
  return (process.env.PATH || "").split(delimiter).flatMap((directory) => suffixes.map((suffix) => resolve(directory, `${name}${suffix}`)))
}

function firstExisting(values) { return values.find((value) => value && existsSync(value)) || "" }

export function stealthConfig() {
  const local = loadSecrets().stealth ?? {}
  const tor = firstExisting([
    process.env.OPENCODE_TOR_EXECUTABLE,
    local.tor_executable,
    ...executableCandidates("tor"),
  ])
  return {
    tor,
    socksPort: Number(local.socks_port || process.env.OPENCODE_TOR_SOCKS_PORT || 19050),
    controlPort: Number(local.control_port || process.env.OPENCODE_TOR_CONTROL_PORT || 19051),
    runtimeRoot,
  }
}
