import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import * as pluginModule from "../index.js";

const { EnhancedTerminalPlugin } = pluginModule;

const plugin = await EnhancedTerminalPlugin();
const context = { directory: process.cwd(), sessionID: "terminal-tests" };

function detachedNodeCommand() {
  const executable = process.execPath.replaceAll("'", "''");
  return `Start-Process -FilePath '${executable}' -ArgumentList '-e', 'setInterval(()=>{},1000)'`;
}

function windowsProcessExists(pid) {
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }`,
  ], { windowsHide: true, stdio: "ignore" });
  return result.status === 0;
}

test("shell executes independent commands in one parallel batch", async () => {
  const output = await plugin.tool["alonix-shell"].execute({
    commands: [
      { command: "node -e \"console.log('alpha')\"", label: "a" },
      { command: "node -e \"console.log('beta')\"", label: "b" },
    ],
    mode: "parallel",
  }, context);
  assert.match(output, /TERMINAL RESULT: SUCCESS/);
  assert.match(output, /WHAT HAPPENED: 2 command\(s\) succeeded and 0 failed/);
  assert.match(output, /alpha/);
  assert.match(output, /beta/);
  assert.match(output, /2 command\(s\)/);
});

test("shell safely repairs a quoted Windows executable invocation inside one call", { skip: process.platform !== "win32" }, async () => {
  const executable = process.execPath.replaceAll('"', '""');
  const output = await plugin.tool["alonix-shell"].execute({ commands: [{ command: `"${executable}" -e "console.log('recovered-shell')"` }] }, { ...context, sessionID: "quoted-executable-recovery" });
  assert.match(output, /TERMINAL RESULT: SUCCESS/);
  assert.match(output, /AUTOMATIC RECOVERY/);
  assert.match(output, /Outcome: SUCCEEDED/);
  assert.match(output, /recovered-shell/);
  assert.match(output, /Retry limit: one/);
});

test("shell auto-converts unix chain separators for Windows PowerShell", { skip: process.platform !== "win32" }, async () => {
  const output = await plugin.tool["alonix-shell"].execute({ commands: [{ command: "Write-Output FIRST&&Write-Output SECOND" }] }, { ...context, sessionID: "chain-separator-repair" });
  assert.match(output, /TERMINAL RESULT: SUCCESS/);
  assert.match(output, /SYNTAX PORTABILITY/);
  assert.match(output, /Repaired command: Write-Output FIRST\s*;\s*Write-Output SECOND/);
  assert.match(output, /\bFIRST\b/);
  assert.match(output, /\bSECOND\b/);
});

test("shell preserves unix chain syntax inside quoted strings", { skip: process.platform !== "win32" }, async () => {
  const output = await plugin.tool["alonix-shell"].execute({ commands: [{ command: "Write-Output 'kept&&intact'" }] }, { ...context, sessionID: "chain-quoted-preserved" });
  assert.match(output, /TERMINAL RESULT: SUCCESS/);
  assert.doesNotMatch(output, /SYNTAX PORTABILITY/);
  assert.match(output, /kept&&intact/);
});

test("shell never retries an ordinary nonzero command", async () => {
  const output = await plugin.tool["alonix-shell"].execute({ commands: [{ command: "node -e \"console.log('ordinary-failure');process.exit(9)\"" }] }, { ...context, sessionID: "ordinary-failure-no-replay" });
  assert.match(output, /TERMINAL RESULT: FAILED/);
  assert.match(output, /ordinary-failure/);
  assert.doesNotMatch(output, /AUTOMATIC RECOVERY/);
});

test("shell sequential mode stops after failure by default", async () => {
  const output = await plugin.tool["alonix-shell"].execute({
    commands: [
      { command: "node -e \"process.exit(7)\"" },
      { command: "node -e \"console.log('should-not-run')\"" },
    ],
    mode: "sequential",
  }, { ...context, sessionID: "sequential-test" });
  assert.match(output, /TERMINAL RESULT: FAILED/);
  assert.match(output, /Sequential execution stopped after the first failure/);
  assert.match(output, /status: exit [1-9]/);
  assert.match(output, /Terminal batch: 1 command\(s\)/);
  assert.doesNotMatch(output, /should-not-run/);
});

test("singleton shell calls emit escalating advice", async () => {
  const singletonContext = { ...context, sessionID: "singleton-test" };
  const args = { commands: [{ command: "node -e \"console.log('one')\"" }] };
  const first = await plugin.tool["alonix-shell"].execute(args, singletonContext);
  const second = await plugin.tool["alonix-shell"].execute(args, singletonContext);
  assert.match(first, /EFFICIENCY NOTICE/);
  assert.match(second, /STRONG BATCHING ADVICE/);
  assert.match(second, /REPEATED COMMAND WARNING/);
});

test("shell flags filesystem read and search substitutions even in a batch", async () => {
  const output = await plugin.tool["alonix-shell"].execute({
    commands: [
      { command: "$p='file.cpp'; $l=Get-Content $p; $l[1..3]", label: "range read" },
      { command: "rg -n 'renderViewport' engine", label: "search" },
    ],
    mode: "parallel",
  }, { ...context, sessionID: "filesystem-substitution-test" });
  assert.match(output, /DEDICATED FILESYSTEM TOOL ADVISORY/);
  assert.match(output, /alonix-read-many/);
  assert.match(output, /alonix-search/);
});

test("shell enforces timeout and kills the process tree", async () => {
  const started = Date.now();
  const output = await plugin.tool["alonix-shell"].execute({
    commands: [{
      command: "node -e \"setInterval(() => {}, 1000)\"",
      timeout_ms: 200,
      label: "intentional timeout",
    }],
  }, { ...context, sessionID: "timeout-test" });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 5_000, `timeout call took ${elapsed}ms`);
  assert.match(output, /TIMEOUT: exceeded hard deadline of 200ms/);
  assert.match(output, /TIMEOUT ENFORCEMENT/);
  assert.match(output, /Full process-tree termination was requested/);
  assert.doesNotMatch(output, /use alonix-background-process/i);
});

test("shell clamps requested timeouts above the 90 second maximum", async () => {
  const output = await plugin.tool["alonix-shell"].execute({
    commands: [{
      command: "node -e \"console.log('quick')\"",
      timeout_ms: 999_999,
    }],
  }, { ...context, sessionID: "timeout-clamp-test" });
  assert.match(output, /TIMEOUT CLAMPED/);
  assert.match(output, /absolute maximum is 90000ms/);
});

test("entry module exports only the OpenCode plugin factory", () => {
  assert.deepEqual(Object.keys(pluginModule), ["EnhancedTerminalPlugin"]);
});

test("repeated pure polls emit escalating advice without delaying operations", async () => {
  const pollContext = { ...context, sessionID: "poll-advisory-test" };
  const args = { operations: [{ action: "status", id: "missing" }] };
  const first = await plugin.tool["alonix-background-process"].execute(args, pollContext);
  const started = Date.now();
  const second = await plugin.tool["alonix-background-process"].execute(args, pollContext);
  const third = await plugin.tool["alonix-background-process"].execute(args, pollContext);
  assert.ok(Date.now() - started < 1_000, "poll advisories must not introduce runtime delays");
  assert.match(first, /Process 'missing' not found/);
  assert.match(second, /POLLING ADVICE/);
  assert.match(second, /Stop polling now/);
  assert.match(third, /CRITICAL POLLING ADVICE/);
  assert.match(third, /Do not continue the polling loop/);
  assert.doesNotMatch(`${first}\n${second}\n${third}`, /POLL COOLDOWN|delayed \d+s|COOLDOWN ABORTED/);
});

test("non-polling background work resets the poll advisory streak", async () => {
  const resetContext = { ...context, sessionID: "poll-reset-test" };
  const poll = { operations: [{ action: "status", id: "missing" }] };
  await plugin.tool["alonix-background-process"].execute(poll, resetContext);
  await plugin.tool["alonix-background-process"].execute({ operations: [{ action: "cleanup" }] }, resetContext);
  const nextPoll = await plugin.tool["alonix-background-process"].execute(poll, resetContext);
  assert.doesNotMatch(nextPoll, /POLLING ADVICE|CRITICAL POLLING ADVICE/);
  assert.match(nextPoll, /Process 'missing' not found/);
});

test("another tool invocation resets the background polling advisory streak", async () => {
  const resetContext = { ...context, sessionID: "cross-tool-reset-test" };
  const poll = { operations: [{ action: "status", id: "missing" }] };
  await plugin.tool["alonix-background-process"].execute(poll, resetContext);
  await plugin["tool.execute.before"]({ tool: "alonix-read-many", sessionID: resetContext.sessionID });
  const nextPoll = await plugin.tool["alonix-background-process"].execute(poll, resetContext);
  assert.doesNotMatch(nextPoll, /POLLING ADVICE|CRITICAL POLLING ADVICE/);
});

test("alonix-background-process batches starts, listing, and stop_all", async () => {
  const output = await plugin.tool["alonix-background-process"].execute({
    operations: [
      { action: "start", command: "node -e \"setTimeout(() => {}, 30000)\"", label: "one" },
      { action: "start", command: "node -e \"setTimeout(() => {}, 30000)\"", label: "two" },
      { action: "list" },
      { action: "stop_all" },
    ],
  }, { ...context, sessionID: "background-test" });
  assert.match(output, /PROCESS STARTED/);
  assert.match(output, /started id=bgp_/);
  assert.match(output, /Background processes \(2 total, 2 running\)/);
  assert.match(output, /Stop completed for 2 of 2 running process/);
});

test("background start returns readiness and startup output in the same operation", async () => {
  const output = await plugin.tool["alonix-background-process"].execute({ operations: [{ action: "start", command: "node -e \"console.log('READY-LIVE');setTimeout(() => {}, 30000)\"", ready_output: "READY-LIVE", startup_timeout_ms: 3_000 }, { action: "stop_all" }, { action: "cleanup" }] }, { ...context, sessionID: "background-readiness-test" });
  assert.match(output, /PROCESS READY/);
  assert.match(output, /captured output contains "READY-LIVE"/);
  assert.match(output, /STARTUP OUTPUT/);
  assert.match(output, /Stop completed for 1 of 1/);
  assert.match(output, /Removed [1-9]\d* exited process record/);
});

test("background start reports an early exit and logs without a follow-up call", async () => {
  const output = await plugin.tool["alonix-background-process"].execute({ operations: [{ action: "start", command: "node -e \"console.error('startup-boom');process.exit(12)\"" }] }, { ...context, sessionID: "background-early-exit-test" });
  assert.match(output, /PROCESS START FAILED/);
  assert.match(output, /exited during bounded startup settlement/);
  assert.match(output, /startup-boom/);
});

test("background safely repairs a quoted Windows executable during startup", { skip: process.platform !== "win32" }, async () => {
  const executable = process.execPath.replaceAll('"', '""');
  const output = await plugin.tool["alonix-background-process"].execute({ operations: [{ action: "start", command: `"${executable}" -e "console.log('BG-READY');setTimeout(() => {}, 30000)"`, ready_output: "BG-READY", startup_timeout_ms: 3_000 }, { action: "stop_all" }, { action: "cleanup" }] }, { ...context, sessionID: "background-recovery-test" });
  assert.match(output, /PROCESS READY/);
  assert.match(output, /AUTOMATIC RECOVERY/);
  assert.match(output, /Outcome: SUCCEEDED/);
  assert.match(output, /Stop completed for 1 of 1/);
});

test("plugin disposal terminates all managed background processes", async () => {
  const disposablePlugin = await EnhancedTerminalPlugin();
  await disposablePlugin.tool["alonix-background-process"].execute({
    operations: [{ action: "start", command: "node -e \"setTimeout(() => {}, 30000)\"" }],
  }, { ...context, sessionID: "dispose-test" });
  await disposablePlugin.dispose();
  const output = await disposablePlugin.tool["alonix-background-process"].execute({
    operations: [{ action: "list" }],
  }, { ...context, sessionID: "dispose-list-test" });
  assert.match(output, /No background processes/);
});

test("shell cleans a detached Windows child before reporting completion", { skip: process.platform !== "win32" }, async () => {
  const output = await plugin.tool["alonix-shell"].execute({
    commands: [{ command: detachedNodeCommand() }],
  }, { ...context, sessionID: "detached-foreground-test" });
  assert.match(output, /DETACHED PROCESS CLEANUP/);
  const pid = Number([...output.matchAll(/taskkill (\d+) exited 0/g)].at(-1)?.[1]);
  assert.ok(pid, `missing cleaned child pid in: ${output}`);
  assert.equal(windowsProcessExists(pid), false);
});

test("alonix-background-process tracks and stops a detached Windows child", { skip: process.platform !== "win32" }, async () => {
  const backgroundContext = { ...context, sessionID: "detached-background-test" };
  const started = await plugin.tool["alonix-background-process"].execute({
    operations: [{ action: "start", command: detachedNodeCommand() }],
  }, backgroundContext);
  const id = started.match(/started id=(bgp_\w+)/)?.[1];
  assert.ok(id, `missing process id in: ${started}`);
  await delay(1_500);
  const status = await plugin.tool["alonix-background-process"].execute({ operations: [{ action: "status", id }] }, backgroundContext);
  assert.match(status, /status=running/);
  const childPid = Number(status.match(/child_pids=([\d,]+)/)?.[1]?.split(",")[0]);
  assert.ok(childPid, `missing tracked child pid in: ${status}`);
  assert.equal(windowsProcessExists(childPid), true);
  await plugin.tool["alonix-background-process"].execute({ operations: [{ action: "stop", id }] }, backgroundContext);
  await delay(500);
  assert.equal(windowsProcessExists(childPid), false);
});
