import { existsSync } from "node:fs";
import { delimiter, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSecrets, repositoryRoot } from "../../web/lib/config.js";

export const packageRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
export const runtimeRoot = resolve(packageRoot, "runtime");

function executableCandidates(name) {
  const suffixes = process.platform === "win32" ? [`.exe`, `.cmd`, `.bat`, ``] : [``];
  return (process.env.PATH || "").split(delimiter).flatMap((directory) => suffixes.map((suffix) => resolve(directory, `${name}${suffix}`)));
}

function firstExisting(values) { return values.find((value) => value && existsSync(value)) || ""; }

export function stealthConfig() {
  const local = loadSecrets().stealth ?? {};
  const python = firstExisting([
    process.env.OPENCODE_STEALTH_PYTHON,
    local.python_executable,
    process.platform === "win32" ? resolve(packageRoot, ".venv", "Scripts", "python.exe") : resolve(packageRoot, ".venv", "bin", "python"),
    ...executableCandidates(process.platform === "win32" ? "python" : "python3"),
  ]);
  const tor = firstExisting([
    process.env.OPENCODE_TOR_EXECUTABLE,
    local.tor_executable,
    resolve(repositoryRoot, "services", "tor", "bin", process.platform === "win32" ? "tor.exe" : "tor"),
    ...executableCandidates("tor"),
  ]);
  return {
    python,
    tor,
    socksPort: Number(local.socks_port || process.env.OPENCODE_TOR_SOCKS_PORT || 19050),
    controlPort: Number(local.control_port || process.env.OPENCODE_TOR_CONTROL_PORT || 19051),
    runtimeRoot,
  };
}
