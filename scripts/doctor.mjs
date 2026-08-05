#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { globalConfigPath, globalOpenCodeDirectory, root, rootPluginUrl, secretsPath } from "./lib/paths.mjs";
import { readJson } from "./lib/json-files.mjs";
import { statusSearx } from "./lib/services.mjs";
import { stealthConfig } from "../packages/stealth/lib/config.js";

const checks = [];
function check(name, pass, detail) { checks.push({ name, outcome: pass ? "pass" : "fail", detail }); }
try {
  const config = readJson(globalConfigPath, {}); check("global config JSON", Boolean(config.$schema || Object.keys(config).length), globalConfigPath);
  check("unified plugin registered", (config.plugin || []).some((item) => String(Array.isArray(item) ? item[0] : item) === rootPluginUrl), rootPluginUrl);
  check("built-in webfetch disabled", config.tools?.webfetch === false && config.permission?.webfetch === "deny", `tools=${config.tools?.webfetch}; permission=${config.permission?.webfetch}`);
  check("legacy stealth MCP removed", !config.mcp?.stealth, "mcp.stealth must be absent");
  check("local secrets file", existsSync(secretsPath), secretsPath);
  check("CBM build", existsSync(resolve(root, "packages", "cbm", "dist", "index.js")), "packages/cbm/dist/index.js");
  check("TUI companion registered", (() => { try { const tui = JSON.parse(readFileSync(resolve(globalOpenCodeDirectory, "tui.json"), "utf8")); return (tui.plugin || []).some((entry) => String(Array.isArray(entry) ? entry[0] : entry).includes("/packages/tui/index.tsx")); } catch { return false; } })(), resolve(globalOpenCodeDirectory, "tui.json"));
  const manifestFile = resolve(root, "packages", "selfpatch", "patches", "1.18.13", "manifest.mjs");
  check("self-patch manifest v1.18.13", existsSync(manifestFile), "packages/selfpatch/patches/1.18.13/manifest.mjs");
  const manifestText = existsSync(manifestFile) ? readFileSync(manifestFile, "utf8") : "";
  check("renderer API boundary patch", manifestText.includes("packages/opencode/src/plugin/tui/runtime.ts") && manifestText.includes("scope.track(api.toolRenderers.register"), "base adapter + scoped plugin API forwarding");
  const stealth = stealthConfig(); check("stealth Python", Boolean(stealth.python), stealth.python || "not found"); check("Tor executable", Boolean(stealth.tor), stealth.tor || "optional until stealth use, but required for Tor operations");
  const searx = await statusSearx(); check("SearXNG environment", searx.installed, searx.python); checks.push({ name: "SearXNG service", outcome: searx.status === "running" ? "pass" : "info", detail: `${searx.status} on 127.0.0.1:${searx.port}` });
  const node = spawnSync(process.execPath, ["--version"], { encoding: "utf8", windowsHide: true }); check("Node runtime", node.status === 0, String(node.stdout || node.stderr || node.error?.message || "no output").trim());
} catch (error) { checks.push({ name: "doctor execution", outcome: "fail", detail: error.message }); }
const failures = checks.filter((item) => item.outcome === "fail"); console.log(`TOOLING DOCTOR: ${failures.length ? "FAILED" : "READY"}`); for (const item of checks) console.log(`- [${item.outcome.toUpperCase()}] ${item.name}: ${item.detail}`); if (failures.length) process.exitCode = 1;
