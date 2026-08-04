import { promises as fs } from "node:fs"
import { spawn } from "node:child_process"
import path from "node:path"

export function restartMarkerFile(root) {
  return path.join(root, "runtime", "restart-marker.json")
}

function ps(str) {
  return `'${String(str).replace(/\\/g, "\\\\").replace(/'/g, "''")}'`
}

function sh(str) {
  return `'${String(str).replace(/'/g, `'\\''`)}'`
}

export function buildHelperCommand(marker) {
  const backup = `${marker.officialPath}.toolings-backup`
  if (process.platform === "win32") {
    const script = [
      "$ErrorActionPreference='Continue'",
      `Wait-Process -Id ${Number(marker.parentPid)} -Timeout 180 -ErrorAction SilentlyContinue`,
      "$ok=$false",
      "for ($i=0; $i -lt 60; $i++) {",
      "  Start-Sleep -Milliseconds 250",
      `  try { Move-Item -LiteralPath ${ps(marker.officialPath)} -Destination ${ps(backup)} -Force -ErrorAction Stop; Move-Item -LiteralPath ${ps(marker.patchedPath)} -Destination ${ps(marker.officialPath)} -Force -ErrorAction Stop; $ok=$true; break } catch { $err=$_.Exception.Message }`,
      "}",
      "if (-not $ok) { Write-Error 'toolings swap failed'; exit 2 }",
      `Start-Process -FilePath ${ps(marker.officialPath)} -ArgumentList ${ps("--continue")} -WorkingDirectory ${ps(marker.cwd)}`,
    ].join("\n")
    return { program: "powershell", args: ["-NoProfile", "-WindowStyle", "Hidden", "-Command", script] }
  }

  const script = [
    `while kill -0 ${Number(marker.parentPid)} 2>/dev/null; do sleep 0.3; done`,
    "i=0",
    "while [ $i -lt 60 ]; do",
    `  if mv -f ${sh(marker.officialPath)} ${sh(backup)} 2>/dev/null && mv -f ${sh(marker.patchedPath)} ${sh(marker.officialPath)} 2>/dev/null; then break; fi`,
    "  i=$((i+1)); sleep 0.25",
    "done",
    `cd ${sh(marker.cwd)} 2>/dev/null`,
    `nohup ${sh(marker.officialPath)} --continue >/dev/null 2>&1 &`,
  ].join("\n")
  return { program: "/bin/sh", args: ["-c", script] }
}

export async function scheduleRestart(root, { officialPath, patchedPath, cwd, parentPid }) {
  const marker = {
    officialPath,
    patchedPath,
    cwd: cwd ?? process.cwd(),
    parentPid: parentPid ?? process.pid,
    scheduledAt: new Date().toISOString(),
  }
  const file = restartMarkerFile(root)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(marker, null, 2), { encoding: "utf8", mode: 0o600 })
  const command = buildHelperCommand(marker)
  const child = spawn(command.program, command.args, { detached: true, stdio: "ignore", windowsHide: true })
  child.unref()
  return marker
}
