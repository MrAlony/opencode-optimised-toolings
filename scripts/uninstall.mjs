#!/usr/bin/env node
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { globalConfigPath, globalOpenCodeDirectory, installStatePath } from "./lib/paths.mjs";
import { readJson } from "./lib/json-files.mjs";

import { detachDeployment } from "../packages/shared/deployment.js";

try {
  let restored = false;
  try {
    const state = readJson(installStatePath);
    if (state.backups?.config && existsSync(state.backups.config)) {
      copyFileSync(state.backups.config, globalConfigPath);
      if (state.backups.agents && existsSync(state.backups.agents)) copyFileSync(state.backups.agents, resolve(globalOpenCodeDirectory, "AGENTS.md"));
      if (state.backups.kilo && existsSync(state.backups.kilo)) copyFileSync(state.backups.kilo, resolve(globalOpenCodeDirectory, "agents", "kilo-implementer.md"));
      const tuiJsonPath = resolve(globalOpenCodeDirectory, "tui.json");
      if (state.backups.tui && existsSync(state.backups.tui)) copyFileSync(state.backups.tui, tuiJsonPath);
      restored = true;
    }
  } catch {}

  const result = await detachDeployment();
  console.log("UNINSTALL SUCCESS: OpenCode configuration, guidance, and TUI plugin registration were removed. Restart OpenCode.");
} catch (error) {
  console.error(`UNINSTALL FAILED: ${error.message}`);
  process.exitCode = 1;
}
