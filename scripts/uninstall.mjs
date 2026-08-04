#!/usr/bin/env node
import { copyFileSync, existsSync } from "node:fs";
import { globalConfigPath, globalOpenCodeDirectory, installStatePath } from "./lib/paths.mjs";
import { readJson } from "./lib/json-files.mjs";
import { resolve } from "node:path";
try { const state = readJson(installStatePath); if (!state.backups?.config || !existsSync(state.backups.config)) throw new Error("The original OpenCode config backup is unavailable; refusing a partial rollback."); copyFileSync(state.backups.config, globalConfigPath); if (state.backups.agents && existsSync(state.backups.agents)) copyFileSync(state.backups.agents, resolve(globalOpenCodeDirectory, "AGENTS.md")); if (state.backups.kilo && existsSync(state.backups.kilo)) copyFileSync(state.backups.kilo, resolve(globalOpenCodeDirectory, "agents", "kilo-implementer.md")); console.log("UNINSTALL SUCCESS: prior OpenCode configuration and guidance were restored. Restart OpenCode."); } catch (error) { console.error(`UNINSTALL FAILED: ${error.message}`); process.exitCode = 1; }
