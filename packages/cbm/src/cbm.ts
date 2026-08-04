import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { get as httpsGet, type RequestOptions } from "node:https";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CACHE_DIR = join(homedir(), ".cache", "oc-cbm", "bin");
const QUERY_TIMEOUT_MS = readPositiveInteger("OC_CBM_QUERY_TIMEOUT_MS", 30_000);
const INDEX_TIMEOUT_MS = readPositiveInteger("OC_CBM_INDEX_TIMEOUT_MS", 180_000);
const INSTALL_TIMEOUT_MS = readPositiveInteger("OC_CBM_INSTALL_TIMEOUT_MS", 60_000);
const MAX_OUTPUT_BYTES = 50 * 1024 * 1024;

export interface InvokeOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Reads a positive integer environment override.
 * Params: name (string) is the environment variable; fallback (number) is used for missing or invalid values.
 * Returns: number containing a positive integer.
 * Side effects: Reads process.env.
 * Assumptions: Values larger than Number.MAX_SAFE_INTEGER are invalid.
 */
function readPositiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/**
 * Returns the platform-specific CBM executable filename.
 * Params: None.
 * Returns: string executable filename.
 * Side effects: None.
 * Assumptions: Windows binaries use the .exe suffix.
 */
function binName(): string {
  return platform() === "win32" ? "codebase-memory-mcp.exe" : "codebase-memory-mcp";
}

/**
 * Returns the plugin-managed binary directory.
 * Params: None.
 * Returns: string absolute cache directory.
 * Side effects: None.
 * Assumptions: The user's home directory is available.
 */
function binDir(): string {
  return CACHE_DIR;
}

/**
 * Returns the plugin-managed CBM binary path.
 * Params: None.
 * Returns: string absolute executable path.
 * Side effects: None.
 * Assumptions: The binary may not exist yet.
 */
function binPath(): string {
  return join(binDir(), binName());
}

/**
 * Maps the current OS and CPU architecture to a CBM release asset tag.
 * Params: None.
 * Returns: string release platform tag.
 * Side effects: None.
 * Assumptions: CBM publishes Windows x64 and macOS/Linux x64 or arm64 builds.
 */
function platformTag(): string {
  const os = platform();
  const arch = process.arch;
  if (os === "win32" && arch === "x64") return "windows-amd64";
  if (os === "darwin") return arch === "arm64" ? "darwin-arm64" : "darwin-amd64";
  if (os === "linux") return arch === "arm64" ? "linux-arm64" : "linux-amd64";
  throw new Error(`Unsupported platform: ${os} ${arch}`);
}

/**
 * Returns the archive extension used by the current platform.
 * Params: None.
 * Returns: string archive extension.
 * Side effects: None.
 * Assumptions: Windows releases are zip files and Unix releases are tar.gz files.
 */
function archiveExt(): string {
  return platform() === "win32" ? "zip" : "tar.gz";
}

/**
 * Locates CBM using an explicit override, the plugin cache, or PATH.
 * Params: None.
 * Returns: Promise<string | null> containing an absolute binary path when found.
 * Side effects: May execute the OS path lookup command with a five-second deadline.
 * Assumptions: OC_CBM_BINARY, when set, points to a trusted executable.
 */
export async function locateCbm(): Promise<string | null> {
  const override = process.env.OC_CBM_BINARY;
  if (override) return existsSync(override) ? resolve(override) : null;
  const cached = binPath();
  if (existsSync(cached)) return cached;

  try {
    const command = platform() === "win32" ? "where.exe" : "which";
    const { stdout } = await execFileAsync(command, ["codebase-memory-mcp"], {
      encoding: "utf-8",
      timeout: 5_000,
      windowsHide: true,
    });
    const found = stdout.trim().split(/\r?\n/, 1)[0];
    return found ? resolve(found) : null;
  } catch {
    return null;
  }
}

/**
 * Ensures a usable CBM binary exists, downloading and extracting it when necessary.
 * Params: signal (AbortSignal | undefined) cancels network and extraction work.
 * Returns: Promise<string> containing the absolute binary path.
 * Side effects: Downloads a release archive and writes files under ~/.cache/oc-cbm.
 * Assumptions: GitHub release asset names follow CBM's documented convention.
 */
export async function ensureCbm(signal?: AbortSignal): Promise<string> {
  const existing = await locateCbm();
  if (existing) return existing;

  const tag = await fetchLatestReleaseTag(signal);
  const osTag = platformTag();
  const ext = archiveExt();
  const url = `https://github.com/DeusData/codebase-memory-mcp/releases/download/${tag}/codebase-memory-mcp-${osTag}.${ext}`;
  mkdirSync(binDir(), { recursive: true });

  const dest = join(binDir(), `codebase-memory-mcp-${osTag}.${ext}`);
  await downloadFile(url, dest, signal);

  if (ext === "zip") {
    await runProcess("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force", dest, binDir()], INSTALL_TIMEOUT_MS, signal);
  } else {
    await runProcess("tar", ["xzf", dest, "-C", binDir()], INSTALL_TIMEOUT_MS, signal);
    await runProcess("chmod", ["+x", binPath()], INSTALL_TIMEOUT_MS, signal);
  }

  if (!existsSync(binPath())) throw new Error(`CBM archive did not contain ${binName()}.`);
  return binPath();
}

/**
 * Fetches the latest CBM GitHub release tag with a bounded request.
 * Params: signal (AbortSignal | undefined) cancels the request.
 * Returns: Promise<string> containing the release tag.
 * Side effects: Performs one HTTPS request.
 * Assumptions: GitHub returns JSON containing a non-empty tag_name.
 */
function fetchLatestReleaseTag(signal?: AbortSignal): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const opts: RequestOptions = {
      headers: { "User-Agent": "oc-cbm/0.2.0", Accept: "application/vnd.github.v3+json" },
      signal,
      timeout: 15_000,
    };
    const req = httpsGet("https://api.github.com/repos/DeusData/codebase-memory-mcp/releases/latest", opts, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        data += chunk;
        if (data.length > 1_000_000) req.destroy(new Error("GitHub release response exceeded 1 MB."));
      });
      res.on("end", () => {
        try {
          const json = JSON.parse(data) as { tag_name?: unknown };
          if (typeof json.tag_name !== "string" || !json.tag_name) throw new Error("Missing tag_name.");
          resolvePromise(json.tag_name);
        } catch (error) {
          reject(new Error(`Failed to parse GitHub release response: ${error instanceof Error ? error.message : String(error)}`));
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("GitHub release request timed out after 15000ms.")));
    req.on("error", reject);
  });
}

/**
 * Downloads a release archive while bounding redirects, duration, and partial-file cleanup.
 * Params: url (string), dest (string), signal (AbortSignal | undefined), redirects (number).
 * Returns: Promise<void> after the file is fully flushed.
 * Side effects: Writes dest and deletes it on failure.
 * Assumptions: Redirect locations are absolute HTTPS URLs.
 */
function downloadFile(url: string, dest: string, signal?: AbortSignal, redirects = 5): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const file = createWriteStream(dest);
    const fail = (error: Error) => {
      file.destroy();
      try { unlinkSync(dest); } catch { /* The partial file may not exist. */ }
      reject(error);
    };
    const req = httpsGet(url, {
      headers: { "User-Agent": "oc-cbm/0.2.0" },
      signal,
      timeout: 30_000,
    }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        file.close();
        try { unlinkSync(dest); } catch { /* No completed file exists yet. */ }
        if (redirects <= 0) {
          reject(new Error("CBM download exceeded five redirects."));
          return;
        }
        downloadFile(res.headers.location, dest, signal, redirects - 1).then(resolvePromise, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        fail(new Error(`Download failed (${res.statusCode ?? "unknown status"}): ${url}`));
        return;
      }
      res.pipe(file);
      file.on("finish", () => file.close(() => resolvePromise()));
    });
    req.on("timeout", () => req.destroy(new Error("CBM download timed out after 30000ms.")));
    req.on("error", fail);
    file.on("error", fail);
  });
}

/**
 * Terminates a child and its descendants after cancellation or timeout.
 * Params: child (ChildProcess) is the process to terminate.
 * Returns: Promise<void> after a best-effort termination request.
 * Side effects: Sends termination signals or invokes taskkill on Windows.
 * Assumptions: The child PID remains valid only while child.exitCode is null.
 */
async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null) return;
  if (platform() === "win32") {
    try {
      await execFileAsync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { timeout: 5_000, windowsHide: true });
    } catch {
      child.kill("SIGKILL");
    }
    return;
  }
  try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
}

/**
 * Executes a process without a shell and enforces output, abort, and time limits.
 * Params: command (string), args (string[]), timeoutMs (number), signal (AbortSignal | undefined).
 * Returns: Promise<string> containing trimmed stdout.
 * Side effects: Starts and may forcibly terminate a child process tree.
 * Assumptions: The command writes its machine-readable result to stdout and diagnostics to stderr.
 */
export async function runProcess(command: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw new Error("CBM operation cancelled before start.");

  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env },
      windowsHide: true,
      detached: platform() !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let stoppingReason: string | null = null;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolvePromise(stdout.trim());
    };
    const stop = (message: string) => {
      if (settled || stoppingReason) return;
      stoppingReason = message;
      void terminateProcessTree(child).finally(() => finish(new Error(message)));
    };
    const onAbort = () => stop("CBM operation cancelled by OpenCode.");
    const timer = setTimeout(() => {
      timedOut = true;
      stop(`CBM operation timed out after ${timeoutMs}ms and was terminated.`);
    }, timeoutMs);

    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) stop("CBM stdout exceeded the 50 MB safety limit.");
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr) > MAX_OUTPUT_BYTES) stop("CBM stderr exceeded the 50 MB safety limit.");
    });
    child.on("error", (error) => finish(new Error(`Failed to start CBM: ${error.message}`)));
    child.on("close", (code, processSignal) => {
      if (settled) return;
      if (stoppingReason) { finish(new Error(stoppingReason)); return; }
      if (timedOut) return;
      if (code === 0) finish();
      else finish(new Error(`CBM exited with code ${code ?? "null"}${processSignal ? ` (${processSignal})` : ""}: ${stderr.trim() || "no diagnostic output"}`));
    });
  });
}

/**
 * Invokes one CBM CLI tool asynchronously with a per-operation deadline.
 * Params: toolName (string), args (record), options (InvokeOptions).
 * Returns: Promise<string> containing CBM's JSON output.
 * Side effects: Creates a temporary args file and starts the CBM binary.
 * Assumptions: index_repository accepts --repo-path and --mode; other tools accept --args-file.
 */
export async function invokeCbm(toolName: string, args: Record<string, unknown> = {}, options: InvokeOptions = {}): Promise<string> {
  const binary = await ensureCbm(options.signal);
  const timeoutMs = options.timeoutMs ?? (toolName === "index_repository" ? INDEX_TIMEOUT_MS : QUERY_TIMEOUT_MS);

  if (toolName === "index_repository") {
    const repoPath = args.repo_path;
    if (typeof repoPath !== "string" || !repoPath) throw new Error("index_repository requires repo_path.");
    const mode = typeof args.mode === "string" ? args.mode : "fast";
    return runProcess(binary, ["cli", toolName, "--repo-path", repoPath, "--mode", mode], timeoutMs, options.signal);
  }
  if (Object.keys(args).length === 0) return runProcess(binary, ["cli", toolName], timeoutMs, options.signal);

  const cacheDir = join(homedir(), ".cache", "oc-cbm");
  mkdirSync(cacheDir, { recursive: true });
  const tmpFile = join(cacheDir, `args-${toolName}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  writeFileSync(tmpFile, JSON.stringify(args), "utf-8");
  try {
    return await runProcess(binary, ["cli", toolName, "--args-file", tmpFile], timeoutMs, options.signal);
  } finally {
    try { unlinkSync(tmpFile); } catch { /* Cleanup is best effort after process termination. */ }
  }
}
