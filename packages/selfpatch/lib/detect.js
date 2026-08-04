import { spawnSync } from "node:child_process"
import path from "node:path"

const DEV_NAMES = new Set(["node", "node.exe", "bun", "bun.exe", "deno", "deno.exe"])

export function isDevRuntime(execPath) {
  const base = path.basename(execPath || "").toLowerCase()
  return DEV_NAMES.has(base)
}

export function versionOf(bin) {
  const res = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 10_000, windowsHide: true })
  if (res.error || res.status !== 0) return null
  const text = `${res.stdout ?? ""} ${res.stderr ?? ""}`
  const match = text.match(/(\d+\.\d+\.\d+)/)
  return match ? { version: match[1] } : null
}

export function detectBinary(overrides = {}) {
  const candidates = []
  if (overrides.bin) candidates.push(overrides.bin)
  if (process.env.OPENCODE_TOOLINGS_BIN) candidates.push(process.env.OPENCODE_TOOLINGS_BIN)
  if (process.execPath) candidates.push(process.execPath)
  candidates.push("opencode")

  for (const candidate of candidates) {
    try {
      const probe = candidate === "opencode" ? "opencode" : path.resolve(candidate)
      const info = versionOf(probe)
      if (!info) continue
      return { path: probe, version: info.version, devMode: isDevRuntime(probe) }
    } catch {
      // try the next candidate
    }
  }
  return null
}
