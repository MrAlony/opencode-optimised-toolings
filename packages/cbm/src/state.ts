import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

interface FreshnessRecord {
  fingerprint: string;
  indexedAt: string;
}

interface FreshnessState {
  roots: Record<string, FreshnessRecord>;
}

const STATE_PATH = join(homedir(), ".cache", "oc-cbm", "freshness.json");
const MAX_NON_GIT_ENTRIES = 20_000;
const SKIP_DIRECTORIES = new Set([".git", ".hg", ".svn", "node_modules", "target", "dist", "build", ".next", ".cache", "coverage"]);

function normalizePath(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function readFreshnessState(): FreshnessState {
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, "utf8")) as Partial<FreshnessState>;
    return { roots: parsed.roots && typeof parsed.roots === "object" ? parsed.roots : {} };
  } catch {
    return { roots: {} };
  }
}

function writeFreshnessState(state: FreshnessState): void {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  const temporary = `${STATE_PATH}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, STATE_PATH);
}

/** Resolves an existing directory, preferring the canonical Git worktree root when available. */
export function getProjectRoot(projectPath: string): string {
  const canonical = realpathSync.native(projectPath);
  if (!statSync(canonical).isDirectory()) throw new Error("Project path is not a directory.");
  try {
    const root = execFileSync("git", ["-C", canonical, "rev-parse", "--show-toplevel"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5_000, windowsHide: true,
    }).trim();
    if (root) return realpathSync.native(root).replace(/\\/g, "/");
  } catch { /* Non-Git directories are supported by CBM indexing. */ }
  return canonical.replace(/\\/g, "/");
}

/** Preserved compatibility helper for callers that require a Git worktree. */
export function getGitRoot(projectPath: string): string {
  const root = getProjectRoot(projectPath);
  const gitRoot = execFileSync("git", ["-C", root, "rev-parse", "--show-toplevel"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5_000, windowsHide: true,
  }).trim();
  if (!gitRoot) throw new Error("Git returned an empty worktree root.");
  return realpathSync.native(gitRoot).replace(/\\/g, "/");
}

export function isGitRepo(projectPath: string): boolean {
  try { getGitRoot(projectPath); return true; } catch { return false; }
}

function gitFingerprint(root: string): string | null {
  try {
    const options = { encoding: "utf8" as const, stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"], timeout: 15_000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 };
    const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], options).trim();
    const trackedDiff = execFileSync("git", ["-C", root, "diff", "--no-ext-diff", "--binary", "HEAD", "--"], options);
    const untrackedText = execFileSync("git", ["-C", root, "ls-files", "--others", "--exclude-standard", "-z"], options);
    const hash = createHash("sha256").update(`git\0${head}\0tracked\0${trackedDiff}\0untracked\0`);
    const untracked = untrackedText.split("\0").filter(Boolean).sort();
    if (untracked.length > MAX_NON_GIT_ENTRIES) return null;
    for (const relative of untracked) {
      const path = join(root, relative);
      const stat = statSync(path);
      hash.update(`${relative.replace(/\\/g, "/")}\0${stat.size}\0`);
      if (stat.size <= 8 * 1024 * 1024) hash.update(readFileSync(path));
      else hash.update(`large-file-mtime\0${Math.trunc(stat.mtimeMs)}`);
      hash.update("\0");
    }
    return hash.digest("hex");
  } catch {
    return null;
  }
}

function nonGitFingerprint(root: string): { fingerprint: string; complete: boolean; entries: number } {
  const records: string[] = [];
  let complete = true;
  const visit = (directory: string): void => {
    if (!complete) return;
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { complete = false; return; }
    entries.sort((left: { name: string }, right: { name: string }) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue;
      const path = join(directory, entry.name);
      const relative = path.slice(root.length).replace(/^[/\\]+/, "").replace(/\\/g, "/");
      try {
        const stat = statSync(path);
        records.push(`${entry.isDirectory() ? "d" : "f"}\0${relative}\0${stat.size}\0${Math.trunc(stat.mtimeMs)}`);
      } catch { complete = false; return; }
      if (records.length >= MAX_NON_GIT_ENTRIES) { complete = false; return; }
      if (entry.isDirectory()) visit(path);
      if (!complete) return;
    }
  };
  visit(root);
  return { fingerprint: createHash("sha256").update(records.join("\n")).digest("hex"), complete, entries: records.length };
}

export function fingerprintProject(rootPath: string): { fingerprint: string; complete: boolean; kind: "git" | "filesystem"; entries?: number } {
  const root = getProjectRoot(rootPath);
  const git = gitFingerprint(root);
  if (git) return { fingerprint: git, complete: true, kind: "git" };
  const filesystem = nonGitFingerprint(root);
  return { ...filesystem, kind: "filesystem" };
}

export function recordIndexedFingerprint(rootPath: string): FreshnessRecord & { complete: boolean; kind: string; entries?: number } {
  const root = getProjectRoot(rootPath);
  const snapshot = fingerprintProject(root);
  const record = { fingerprint: snapshot.fingerprint, indexedAt: new Date().toISOString() };
  const state = readFreshnessState();
  state.roots[normalizePath(root)] = record;
  writeFreshnessState(state);
  return { ...record, complete: snapshot.complete, kind: snapshot.kind, entries: snapshot.entries };
}

export function assessIndexedFreshness(rootPath: string): {
  status: "fresh" | "stale" | "unknown" | "unverifiable";
  indexedAt?: string;
  kind?: string;
  entries?: number;
  reason: string;
} {
  if (!existsSync(rootPath)) return { status: "unverifiable", reason: "indexed root no longer exists" };
  let root: string;
  try { root = getProjectRoot(rootPath); } catch (error) { return { status: "unverifiable", reason: error instanceof Error ? error.message : String(error) }; }
  const stored = readFreshnessState().roots[normalizePath(root)];
  if (!stored) return { status: "unknown", reason: "no wrapper freshness fingerprint exists; reindex once to establish a baseline" };
  const current = fingerprintProject(root);
  if (!current.complete) return { status: "unverifiable", indexedAt: stored.indexedAt, kind: current.kind, entries: current.entries, reason: `current ${current.kind} fingerprint reached its bounded scan limit` };
  return current.fingerprint === stored.fingerprint
    ? { status: "fresh", indexedAt: stored.indexedAt, kind: current.kind, entries: current.entries, reason: "current source fingerprint matches the indexed baseline" }
    : { status: "stale", indexedAt: stored.indexedAt, kind: current.kind, entries: current.entries, reason: "current source fingerprint differs from the indexed baseline" };
}

export function forgetIndexedFingerprint(rootPath: string): void {
  try {
    const root = getProjectRoot(rootPath);
    const state = readFreshnessState();
    delete state.roots[normalizePath(root)];
    writeFreshnessState(state);
  } catch { /* Missing roots have no canonical key to remove safely. */ }
}

export function projectNameFromRoot(rootPath: string): string {
  const canonical = getProjectRoot(rootPath).replace(/\\/g, "/");
  return canonical.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || basename(rootPath);
}
