import { tool } from "@opencode-ai/plugin";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 90_000;
const MAX_COMMANDS = 12;
const MAX_CONCURRENCY = 6;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_BATCH_OUTPUT_BYTES = 192 * 1024;
const WINDOWS_PROCESS_QUERY_TIMEOUT_MS = 5_000;
const WINDOWS_DESCENDANT_MARKER = "__OC_DESCENDANTS__";
const START_SETTLE_MS = process.platform === "win32" ? 1_000 : 250;
const DEFAULT_READINESS_TIMEOUT_MS = 5_000;
const MAX_READINESS_TIMEOUT_MS = 30_000;
const STOP_CONFIRM_TIMEOUT_MS = 2_000;
const TRANSIENT_SPAWN_CODES = new Set(["EAGAIN", "EBUSY", "EMFILE", "ENFILE", "EPERM"]);
const sessionState = new Map();
const procs = new Map();
let procCounter = 0;

function getShell() {
  return process.platform === "win32"
    ? { cmd: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command"] }
    : { cmd: "sh", args: ["-c"] };
}

function shellCommand(command) {
  if (process.platform !== "win32") return command;
  return `& { ${command} }; $ocExit = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 }; $ocAll = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId); $ocPending = @([int]$PID); $ocSeen = @{}; $ocDesc = @(); while ($ocPending.Count -gt 0) { $ocParent = [int]$ocPending[0]; if ($ocPending.Count -eq 1) { $ocPending = @() } else { $ocPending = @($ocPending[1..($ocPending.Count - 1)]) }; foreach ($ocItem in $ocAll | Where-Object { [int]$_.ParentProcessId -eq $ocParent }) { $ocPid = [int]$ocItem.ProcessId; if (-not $ocSeen.ContainsKey($ocPid)) { $ocSeen[$ocPid] = $true; $ocDesc += $ocPid; $ocPending += $ocPid } } }; [Console]::Out.WriteLine('${WINDOWS_DESCENDANT_MARKER}' + (($ocDesc | ConvertTo-Json -Compress) -replace '\\s','')); exit $ocExit`;
}

function quotedExecutableRepair(command, output) {
  if (process.platform !== "win32" || /^\s*&\s*/.test(command)) return null;
  if (!/^\s*"[^"\r\n]+\.(?:exe|cmd|bat|com)"\s+\S/i.test(command)) return null;
  if (!/Unexpected token .* in expression or statement|Unexpected token '-[^']*'/i.test(output)) return null;
  return `& ${command.trimStart()}`;
}

function transientSpawnFailure(errorCode) {
  return typeof errorCode === "string" && TRANSIENT_SPAWN_CODES.has(errorCode.toUpperCase());
}

function extractWindowsDescendants(text) {
  if (process.platform !== "win32") return { output: text, pids: [] };
  const pattern = new RegExp(`(?:\\r?\\n)?${WINDOWS_DESCENDANT_MARKER}(\\[[^\\r\\n]*\\]|\\d+|null)(?:\\r?\\n)?`, "g");
  const pids = [];
  const output = text.replace(pattern, (_match, json) => {
    try {
      const parsed = JSON.parse(json);
      for (const value of Array.isArray(parsed) ? parsed : parsed == null ? [] : [parsed]) {
        const pid = Number(value);
        if (Number.isInteger(pid) && pid > 0) pids.push(pid);
      }
    } catch {}
    return "";
  });
  return { output, pids: [...new Set(pids)] };
}

function getSession(context) {
  const id = context?.sessionID ?? "global";
  if (!sessionState.has(id)) sessionState.set(id, { lastTool: null, toolStreak: 0, shellSingletons: 0, backgroundSingletons: 0, pollStreak: 0, lastCommand: "", repeatedCommand: 0 });
  return sessionState.get(id);
}

function repeatedToolAdvice(toolName, streak) {
  if (streak < 2) return "";
  const strength = streak >= 3 ? "STRONG" : "NOTICE";
  const guidance = toolName === "shell"
    ? "Batch independent finite commands and avoid serial shell micro-calls."
    : "Batch independent lifecycle operations and avoid repeated polling calls.";
  return `[${strength} REPEATED-TOOL ADVICE] Consecutive ${toolName} call #${streak}. ${guidance}`;
}

function trackToolUse(context, toolName) {
  const state = getSession(context);
  state.toolStreak = state.lastTool === toolName ? state.toolStreak + 1 : 1;
  state.lastTool = toolName;
  if (toolName !== "background_process") state.pollStreak = 0;
  return repeatedToolAdvice(toolName, state.toolStreak);
}

function singletonAdvice(kind, count) {
  if (count === 1) return `[TOOL-CALL EFFICIENCY NOTICE] Single-${kind} call detected. If other independent work is already known, include it in this call; do not invent unrelated work merely to fill a batch.`;
  if (count === 2) return `[STRONG BATCHING ADVICE] Repeated single-${kind} calls detected. Consolidate already-known independent commands or operations into the next call. Preserve dependency ordering and never reduce verification.`;
  if (count >= 3) return `[CRITICAL BATCHING ADVICE] ${count} single-${kind} calls have occurred in this session. Stop serial command micro-calls when work can safely be represented as one batch. Continue using single items only for genuine dependency-ordered steps.`;
  return "";
}

function detectFilesystemSubstitution(command) {
  const patterns = [
    { regex: /\b(Get-Content|gc|cat|type)\b/i, kind: "source/file reading", replacement: "fs_read_many with `paths` or exact `requests[].ranges`" },
    { regex: /\b(rg|ripgrep|Select-String|findstr|grep)\b/i, kind: "content search", replacement: "fs_search with both `file_pattern` and `query`" },
    { regex: /\b(Get-ChildItem|gci|dir)\b[^\r\n]*(?:-Recurse|-Filter)|\bfind\b[^\r\n]*-name/i, kind: "recursive filename discovery", replacement: "fs_search or one fs_explore baseline" },
  ];
  return patterns.find((item) => item.regex.test(command)) ?? null;
}

function commandAdvice(context, commands) {
  const state = getSession(context);
  const notes = [trackToolUse(context, "shell")];
  const substitutions = commands.map((item, index) => ({ index, match: detectFilesystemSubstitution(item.command) })).filter((item) => item.match);
  if (substitutions.length) {
    const details = substitutions.map((item) => `command ${item.index + 1}: ${item.match.kind} -> ${item.match.replacement}`).join("; ");
    notes.push(`[DEDICATED FILESYSTEM TOOL ADVISORY] Shell appears to be substituting for optimized filesystem tools (${details}). The commands were allowed because shell must remain general-purpose, but future source inspection/discovery should use the dedicated tools. This preserves binary detection, fixed output budgets, batched range reads, CBM escalation, and tool-call accounting. Use shell for actual execution/build/test/git work.`);
  }
  if (commands.length === 1) {
    state.shellSingletons += 1;
    notes.push(singletonAdvice("command", state.shellSingletons));
    const normalized = commands[0].command.trim();
    if (state.lastCommand === normalized) state.repeatedCommand += 1;
    else state.repeatedCommand = 1;
    state.lastCommand = normalized;
    if (state.repeatedCommand >= 2) notes.push(`[REPEATED COMMAND WARNING] The same command has run ${state.repeatedCommand} times consecutively. Inspect the prior result and change the approach instead of retrying unchanged.`);
  } else {
    state.shellSingletons = 0;
    state.repeatedCommand = 0;
    state.lastCommand = "";
  }
  return notes.filter(Boolean);
}

function backgroundAdvice(context, operations) {
  const state = getSession(context);
  const notes = [trackToolUse(context, "background_process")];
  if (operations.length === 1) {
    state.backgroundSingletons += 1;
    notes.push(singletonAdvice("operation", state.backgroundSingletons));
  } else state.backgroundSingletons = 0;
  const polling = operations.every((op) => ["status", "logs"].includes(String(op.action).toLowerCase()));
  state.pollStreak = polling ? state.pollStreak + 1 : 0;
  if (state.pollStreak === 2) notes.push("[POLLING ADVICE] This is the second consecutive polling call. Stop polling now: do useful independent work before checking again, and batch status/log requests for all known process ids.");
  if (state.pollStreak >= 3) notes.push(`[CRITICAL POLLING ADVICE] ${state.pollStreak} consecutive polling calls detected. Do not continue the polling loop. Work on something else and check once later, or use a finite foreground command when the process is not actually long-running.`);
  return notes.filter(Boolean);
}

function makeProcId() { return `bgp_${Date.now().toString(36)}${(++procCounter).toString(36)}`; }
function statusOf(rec) { return rec.exitCode === null ? "running" : `exited(${rec.exitCode})`; }
function outputOf(rec, tailChars = 32_000) {
  const text = Buffer.concat(rec.chunks).toString("utf8");
  return text.length > tailChars ? `[showing last ${tailChars} characters]\n${text.slice(-tailChars)}` : text;
}
function appendBounded(chunks, data, state) {
  if (state.bytes >= MAX_OUTPUT_BYTES) return;
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
  const remaining = MAX_OUTPUT_BYTES - state.bytes;
  chunks.push(buffer.subarray(0, remaining));
  state.bytes += Math.min(buffer.length, remaining);
  if (buffer.length > remaining) state.truncated = true;
}

function queryWindowsProcesses() {
  if (process.platform !== "win32") return Promise.resolve([]);
  return new Promise((resolve) => {
    const chunks = [];
    let settled = false;
    const finish = (processes = []) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(processes);
    };
    const query = spawn("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress",
    ], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    query.stdout?.on("data", (data) => chunks.push(data));
    query.once("error", () => finish());
    query.once("close", (code) => {
      if (code !== 0) return finish();
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "[]");
        finish(Array.isArray(parsed) ? parsed : [parsed]);
      } catch {
        finish();
      }
    });
    const timer = setTimeout(() => {
      try { query.kill("SIGKILL"); } catch {}
      finish();
    }, WINDOWS_PROCESS_QUERY_TIMEOUT_MS);
  });
}

function descendantPids(processes, rootPid) {
  const children = new Map();
  for (const item of processes) {
    const pid = Number(item.ProcessId);
    const parentPid = Number(item.ParentProcessId);
    if (!Number.isInteger(pid) || !Number.isInteger(parentPid)) continue;
    if (!children.has(parentPid)) children.set(parentPid, []);
    children.get(parentPid).push(pid);
  }
  const found = [];
  const pending = [Number(rootPid)];
  const seen = new Set(pending);
  while (pending.length) {
    const parentPid = pending.pop();
    for (const pid of children.get(parentPid) ?? []) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      found.push(pid);
      pending.push(pid);
    }
  }
  return found;
}

async function currentWindowsDescendants(rootPid) {
  return descendantPids(await queryWindowsProcesses(), rootPid);
}

async function refreshTrackedProcess(rec) {
  if (process.platform !== "win32" || rec.exitCode !== null || rec.rootExitCode === null) return;
  const processes = await queryWindowsProcesses();
  const live = new Set(processes.map((item) => Number(item.ProcessId)));
  rec.trackedPids = rec.trackedPids.filter((pid) => live.has(pid));
  if (rec.trackedPids.length === 0) rec.exitCode = rec.rootExitCode;
}

function taskkill(pid) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(message);
    };
    const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.once("error", (error) => finish(`taskkill ${pid} failed (${error.message})`));
    killer.once("close", (code) => finish(`taskkill ${pid} exited ${code ?? "?"}`));
    const timer = setTimeout(() => {
      try { killer.kill("SIGKILL"); } catch {}
      finish(`taskkill ${pid} grace period expired`);
    }, 1_500);
  });
}

async function terminateProcessTree(proc, knownDescendants = []) {
  if (!proc?.pid && knownDescendants.length === 0) return "no process id was available";
  if (process.platform === "win32") {
    const discovered = proc?.pid ? await currentWindowsDescendants(proc.pid) : [];
    const targets = [...new Set([proc?.pid, ...knownDescendants, ...discovered].filter(Boolean))];
    const results = [];
    for (const pid of targets) results.push(await taskkill(pid));
    try { proc?.kill("SIGKILL"); } catch {}
    return results.join("; ");
  }
  try {
    process.kill(-proc.pid, "SIGKILL");
    return "process group received SIGKILL";
  } catch (groupError) {
    try {
      proc.kill("SIGKILL");
      return `process-group kill failed (${groupError.message}); direct SIGKILL sent`;
    } catch (directError) {
      return `termination failed: ${directError.message}`;
    }
  }
}

function runCommandOnce(spec, defaultCwd, context, command = spec.command) {
  const shell = getShell();
  const cwd = spec.cwd ?? defaultCwd;
  const requestedTimeoutMs = spec.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const timeoutMs = Math.min(Math.max(requestedTimeoutMs, 1), MAX_TIMEOUT_MS);
  const chunks = [];
  const capture = { bytes: 0, truncated: false };
  const started = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let termination = "";
    let timer;
    const proc = spawn(shell.cmd, [...shell.args, shellCommand(command)], {
      cwd,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    const finish = (code, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      context?.abort?.removeEventListener?.("abort", onAbort);
      const captured = extractWindowsDescendants(Buffer.concat(chunks).toString("utf8"));
      resolve({ label: spec.label, command: spec.command, executedCommand: command, cwd, code, error: error?.message ?? error ?? null, errorCode: error?.code ?? null, timedOut, aborted, timeoutMs, requestedTimeoutMs, termination, durationMs: Date.now() - started, output: captured.output.trimEnd(), truncated: capture.truncated });
    };
    const onAbort = async () => {
      aborted = true;
      termination = await terminateProcessTree(proc);
      finish(null, null);
    };
    proc.stdout?.on("data", (data) => appendBounded(chunks, data, capture));
    proc.stderr?.on("data", (data) => appendBounded(chunks, data, capture));
    proc.on("error", (error) => finish(null, error));
    proc.on("close", async (code) => {
      if (timedOut || aborted) return;
      if (process.platform === "win32" && !timedOut && !aborted) {
        const captured = extractWindowsDescendants(Buffer.concat(chunks).toString("utf8"));
        const descendants = [...new Set([...captured.pids, ...await currentWindowsDescendants(proc.pid)])];
        if (descendants.length) termination = `cleaned ${descendants.length} detached descendant(s): ${await terminateProcessTree(proc, descendants)}`;
      }
      finish(code ?? null, null);
    });
    context?.abort?.addEventListener?.("abort", onAbort, { once: true });
    timer = setTimeout(async () => {
      timedOut = true;
      termination = await terminateProcessTree(proc);
      finish(null, null);
    }, timeoutMs);
  });
}

async function runCommand(spec, defaultCwd, context) {
  const first = await runCommandOnce(spec, defaultCwd, context);
  if (first.timedOut || first.aborted) return first;
  const corrected = quotedExecutableRepair(spec.command, first.output);
  const transient = transientSpawnFailure(first.errorCode);
  if (!corrected && !transient) return first;
  await delay(transient ? 100 : 0);
  const retryCommand = corrected ?? spec.command;
  const retry = await runCommandOnce(spec, defaultCwd, context, retryCommand);
  retry.recovery = {
    kind: corrected ? "windows_quoted_executable" : "transient_spawn",
    originalOutcome: first.error ? `spawn error ${first.errorCode ?? "unknown"}: ${first.error}` : `exit ${first.code ?? "unknown"}`,
    originalOutput: first.output,
    correctedCommand: corrected,
    succeeded: !retry.error && !retry.timedOut && !retry.aborted && retry.code === 0,
  };
  return retry;
}

async function mapConcurrent(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function consume() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, consume));
  return results;
}

function formatCommandResults(results, mode, notes) {
  const succeeded = results.filter((result) => !result.error && !result.timedOut && !result.aborted && result.code === 0).length;
  const failed = results.length - succeeded;
  const stoppedEarly = mode === "sequential" && results.length > 0 && failed > 0;
  const sections = [
    `TERMINAL RESULT: ${failed === 0 ? "SUCCESS" : succeeded > 0 ? "PARTIAL SUCCESS" : "FAILED"}`,
    `WHAT HAPPENED: ${succeeded} command(s) succeeded and ${failed} failed, timed out, or were aborted.${stoppedEarly ? " Sequential execution stopped after the first failure." : ""}`,
    `BATCH PLAN: ${results.length} command(s) executed; mode=${mode}.`,
    `Terminal batch: ${results.length} command(s), mode=${mode}`,
  ];
  let used = Buffer.byteLength(sections[0]);
  for (let i = 0; i < results.length; i += 1) {
    const result = results[i];
    const status = result.error
      ? `ERROR: ${result.error}`
      : result.timedOut
        ? `TIMEOUT: exceeded hard deadline of ${result.timeoutMs}ms`
        : result.aborted
          ? "ABORTED"
          : `exit ${result.code ?? "?"}`;
    let body = `\n=== COMMAND ${i + 1}${result.label ? `: ${result.label}` : ""} ===\nOutcome: ${status}\nMeaning: ${result.error ? "The process could not be started or completed." : result.timedOut ? "The command exceeded its hard deadline and termination was requested." : result.aborted ? "OpenCode cancelled the command and termination was requested." : result.code === 0 ? "The command completed successfully." : `The command completed with non-zero exit code ${result.code ?? "unknown"}.`}\nDuration: ${result.durationMs} ms\nWorking directory: ${result.cwd}\nCommand: ${result.command}\n--- CAPTURED OUTPUT ---\n${result.output || "(no output)"}\n--- TECHNICAL STATUS ---\nstatus: ${status}\nduration_ms: ${result.durationMs}\ncwd: ${result.cwd}\ncommand: ${result.command}`;
    if (result.recovery) {
      body += `\n--- AUTOMATIC RECOVERY ---\nOutcome: ${result.recovery.succeeded ? "SUCCEEDED" : "ATTEMPTED BUT FAILED"}\nDetected: ${result.recovery.kind === "windows_quoted_executable" ? "PowerShell parsed a quoted executable path as an expression, so the command body did not run." : "The shell process could not start because of a transient operating-system resource error."}\nOriginal attempt: ${result.recovery.originalOutcome}`;
      if (result.recovery.originalOutput) body += `\nOriginal diagnostic: ${result.recovery.originalOutput.slice(0, 2_000)}`;
      if (result.recovery.correctedCommand) body += `\nSafe correction: added PowerShell's call operator without changing the executable or arguments.\nRetried command: ${result.recovery.correctedCommand}`;
      else body += "\nSafe correction: retried the identical command once after a 100ms bounded delay; the failed spawn could not execute command code.";
      body += "\nRetry limit: one same-call recovery attempt; ordinary command failures are never replayed.";
    }
    if (result.requestedTimeoutMs > MAX_TIMEOUT_MS) body += `\n[TIMEOUT CLAMPED] Requested ${result.requestedTimeoutMs}ms, but the absolute maximum is ${MAX_TIMEOUT_MS}ms.`;
    if (result.timedOut) body += `\n[TIMEOUT ENFORCEMENT] The command exceeded ${result.timeoutMs}ms. Full process-tree termination was requested (${result.termination || "termination initiated"}).\n[TIMEOUT ADVISORY] Do not retry the same long-running command unchanged. Investigate why it exceeded the deadline, use a finite readiness-bounded command, or split the work without weakening verification.`;
    if (result.aborted) body += `\n[ABORT ENFORCEMENT] Full process-tree termination was requested (${result.termination || "termination initiated"}).`;
    if (!result.timedOut && !result.aborted && result.termination) body += `\n[DETACHED PROCESS CLEANUP] ${result.termination}. Persistent processes are not supported while background_process is disabled.`;
    if (result.truncated) body += `\n[OUTPUT TRUNCATED at ${MAX_OUTPUT_BYTES} bytes]`;
    const remaining = MAX_BATCH_OUTPUT_BYTES - used;
    if (remaining <= 0) { sections.push("\n[BATCH OUTPUT TRUNCATED]"); break; }
    if (Buffer.byteLength(body) > remaining) body = Buffer.from(body).subarray(0, remaining).toString("utf8") + "\n[BATCH OUTPUT TRUNCATED]";
    sections.push(body);
    used += Buffer.byteLength(body);
  }
  if (notes.length) sections.push(`\n${notes.join("\n")}`);
  return sections.join("\n");
}

function startProc(command, cwd, id, label) {
  const shell = getShell();
  const proc = spawn(shell.cmd, [...shell.args, shellCommand(command)], {
    cwd,
    shell: false,
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  let resolveClosed;
  const closed = new Promise((resolvePromise) => { resolveClosed = resolvePromise; });
  const rec = { id, label, command, executedCommand: command, cwd, pid: proc.pid, proc, chunks: [], bytes: 0, truncated: false, exitCode: null, rootExitCode: null, trackedPids: [], startTime: Date.now(), spawnError: null, spawnErrorCode: null, closed };
  const capture = { get bytes() { return rec.bytes; }, set bytes(v) { rec.bytes = v; }, get truncated() { return rec.truncated; }, set truncated(v) { rec.truncated = v; } };
  proc.stdout?.on("data", (data) => appendBounded(rec.chunks, data, capture));
  proc.stderr?.on("data", (data) => appendBounded(rec.chunks, data, capture));
  proc.on("error", (error) => {
    rec.spawnError = error.message;
    rec.spawnErrorCode = error.code ?? null;
    appendBounded(rec.chunks, `\n[SPAWN ERROR] ${error.message}`, capture);
    rec.rootExitCode = -1;
    rec.exitCode = -1;
    resolveClosed();
  });
  proc.on("close", async (code) => {
    rec.rootExitCode = code ?? 0;
    if (process.platform === "win32") {
      const captured = extractWindowsDescendants(Buffer.concat(rec.chunks).toString("utf8"));
      rec.chunks = captured.output ? [Buffer.from(captured.output)] : [];
      rec.bytes = Buffer.byteLength(captured.output);
      rec.trackedPids = [...new Set([...captured.pids, ...await currentWindowsDescendants(rec.pid)])];
    }
    if (rec.trackedPids.length === 0) rec.exitCode = rec.rootExitCode;
    resolveClosed();
  });
  procs.set(id, rec);
  return rec;
}

async function settleRecord(rec, timeoutMs = START_SETTLE_MS) {
  await Promise.race([rec.closed, delay(Math.max(0, timeoutMs))]);
  await refreshTrackedProcess(rec);
  return rec;
}

function portReady(port) {
  return new Promise((resolvePromise) => {
    const socket = connect({ host: "127.0.0.1", port });
    const finish = (ready) => { socket.destroy(); resolvePromise(ready); };
    socket.setTimeout(250);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function readinessSatisfied(rec, op) {
  if (op.ready_output && outputOf(rec, 64_000).includes(op.ready_output)) return { ready: true, evidence: `captured output contains ${JSON.stringify(op.ready_output)}` };
  if (op.ready_port && await portReady(op.ready_port)) return { ready: true, evidence: `127.0.0.1:${op.ready_port} accepted a TCP connection` };
  if (op.ready_url) {
    try {
      const response = await fetch(op.ready_url, { signal: AbortSignal.timeout(500) });
      if (response.ok) { await response.body?.cancel(); return { ready: true, evidence: `${op.ready_url} returned HTTP ${response.status}` }; }
      await response.body?.cancel();
    } catch {}
  }
  return { ready: false, evidence: "" };
}

async function awaitStartup(rec, op) {
  const hasReadiness = Boolean(op.ready_output || op.ready_port || op.ready_url);
  const requested = op.startup_timeout_ms ?? (hasReadiness ? DEFAULT_READINESS_TIMEOUT_MS : START_SETTLE_MS);
  const timeoutMs = Math.min(Math.max(Math.floor(requested), START_SETTLE_MS), MAX_READINESS_TIMEOUT_MS);
  const deadline = Date.now() + timeoutMs;
  do {
    await settleRecord(rec, Math.min(100, Math.max(0, deadline - Date.now())));
    if (rec.exitCode !== null) return { ready: false, exited: true, timeoutMs, evidence: "" };
    const readiness = await readinessSatisfied(rec, op);
    if (readiness.ready) return { ready: true, exited: false, timeoutMs, evidence: readiness.evidence };
    if (!hasReadiness && Date.now() >= deadline) return { ready: true, exited: false, timeoutMs, evidence: `process remained alive through the ${timeoutMs}ms startup settlement` };
  } while (Date.now() < deadline);
  return { ready: false, exited: false, timeoutMs, evidence: "readiness condition was not observed before the bounded startup deadline" };
}

async function stopAndConfirm(rec) {
  if (rec.exitCode !== null) return { stopped: true, detail: `already exited (${rec.exitCode})` };
  const termination = await terminateProcessTree(rec.proc, rec.trackedPids);
  await Promise.race([rec.closed, delay(STOP_CONFIRM_TIMEOUT_MS)]);
  await refreshTrackedProcess(rec);
  return rec.exitCode !== null
    ? { stopped: true, detail: `termination confirmed with ${statusOf(rec)} (${termination})` }
    : { stopped: false, detail: `termination was requested but could not be confirmed within ${STOP_CONFIRM_TIMEOUT_MS}ms (${termination})` };
}

function startupRepair(rec) {
  const output = outputOf(rec, 64_000);
  const corrected = quotedExecutableRepair(rec.command, output);
  if (corrected) return { kind: "windows_quoted_executable", command: corrected, diagnostic: output };
  if (transientSpawnFailure(rec.spawnErrorCode)) return { kind: "transient_spawn", command: rec.command, diagnostic: output };
  return null;
}

async function startWithRecovery(op, defaultCwd, id = makeProcId()) {
  const cwd = op.cwd ?? defaultCwd;
  let rec = startProc(op.command, cwd, id, op.label);
  let startup = await awaitStartup(rec, op);
  const repair = startup.exited ? startupRepair(rec) : null;
  if (repair) {
    await delay(repair.kind === "transient_spawn" ? 100 : 0);
    rec = startProc(repair.command, cwd, id, op.label);
    rec.executedCommand = repair.command;
    startup = await awaitStartup(rec, op);
    rec.recovery = { ...repair, succeeded: startup.ready && !startup.exited };
  }
  return { rec, startup };
}

async function runBackgroundOperation(op, defaultCwd) {
  const action = String(op.action ?? "").toLowerCase();
  if (action === "start") {
    if (!op.command) return "Error: `command` is required for start.";
    const { rec, startup } = await startWithRecovery(op, defaultCwd);
    const captured = outputOf(rec, 8_000).trimEnd();
    if (startup.exited || !startup.ready) {
      if (!startup.exited) await stopAndConfirm(rec);
      procs.delete(rec.id);
      return `PROCESS START FAILED\n  ID: ${rec.id}\n  PID: ${rec.pid ?? "unknown"}\n  State: ${statusOf(rec)}\n  Meaning: ${startup.exited ? "The process exited during bounded startup settlement." : startup.evidence}\n  Working directory: ${rec.cwd}\n  Command: ${rec.command}\n--- STARTUP OUTPUT ---\n${captured || "(no output)"}${rec.recovery ? `\n--- AUTOMATIC RECOVERY ---\nOutcome: ${rec.recovery.succeeded ? "SUCCEEDED" : "ATTEMPTED BUT FAILED"}\nDetected: ${rec.recovery.kind}\nCorrection: ${rec.recovery.kind === "windows_quoted_executable" ? "added PowerShell call operator" : "retried identical spawn after 100ms"}\nRetry limit: one; the first attempt could not execute command code.` : ""}\n\nTechnical: start_failed id=${rec.id} pid=${rec.pid ?? "?"} status=${statusOf(rec)}`;
    }
    return `PROCESS ${op.ready_output || op.ready_port || op.ready_url ? "READY" : "STARTED"}\n  ID: ${rec.id}\n  PID: ${rec.pid ?? "unknown"}\n  State: ${statusOf(rec)}\n  Startup evidence: ${startup.evidence}\n  Working directory: ${rec.cwd}\n  Command: ${rec.command}${captured ? `\n--- STARTUP OUTPUT ---\n${captured}` : ""}${rec.recovery ? `\n--- AUTOMATIC RECOVERY ---\nOutcome: SUCCEEDED\nDetected: ${rec.recovery.kind}\nCorrection: ${rec.recovery.kind === "windows_quoted_executable" ? "added PowerShell call operator without changing executable or arguments" : "retried identical spawn after 100ms"}\nRetry limit: one; ordinary process exits are never replayed.` : ""}\n\nTechnical: started id=${rec.id} pid=${rec.pid ?? "?"} status=${statusOf(rec)} cwd=${rec.cwd}`;
  }
  if (action === "list") {
    if (procs.size === 0) return "No background processes.";
    await Promise.all([...procs.values()].map(refreshTrackedProcess));
    const running = [...procs.values()].filter((rec) => rec.exitCode === null).length;
    return [`Background processes (${procs.size} total, ${running} running):`, ...[...procs.values()].map((rec) => `  ${rec.id} pid:${rec.pid ?? "?"} ${statusOf(rec)} ${Math.round((Date.now() - rec.startTime) / 1000)}s${rec.label ? ` [${rec.label}]` : ""} ${rec.command}`)].join("\n");
  }
  if (action === "cleanup") {
    await Promise.all([...procs.values()].map(refreshTrackedProcess));
    let removed = 0;
    for (const [id, rec] of procs) if (rec.exitCode !== null) { procs.delete(id); removed += 1; }
    return `Removed ${removed} exited process record(s) after refreshing lifecycle state.`;
  }
  if (action === "stop_all") {
    const running = [...procs.values()].filter((rec) => rec.exitCode === null);
    const results = await Promise.all(running.map(stopAndConfirm));
    const confirmed = results.filter((result) => result.stopped).length;
    return `Stop completed for ${confirmed} of ${running.length} running process(es).${confirmed < running.length ? ` ${running.length - confirmed} termination(s) were not confirmed within ${STOP_CONFIRM_TIMEOUT_MS}ms.` : ""}`;
  }
  if (!op.id) return "Error: `id` is required for this action.";
  const rec = procs.get(op.id);
  if (!rec) return `Process '${op.id}' not found.`;
  await refreshTrackedProcess(rec);
  if (action === "status") return `PROCESS STATUS\n  ID: ${rec.id}\n  PID: ${rec.pid ?? "unknown"}\n  State: ${statusOf(rec)}\n  Age: ${Math.round((Date.now() - rec.startTime) / 1000)} seconds\n  Tracked child PIDs: ${rec.trackedPids.length ? rec.trackedPids.join(", ") : "none"}\n  Command: ${rec.command}\n\nTechnical: id=${rec.id} pid=${rec.pid ?? "?"} status=${statusOf(rec)}${rec.trackedPids.length ? ` child_pids=${rec.trackedPids.join(",")}` : ""}`;
  if (action === "logs") return `PROCESS LOGS\n  ID: ${rec.id}\n  State: ${statusOf(rec)}\n  Capture complete: ${rec.truncated ? "no; the capture limit was reached" : "yes within the configured bound"}\n--- CAPTURED OUTPUT ---\n${outputOf(rec, Math.min(Math.max(op.tail_chars ?? 32_000, 1_000), 64_000)).trimEnd() || "(no output yet)"}\n\nTechnical: id=${rec.id} status=${statusOf(rec)}${rec.truncated ? " captured_output_truncated=true" : ""}`;
  if (action === "stop") {
    const result = await stopAndConfirm(rec);
    return `Process '${rec.id}': ${result.detail}.`;
  }
  if (action === "restart") {
    await stopAndConfirm(rec);
    const { rec: next, startup } = await startWithRecovery({ ...op, command: rec.command, cwd: rec.cwd, label: rec.label }, defaultCwd, rec.id);
    return `${startup.ready && !startup.exited ? "PROCESS RESTARTED" : "PROCESS RESTART FAILED"}\n  ID: ${next.id}\n  PID: ${next.pid ?? "unknown"}\n  State: ${statusOf(next)}\n  Startup evidence: ${startup.evidence || "process exited during startup"}\n  Command: ${next.command}\n--- STARTUP OUTPUT ---\n${outputOf(next, 8_000).trimEnd() || "(no output)"}`;
  }
  return `Unknown action '${op.action}'. Valid: start, list, status, logs, stop, restart, cleanup, stop_all.`;
}

export const EnhancedTerminalPlugin = async () => ({
  dispose: async () => {
    await Promise.all([...procs.values()].filter((rec) => rec.exitCode === null).map((rec) => terminateProcessTree(rec.proc, rec.trackedPids)));
    procs.clear();
  },
  "tool.execute.before": async (input) => {
    if (input.tool === "shell" || input.tool === "background_process") return;
    const state = getSession({ sessionID: input.sessionID });
    state.lastTool = input.tool;
    state.toolStreak = 1;
    state.pollStreak = 0;
  },
  tool: {
    shell: tool({
      description: `Run 1-${MAX_COMMANDS} finite shell commands in one call and wait for completion. Known no-execution failures may be repaired and retried once inside the same call: a quoted Windows executable missing PowerShell's call operator, or a transient process-spawn resource error. Ordinary nonzero exits, timeouts, cancellations, and potentially side-effecting failures are never replayed. Use mode=parallel for independent tests/builds/checks and mode=sequential for ordered commands whose processes do not share state. For dependent steps that must share shell state (cd, variables, pipelines), put them in one command string. Default timeout ${DEFAULT_TIMEOUT_MS}ms per command; absolute hard maximum ${MAX_TIMEOUT_MS}ms (90 seconds), even if a larger value is requested. At the deadline the full process tree is force-terminated and the tool returns after a bounded termination grace period. Output is bounded. Run only finite commands; servers, watchers, daemons, and intentionally persistent processes are unsupported while background_process is disabled. Do not use Get-Content/cat/rg/Select-String/recursive directory commands as substitutes for fs_read_many range reads, fs_search, or fs_explore; runtime output will flag such substitutions. On Windows use ';' rather than '&&'.`,
      args: {
        commands: tool.schema.array(tool.schema.object({ command: tool.schema.string().min(1), cwd: tool.schema.string().optional(), timeout_ms: tool.schema.number().optional(), label: tool.schema.string().optional() })).min(1).max(MAX_COMMANDS),
        mode: tool.schema.string().optional(),
        stop_on_error: tool.schema.boolean().optional(),
        max_concurrency: tool.schema.number().optional(),
      },
      async execute(args, context) {
        const mode = String(args.mode ?? "parallel").toLowerCase();
        if (!["parallel", "sequential"].includes(mode)) return "Error: mode must be 'parallel' or 'sequential'.";
        const notes = commandAdvice(context, args.commands);
        let results;
        if (mode === "sequential") {
          results = [];
          for (const spec of args.commands) {
            const result = await runCommand(spec, context.directory, context);
            results.push(result);
            if ((args.stop_on_error ?? true) && (result.error || result.timedOut || result.aborted || result.code !== 0)) break;
          }
        } else {
          const concurrency = Math.min(Math.max(Math.floor(args.max_concurrency ?? 4), 1), MAX_CONCURRENCY);
          results = await mapConcurrent(args.commands, concurrency, (spec) => runCommand(spec, context.directory, context));
        }
        return formatCommandResults(results, mode, notes);
      },
    }),
    background_process: tool({
      description: "Manage long-running processes in batches. Pass 1-20 ordered operations: start/list/status/logs/stop/restart/cleanup/stop_all. Start performs bounded startup settlement in the same operation, returns early output, detects safe no-execution failures, and retries once when safe. Optional ready_output, ready_port, or ready_url waits for readiness within startup_timeout_ms so agents do not need polling calls. Multiple independent starts, status checks, log reads, or stops belong in one call. Processes do not push notifications. After starting a process, do useful independent work and check it once when it is likely ready; do not spam repeated status/logs calls. Repeated polling emits escalating advisories but is not delayed or blocked. Always stop processes no longer needed.",
      args: {
        operations: tool.schema.array(tool.schema.object({ action: tool.schema.string(), command: tool.schema.string().optional(), id: tool.schema.string().optional(), cwd: tool.schema.string().optional(), label: tool.schema.string().optional(), tail_chars: tool.schema.number().optional(), ready_output: tool.schema.string().optional(), ready_port: tool.schema.number().optional(), ready_url: tool.schema.string().optional(), startup_timeout_ms: tool.schema.number().optional() })).min(1).max(20),
      },
      async execute(args, context) {
        const notes = backgroundAdvice(context, args.operations);
        const outputs = [];
        for (let index = 0; index < args.operations.length; index += 1) outputs.push(`=== OPERATION ${index + 1}: ${args.operations[index].action} ===\n${await runBackgroundOperation(args.operations[index], context.directory)}`);
        if (notes.length) outputs.push(notes.join("\n"));
        return outputs.join("\n\n");
      },
    }),
  },
});
