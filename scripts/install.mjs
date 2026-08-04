#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { cbmSkillPath, configDirectory, globalConfigPath, globalOpenCodeDirectory, installStatePath, root, rootPluginUrl } from "./lib/paths.mjs";
import { readJson, writeJsonAtomic } from "./lib/json-files.mjs";
import { migrateOpenCodeConfig } from "./lib/install-core.mjs";

function backup(path, suffix) { if (!existsSync(path)) return null; const target = resolve(configDirectory, `backup-${suffix}-${Date.now()}-${basename(path)}`); copyFileSync(path, target); return target; }

try {
  const original = readJson(globalConfigPath);
  const previousState = readJson(installStatePath, null);
  const reusable = previousState?.backups?.config && existsSync(previousState.backups.config);
  const state = reusable
    ? { ...previousState, reinstalled_at: new Date().toISOString(), root_plugin: rootPluginUrl }
    : { installed_at: new Date().toISOString(), global_config: globalConfigPath, backups: {}, root_plugin: rootPluginUrl };
  if (!reusable) state.backups.config = backup(globalConfigPath, "opencode");
  const config = migrateOpenCodeConfig(original, { rootPluginUrl, cbmSkillPath });
  mkdirSync(globalOpenCodeDirectory, { recursive: true }); writeJsonAtomic(globalConfigPath, config);
  const guidanceTargets = [[resolve(root, "config", "AGENTS.md"), resolve(globalOpenCodeDirectory, "AGENTS.md"), "agents"], [resolve(root, "config", "agents", "kilo-implementer.md"), resolve(globalOpenCodeDirectory, "agents", "kilo-implementer.md"), "kilo"]];
  for (const [source, target, key] of guidanceTargets) { if (!reusable || !state.backups[key] || !existsSync(state.backups[key])) state.backups[key] = backup(target, key); mkdirSync(dirname(target), { recursive: true }); copyFileSync(source, target); }
  const tuiJsonPath = resolve(globalOpenCodeDirectory, "tui.json");
  const tuiSpec = `file://${resolve(root, "packages", "tui", "index.tsx").replace(/\\/g, "/")}`;
  if (!reusable || !state.backups.tui || !existsSync(state.backups.tui)) state.backups.tui = existsSync(tuiJsonPath) ? backup(tuiJsonPath, "tui") : null;
  let tuiConfig = { "$schema": "https://opencode.ai/tui.json", "plugin": [] };
  try { const existing = JSON.parse(readFileSync(tuiJsonPath, "utf8")); if (existing && typeof existing === "object") tuiConfig = { ...tuiConfig, ...existing }; } catch { /* start fresh */ }
  if (!Array.isArray(tuiConfig.plugin)) tuiConfig.plugin = [];
  if (!tuiConfig.plugin.some((entry) => (Array.isArray(entry) ? entry[0] : entry) === tuiSpec)) tuiConfig.plugin.push(tuiSpec);
  writeFileSync(tuiJsonPath, `${JSON.stringify(tuiConfig, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  writeJsonAtomic(installStatePath, state);
  console.log(`INSTALL SUCCESS\nRoot plugin: ${rootPluginUrl}\nConfig backup: ${state.backups.config}\nBuilt-in webfetch: disabled and denied\nStealth MCP: removed\nTUI plugin: ${tuiJsonPath}\nRestart OpenCode to load the unified plugin (first launch auto-patches and restarts itself once).`);
} catch (error) { console.error(`INSTALL FAILED: ${error.message}`); process.exitCode = 1; }
