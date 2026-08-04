#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { root } from "./lib/paths.mjs";
const npmCli = process.env.npm_execpath;
if (!npmCli) { console.error("TEST MATRIX FAILED: npm_execpath is unavailable; run through `npm test`."); process.exit(1); }
const commands = [
  [process.execPath, [npmCli, "run", "test", "-w", "packages/filesystem"]],
  [process.execPath, [npmCli, "run", "test", "-w", "packages/terminal"]],
  [process.execPath, [npmCli, "run", "test", "-w", "packages/cbm"]],
  [process.execPath, [npmCli, "run", "test", "-w", "packages/web"]],
  [process.execPath, [npmCli, "run", "test", "-w", "packages/stealth"]],
  [process.execPath, [npmCli, "run", "test", "-w", "packages/selfpatch"]],
  [process.execPath, [npmCli, "run", "test", "-w", "packages/tui"]],
  [process.execPath, [npmCli, "run", "test:root"]],
  [process.execPath, ["--check", "index.js"]],
];
let failed = 0;
for (const [command, args] of commands) {
  console.log(`\n> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", windowsHide: true });
  if (result.status !== 0) failed += 1;
}
console.log(`\nTEST MATRIX: ${failed ? "FAILED" : "SUCCESS"}; checks=${commands.length}; failed=${failed}`);
if (failed) process.exitCode = 1;
