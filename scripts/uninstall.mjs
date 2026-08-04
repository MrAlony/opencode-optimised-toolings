#!/usr/bin/env node
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { globalConfigPath, globalOpenCodeDirectory, installStatePath } from "./lib/paths.mjs";
import { readJson } from "./lib/json-files.mjs";

try {
  const state = readJson(installStatePath);
  if (!state.backups?.config || !existsSync(state.backups.config)) {
    throw new Error("The original OpenCode config backup is unavailable; refusing a partial rollback.");
  }
  copyFileSync(state.backups.config, globalConfigPath);
  if (state.backups.agents && existsSync(state.backups.agents)) copyFileSync(state.backups.agents, resolve(globalOpenCodeDirectory, "AGENTS.md"));
  if (state.backups.kilo && existsSync(state.backups.kilo)) copyFileSync(state.backups.kilo, resolve(globalOpenCodeDirectory, "agents", "kilo-implementer.md"));
  const tuiJsonPath = resolve(globalOpenCodeDirectory, "tui.json");
  if (state.backups.tui && existsSync(state.backups.tui)) {
    copyFileSync(state.backups.tui, tuiJsonPath);
  } else if (existsSync(tuiJsonPath)) {
    try {
      const parsed = JSON.parse(readFileSync(tuiJsonPath, "utf8"));
      if (Array.isArray(parsed.plugin)) {
        const before = parsed.plugin.length;
        parsed.plugin = parsed.plugin.filter((entry) => !String(Array.isArray(entry) ? entry[0] : entry).includes("/packages/tui/index.tsx"));
        if (parsed.plugin.length !== before) writeFileSync(tuiJsonPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
      }
    } catch { /* leave a malformed file untouched */ }
  }
  console.log("UNINSTALL SUCCESS: prior OpenCode configuration, guidance, and TUI plugin registration were restored. Restart OpenCode.");
} catch (error) {
  console.error(`UNINSTALL FAILED: ${error.message}`);
  process.exitCode = 1;
}
