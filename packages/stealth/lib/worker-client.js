import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { stealthConfig, packageRoot } from "./config.js";

export class StealthWorkerClient {
  constructor() { this.child = null; this.pending = new Map(); this.sequence = 0; this.stderr = []; this.starting = null; }

  async start() {
    if (this.child && !this.child.killed) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const config = stealthConfig();
      if (!config.python) throw new Error("Stealth Python environment is unavailable. Run `npm run setup` from the tooling repository.");
      const env = { ...process.env, PYTHONUNBUFFERED: "1", OPENCODE_STEALTH_RUNTIME: config.runtimeRoot, OPENCODE_TOR_SOCKS_PORT: String(config.socksPort), OPENCODE_TOR_CONTROL_PORT: String(config.controlPort) };
      if (config.tor) env.OPENCODE_TOR_EXECUTABLE = config.tor;
      const child = spawn(config.python, [resolve(packageRoot, "worker.py")], { cwd: packageRoot, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      this.child = child;
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => this.onLine(line));
      child.stderr.on("data", (chunk) => { this.stderr.push(String(chunk)); if (this.stderr.length > 40) this.stderr.shift(); });
      child.once("exit", (code, signal) => { const error = new Error(`Stealth worker exited (code=${code}, signal=${signal || "none"}). ${this.stderr.join("").slice(-2000)}`); for (const entry of this.pending.values()) entry.reject(error); this.pending.clear(); this.child = null; });
      child.once("error", (error) => { for (const entry of this.pending.values()) entry.reject(error); this.pending.clear(); });
      await this.request("status", {}, 15_000);
    })().finally(() => { this.starting = null; });
    return this.starting;
  }

  onLine(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok) pending.resolve(message.result); else pending.reject(new Error(message.error || "Stealth worker request failed."));
  }

  requestDirect(action, payload, timeoutMs) {
    if (!this.child?.stdin?.writable) throw new Error("Stealth worker is not running.");
    const id = `${process.pid}-${++this.sequence}`;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Stealth ${action} timed out after ${timeoutMs}ms.`)); }, timeoutMs);
      this.pending.set(id, { resolve: resolvePromise, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, action, payload })}\n`, (error) => { if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); } });
    });
  }

  async request(action, payload = {}, timeoutMs = 120_000) {
    if (!this.child) await this.start();
    return this.requestDirect(action, payload, timeoutMs);
  }

  async stop() {
    if (!this.child) return;
    const child = this.child;
    try { await this.requestDirect("shutdown", {}, 10_000); } catch {}
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    this.child = null;
  }
}
