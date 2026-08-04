#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { root, secretsPath } from "./lib/paths.mjs";
import { ensureSearxSettings } from "./lib/services.mjs";

function run(command, args, cwd = root) { const result = spawnSync(command, args, { cwd, stdio: "inherit", windowsHide: true, shell: false }); if (result.error) throw result.error; if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited ${result.status}`); }
function runNpm(args) { const npmCli = process.env.npm_execpath; if (!npmCli) throw new Error("npm_execpath is unavailable; run setup through `npm run setup`."); run(process.execPath, [npmCli, ...args]); }
function pythonFor(directory) { return process.platform === "win32" ? resolve(directory, ".venv", "Scripts", "python.exe") : resolve(directory, ".venv", "bin", "python"); }
function findPython() { for (const candidate of process.platform === "win32" ? [["py", ["-3"]], ["python", []]] : [["python3", []], ["python", []]]) { const result = spawnSync(candidate[0], [...candidate[1], "--version"], { encoding: "utf8", windowsHide: true }); if (result.status === 0) return candidate; } throw new Error("Python 3 was not found. Install Python 3.11+ and rerun setup."); }
function ensureVenv(directory, requirements) { const python = pythonFor(directory); if (!existsSync(python)) { const [command, prefix] = findPython(); run(command, [...prefix, "-m", "venv", resolve(directory, ".venv")]); } run(python, ["-m", "pip", "install", "--disable-pip-version-check", "-r", requirements], directory); return python; }

try {
  if (!existsSync(secretsPath)) { mkdirSync(resolve(root, "config"), { recursive: true }); copyFileSync(resolve(root, "config", "secrets.example.json"), secretsPath); console.log(`Created local-only secrets file: ${secretsPath}`); }
  runNpm(["install", "--no-audit", "--no-fund"]);
  runNpm(["run", "build"]);
  const stealthRoot = resolve(root, "packages", "stealth"); const stealthPython = ensureVenv(stealthRoot, resolve(stealthRoot, "requirements.txt")); run(stealthPython, ["-m", "patchright", "install", "chromium"], stealthRoot);
  const searxRoot = resolve(root, "services", "searxng");
  if (!existsSync(resolve(searxRoot, "searx", "data", "__init__.py"))) throw new Error("Vendored SearXNG source is incomplete: searx/data is missing.");
  ensureVenv(searxRoot, resolve(searxRoot, "requirements.txt")); ensureSearxSettings();
  console.log("SETUP SUCCESS: Node workspaces, CBM build, stealth Python/Patchright, and SearXNG environments are ready.");
} catch (error) { console.error(`SETUP FAILED: ${error.message}`); process.exitCode = 1; }
