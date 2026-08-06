import { tool } from "@opencode-ai/plugin/tool";
import type { ToolContext } from "@opencode-ai/plugin/tool";
import { invokeCbm } from "./cbm.js";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { assessIndexedFreshness, getProjectRoot, isGitRepo, projectNameFromRoot, recordIndexedFingerprint } from "./state.js";

const s = tool.schema;
const SECTION_LIMIT = 24 * 1024;
const INVESTIGATION_LIMIT = 44 * 1024;
const MAX_SNIPPETS = 3;
const SEMANTIC_SCORE_THRESHOLD = 0.18;
type Freshness = ReturnType<typeof assessIndexedFreshness>;
type StructuralVerification = {
  status: "consistent" | "inconsistent" | "unverifiable";
  reason: string;
  currentCount: number;
  indexedCount: number;
  missingCurrentFiles: string[];
  staleIndexedFiles: string[];
};

type IndexRepair = {
  refreshed: boolean;
  shared: boolean;
  reason: string;
  durationMs: number;
  freshness: Freshness;
  structure: StructuralVerification;
  refreshAttempts: number;
  backendOutput?: string;
};

const activeIndexes = new Map<string, Promise<IndexRepair>>();
const INDEXABLE_EXTENSIONS = new Set([".c", ".cc", ".cpp", ".cs", ".go", ".h", ".hpp", ".java", ".js", ".jsx", ".kt", ".kts", ".md", ".php", ".py", ".rb", ".rs", ".svelte", ".swift", ".ts", ".tsx", ".vue"]);
const INVENTORY_SKIP_DIRECTORIES = new Set([".git", ".hg", ".svn", ".cache", ".next", ".venv", "__pycache__", "build", "coverage", "dist", "node_modules", "target", "tools", "venv"]);
const INVENTORY_SKIP_FILE_PATTERNS = [/^config\/backup-/i, /(?:^|\/)settings\.local\.ya?ml$/i, /(?:^|\/)secrets\.local\.json$/i];
const MAX_STRUCTURAL_FILES = 20_000;
const MAX_STRUCTURAL_DIFFERENCES = 40;

type JsonRecord = Record<string, unknown>;
type Candidate = {
  name: string;
  qualifiedName: string;
  label: string;
  filePath: string;
  score?: number;
  lexicalScore: number;
  source: "structured" | "semantic";
};

function bounded(value: string, limit = SECTION_LIMIT): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n[CBM SECTION TRUNCATED at ${limit} characters.]`;
}

function section(title: string, value: string, limit = SECTION_LIMIT): string {
  return `=== ${title} ===\n${bounded(value || "No data returned.", limit)}`;
}

function projectRecord(value: unknown): JsonRecord | null {
  const record = asRecord(value);
  return record && typeof record.name === "string" && typeof record.root_path === "string" ? record : null;
}

export function formatProjectList(raw: string): string {
  const root = asRecord(parseJson(raw));
  const projects = asArray(root?.projects).map(projectRecord).filter((value): value is JsonRecord => Boolean(value));
  if (!root || !projects.length) return section("INDEXED CBM PROJECTS", raw || "No projects indexed yet.");
  const active = projects.filter((item) => asRecord(item.git)?.root_exists !== false);
  const missing = projects.filter((item) => asRecord(item.git)?.root_exists === false);
  const compact = (items: JsonRecord[]) => items.map((item) => ({
    name: item.name,
    root_path: item.root_path,
    nodes: item.nodes,
    edges: item.edges,
    size_bytes: item.size_bytes,
    git: item.git,
  }));
  return [
    section("ACTIVE CBM PROJECTS", JSON.stringify({ count: active.length, projects: compact(active) }, null, 2)),
    section("MISSING-ROOT CBM PROJECTS", JSON.stringify({ count: missing.length, projects: compact(missing), note: "These indexes are preserved but separated because their source roots no longer exist. Delete them explicitly with alonix-index-project(action=\"delete\")." }, null, 2)),
    `=== PROJECT LIST SUMMARY ===\nactive=${active.length}; missing_root=${missing.length}; total=${projects.length}; automatic_deletion=false.`,
  ].join("\n\n");
}

async function getProjectHealth(project: string, context: ToolContext): Promise<{ statusRecord: JsonRecord; freshness: ReturnType<typeof assessIndexedFreshness>; rootPath: string }> {
  const raw = await invokeCbm("index_status", { project }, { signal: context.abort });
  const statusRecord = asRecord(parseJson(raw));
  if (!statusRecord || typeof statusRecord.root_path !== "string") throw new Error(`Project ${project} is not indexed or returned invalid status data.`);
  const git = asRecord(statusRecord.git);
  if (git?.root_exists === false) throw new Error(`Indexed root no longer exists: ${statusRecord.root_path}. Delete the stale project or restore its source root.`);
  return { statusRecord, freshness: assessIndexedFreshness(statusRecord.root_path), rootPath: statusRecord.root_path };
}

function freshnessSection(freshness: Freshness): string {
  return section("INDEX FRESHNESS", [
    `Status: ${freshness.status.toUpperCase()}`,
    `Meaning: ${freshness.reason}`,
    freshness.indexedAt ? `Indexed baseline recorded: ${freshness.indexedAt}` : "Indexed baseline recorded: no",
    freshness.kind ? `Source fingerprint type: ${freshness.kind}` : "",
    freshness.entries !== undefined ? `Filesystem entries examined: ${freshness.entries}` : "",
  ].filter(Boolean).join("\n"), 3 * 1024);
}

function repairSection(repair: IndexRepair): string {
  return section("INDEX READINESS", [
    `Outcome: ${repair.refreshed ? "INDEX REFRESHED AND VERIFIED INSIDE THIS TOOL CALL" : "EXISTING VERIFIED INDEX USED"}`,
    `Reason: ${repair.reason}`,
    `Shared refresh: ${repair.shared ? "yes; a concurrent call performed the same repair" : "no"}`,
    `Refresh attempts: ${repair.refreshAttempts}`,
    `Refresh duration: ${repair.durationMs} ms`,
    `Source fingerprint: ${repair.freshness.status.toUpperCase()} — ${repair.freshness.reason}`,
    `Graph/source structure: ${repair.structure.status.toUpperCase()} — ${repair.structure.reason}`,
    `Structural inventory: current=${repair.structure.currentCount}; indexed=${repair.structure.indexedCount}`,
    "Tool-call impact: no additional agent-visible CBM call was required.",
  ].join("\n"), 5 * 1024);
}

function normalizeInventoryPath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isIndexableInventoryPath(path: string): boolean {
  const normalized = normalizeInventoryPath(path);
  if (!INDEXABLE_EXTENSIONS.has(extname(normalized).toLowerCase())) return false;
  if (/\.min\.(?:c?js|css)$/i.test(normalized)) return false;
  const segments = normalized.split("/");
  if (segments.some((segment) => INVENTORY_SKIP_DIRECTORIES.has(segment))) return false;
  return !INVENTORY_SKIP_FILE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function hasStructuralDeclarations(rootPath: string, path: string): boolean {
  const extension = extname(path).toLowerCase();
  let source: string;
  try { source = readFileSync(join(rootPath, path), "utf8").slice(0, 512 * 1024); }
  catch { return true; }

  if (extension === ".md") return /^#{1,6}\s+\S/m.test(source);
  if (extension === ".py") return /^\s*(?:async\s+def|def|class)\s+[A-Za-z_]/m.test(source);
  if ([".js", ".jsx", ".ts", ".tsx", ".svelte", ".vue"].includes(extension)) {
    return /(?:^|[\n;}])\s*(?:export\s+|import\s+|(?:async\s+)?function\s+[A-Za-z_$]|class\s+[A-Za-z_$]|interface\s+[A-Za-z_$]|type\s+[A-Za-z_$]|enum\s+[A-Za-z_$]|(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=)/m.test(source);
  }
  if ([".c", ".cc", ".cpp", ".h", ".hpp", ".cs", ".java", ".kt", ".kts", ".go", ".php", ".rb", ".rs", ".swift"].includes(extension)) {
    return /\b(?:class|interface|struct|enum|trait|impl|fn|func|function|def|module|namespace|record)\s+[A-Za-z_]|\b[A-Za-z_][\w:<>,*&\s]+\s+[A-Za-z_]\w*\s*\([^;{}]*\)\s*\{/m.test(source);
  }
  return true;
}

function collectGitIndexableFiles(rootPath: string): string[] | null {
  try {
    const output = execFileSync("git", ["-C", rootPath, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 10_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return [...new Set(output.split("\0").filter(Boolean).map(normalizeInventoryPath).filter(isIndexableInventoryPath).filter((path) => hasStructuralDeclarations(rootPath, path)))].sort();
  } catch {
    return null;
  }
}

export function collectIndexableFiles(rootPath: string): { files: string[]; complete: boolean; reason: string } {
  const gitFiles = collectGitIndexableFiles(rootPath);
  if (gitFiles) {
    if (gitFiles.length > MAX_STRUCTURAL_FILES) return { files: gitFiles.slice(0, MAX_STRUCTURAL_FILES), complete: false, reason: `Git-aware source inventory exceeded the ${MAX_STRUCTURAL_FILES}-file verification limit` };
    return { files: gitFiles, complete: true, reason: "Git-aware source inventory completed using tracked and non-ignored files" };
  }

  const files: string[] = [];
  let complete = true;
  let reason = "bounded source inventory completed";
  const visit = (directory: string): void => {
    if (!complete) return;
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); }
    catch (error) { complete = false; reason = `source inventory could not read ${directory}: ${error instanceof Error ? error.message : String(error)}`; return; }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isDirectory() && INVENTORY_SKIP_DIRECTORIES.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) {
        const relativePath = normalizeInventoryPath(relative(rootPath, path));
        if (isIndexableInventoryPath(relativePath) && hasStructuralDeclarations(rootPath, relativePath)) files.push(relativePath);
      }
      if (files.length > MAX_STRUCTURAL_FILES) { complete = false; reason = `source inventory exceeded the ${MAX_STRUCTURAL_FILES}-file verification limit`; return; }
      if (!complete) return;
    }
  };
  visit(rootPath);
  return { files: [...new Set(files)].sort(), complete, reason };
}

export function compareIndexedStructure(rootPath: string, indexedPaths: string[]): StructuralVerification {
  const current = collectIndexableFiles(rootPath);
  if (!current.complete) return { status: "unverifiable", reason: current.reason, currentCount: current.files.length, indexedCount: indexedPaths.length, missingCurrentFiles: [], staleIndexedFiles: [] };
  const indexed = [...new Set(indexedPaths.map(normalizeInventoryPath).filter(Boolean))].sort();
  const indexedSet = new Set(indexed);
  const missingCurrentFiles = current.files.filter((path) => !indexedSet.has(path)).slice(0, MAX_STRUCTURAL_DIFFERENCES);
  const staleIndexedFiles = indexed.filter((path) => isIndexableInventoryPath(path) && !existsSync(join(rootPath, path))).slice(0, MAX_STRUCTURAL_DIFFERENCES);
  if (missingCurrentFiles.length || staleIndexedFiles.length) {
    return {
      status: "inconsistent",
      reason: `graph/source file inventory differs (missing current=${missingCurrentFiles.length}; removed but indexed=${staleIndexedFiles.length})`,
      currentCount: current.files.length,
      indexedCount: indexed.length,
      missingCurrentFiles,
      staleIndexedFiles,
    };
  }
  return { status: "consistent", reason: "all current indexable files are represented and no indexed file path is removed", currentCount: current.files.length, indexedCount: indexed.length, missingCurrentFiles: [], staleIndexedFiles: [] };
}

function parseIndexedFilePaths(raw: string): string[] {
  const parsed = asRecord(parseJson(raw));
  const columns = asArray(parsed?.columns).map(String);
  const fileIndex = Math.max(0, columns.indexOf("file_path"));
  return asArray(parsed?.rows).map((row) => Array.isArray(row) ? row[fileIndex] : asRecord(row)?.file_path).filter((value): value is string => typeof value === "string" && value.length > 0);
}

async function verifyIndexedStructure(rootPath: string, project: string, context: ToolContext): Promise<StructuralVerification> {
  const currentCount = collectIndexableFiles(rootPath).files.length;
  let raw: string;
  try {
    raw = await invokeCbm("query_graph", { project, query: "MATCH (f:File) RETURN f.file_path AS file_path" }, { signal: context.abort });
  } catch (error) {
    return { status: "unverifiable", reason: `graph file inventory could not be queried: ${error instanceof Error ? error.message : String(error)}`, currentCount, indexedCount: 0, missingCurrentFiles: [], staleIndexedFiles: [] };
  }
  const paths = parseIndexedFilePaths(raw);
  if (!paths.length) return { status: "unverifiable", reason: "graph file inventory query returned no file paths", currentCount, indexedCount: 0, missingCurrentFiles: [], staleIndexedFiles: [] };
  return compareIndexedStructure(rootPath, paths);
}

export async function repairIndexIfNeeded(
  rootPath: string,
  initial: Freshness,
  refresh: () => Promise<string>,
  verify: () => Promise<StructuralVerification> = async () => ({ status: "consistent", reason: "structural verification was not requested by this caller", currentCount: 0, indexedCount: 0, missingCurrentFiles: [], staleIndexedFiles: [] }),
): Promise<IndexRepair> {
  if (initial.status === "unverifiable" && /no longer exists/i.test(initial.reason)) throw new Error(`Cannot refresh index because ${initial.reason}.`);
  const existing = activeIndexes.get(rootPath);
  if (existing) return { ...await existing, shared: true };
  const started = Date.now();
  const operation = (async (): Promise<IndexRepair> => {
    let freshness = initial;
    let structure = await verify();
    let refreshAttempts = 0;
    let backendOutput = "";
    const initialReason = freshness.status === "fresh" && structure.status === "consistent"
      ? "the source fingerprint and graph/source file inventory are both current"
      : freshness.status === "unknown"
        ? "the existing index has no wrapper freshness baseline"
        : freshness.status === "stale"
          ? "the source changed after the existing index was created"
          : structure.status !== "consistent"
            ? `graph/source structural verification was ${structure.status} (${structure.reason})`
            : `freshness could not be verified (${freshness.reason})`;
    while ((freshness.status !== "fresh" || structure.status !== "consistent") && refreshAttempts < 2) {
      refreshAttempts += 1;
      backendOutput = await refresh();
      const recorded = recordIndexedFingerprint(rootPath);
      freshness = assessIndexedFreshness(rootPath);
      if (!recorded.complete || freshness.status !== "fresh") throw new Error(`Refresh attempt ${refreshAttempts} completed, but source verification was ${freshness.status}: ${freshness.reason}`);
      structure = await verify();
    }
    if (freshness.status !== "fresh" || structure.status !== "consistent") {
      const missing = structure.missingCurrentFiles.length ? `\nMissing current files: ${structure.missingCurrentFiles.join(", ")}` : "";
      const stale = structure.staleIndexedFiles.length ? `\nRemoved but still indexed files: ${structure.staleIndexedFiles.join(", ")}` : "";
      throw new Error(`CBM graph remained structurally ${structure.status} after ${refreshAttempts} bounded refresh attempt(s): ${structure.reason}.${missing}${stale}`);
    }
    return { refreshed: refreshAttempts > 0, shared: false, reason: initialReason, durationMs: Date.now() - started, freshness, structure, refreshAttempts, backendOutput };
  })();
  activeIndexes.set(rootPath, operation);
  try { return await operation; }
  finally { if (activeIndexes.get(rootPath) === operation) activeIndexes.delete(rootPath); }
}

async function ensureQueryReady(project: string, context: ToolContext): Promise<{ statusRecord: JsonRecord; freshness: Freshness; rootPath: string; repair: IndexRepair }> {
  const health = await getProjectHealth(project, context);
  const repair = await repairIndexIfNeeded(
    health.rootPath,
    health.freshness,
    () => invokeCbm("index_repository", { repo_path: health.rootPath, mode: "fast" }, { signal: context.abort }),
    () => verifyIndexedStructure(health.rootPath, project, context),
  );
  return { ...health, freshness: repair.freshness, repair };
}

async function safeInvoke(toolName: string, args: Record<string, unknown>, context: ToolContext): Promise<string> {
  try {
    return await invokeCbm(toolName, args, { signal: context.abort });
  } catch (error) {
    return `ERROR: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return null; }
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractQueryTerms(query: string): string[] {
  const raw = query.match(/[A-Za-z_][A-Za-z0-9_:.-]{2,}/g) ?? [];
  const stop = new Set(["the", "and", "for", "with", "from", "that", "this", "through", "into", "plus", "shown", "user", "only", "while", "during", "compare", "identify", "trace", "diagnose", "specific", "appear", "disappear", "visible", "changes", "outputs", "bindings", "textures"]);
  const ranked = raw
    .filter((term) => !stop.has(term.toLowerCase()))
    .map((term) => ({
      term,
      weight: /[A-Z_:.]/.test(term) ? 3 : term.length >= 9 ? 2 : 1,
    }))
    .sort((a, b) => b.weight - a.weight || b.term.length - a.term.length);
  const seen = new Set<string>();
  const output: string[] = [];
  for (const item of ranked) {
    const normalized = item.term.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(item.term);
    if (output.length >= 16) break;
  }
  return output;
}

export function deriveCodePattern(query: string, functionName?: string): string {
  const terms = [...(functionName ? [functionName] : []), ...extractQueryTerms(query)];
  const unique = [...new Set(terms.map((term) => term.replace(/^[^A-Za-z_]+|[^A-Za-z0-9_:.-]+$/g, "")).filter(Boolean))];
  return unique.slice(0, 16).map(escapeRegex).join("|") || escapeRegex(query.slice(0, 120));
}

function globToRegex(glob: string): RegExp | null {
  if (!glob) return null;
  let source = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === "*") {
      if (glob[index + 1] === "*") { source += ".*"; index += 1; }
      else source += "[^/\\\\]*";
    } else if (char === "?") source += ".";
    else if (char === "{") {
      const end = glob.indexOf("}", index + 1);
      if (end > index) {
        source += `(?:${glob.slice(index + 1, end).split(",").map(escapeRegex).join("|")})`;
        index = end;
      } else source += "\\{";
    } else source += escapeRegex(char);
  }
  try { return new RegExp(`^${source}$`, "i"); } catch { return null; }
}

function matchesFilePattern(filePath: string, pattern?: string): boolean {
  if (!pattern) return true;
  const regex = globToRegex(pattern.replace(/\\/g, "/"));
  return regex ? regex.test(filePath.replace(/\\/g, "/")) : true;
}

function candidateFromRecord(value: unknown, source: Candidate["source"], terms: string[], filePattern?: string): Candidate | null {
  const record = asRecord(value);
  if (!record) return null;
  const qualifiedName = typeof record.qualified_name === "string" ? record.qualified_name : "";
  if (!qualifiedName) return null;
  const name = typeof record.name === "string" ? record.name : qualifiedName.split(".").at(-1) || "";
  const filePath = typeof record.file_path === "string" ? record.file_path : "";
  if (!matchesFilePattern(filePath, filePattern)) return null;
  const haystack = `${name} ${qualifiedName} ${filePath}`.toLowerCase();
  const lexicalScore = terms.reduce((score, term) => score + (haystack.includes(term.toLowerCase()) ? 1 : 0), 0);
  const score = typeof record.score === "number" ? record.score : undefined;
  return {
    name,
    qualifiedName,
    label: typeof record.label === "string" ? record.label : "",
    filePath,
    score,
    lexicalScore,
    source,
  };
}

export function filterGraphSearch(raw: unknown, query: string, functionName?: string, filePattern?: string): {
  structured: Candidate[];
  semantic: Candidate[];
  omittedStructured: number;
  omittedSemantic: number;
} {
  const root = asRecord(raw) ?? {};
  const terms = [...(functionName ? [functionName] : []), ...extractQueryTerms(query)];
  const structuredAll = asArray(root.results)
    .map((value) => candidateFromRecord(value, "structured", terms, filePattern))
    .filter((value): value is Candidate => Boolean(value));
  const semanticAll = asArray(root.semantic_results)
    .map((value) => candidateFromRecord(value, "semantic", terms, filePattern))
    .filter((value): value is Candidate => Boolean(value));

  const requested = functionName?.toLowerCase();
  const structured = structuredAll
    .filter((candidate) => candidate.lexicalScore > 0 || Boolean(requested && candidate.name.toLowerCase().includes(requested)))
    .sort((a, b) => {
      const aDirect = requested && a.name.toLowerCase().includes(requested) ? 1 : 0;
      const bDirect = requested && b.name.toLowerCase().includes(requested) ? 1 : 0;
      return bDirect - aDirect || b.lexicalScore - a.lexicalScore || a.name.localeCompare(b.name);
    })
    .slice(0, 12);
  const semantic = semanticAll
    .filter((candidate) => (candidate.score ?? Number.NEGATIVE_INFINITY) >= SEMANTIC_SCORE_THRESHOLD)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, 8);
  return {
    structured,
    semantic,
    omittedStructured: Math.max(0, structuredAll.length - structured.length),
    omittedSemantic: Math.max(0, semanticAll.length - semantic.length),
  };
}

function compactCandidate(candidate: Candidate): JsonRecord {
  return {
    name: candidate.name,
    qualified_name: candidate.qualifiedName,
    label: candidate.label,
    file_path: candidate.filePath,
    ...(candidate.score !== undefined ? { score: candidate.score } : {}),
    lexical_matches: candidate.lexicalScore,
  };
}

function compactGraphOutput(filtered: ReturnType<typeof filterGraphSearch>): string {
  return JSON.stringify({
    filtering: {
      semantic_min_score: SEMANTIC_SCORE_THRESHOLD,
      structured_kept: filtered.structured.length,
      structured_omitted: filtered.omittedStructured,
      semantic_kept: filtered.semantic.length,
      semantic_omitted: filtered.omittedSemantic,
      note: filtered.semantic.length ? "Only semantic matches above the relevance threshold are shown." : "No semantic match cleared the relevance threshold; weak candidates were omitted.",
    },
    structured_results: filtered.structured.map(compactCandidate),
    semantic_results: filtered.semantic.map(compactCandidate),
  }, null, 2);
}

function compactArchitecture(raw: string): string {
  const root = asRecord(parseJson(raw));
  if (!root) return bounded(raw, 6 * 1024);
  const cap = (key: string, count: number) => asArray(root[key]).slice(0, count);
  return JSON.stringify({
    project: root.project,
    total_nodes: root.total_nodes,
    total_edges: root.total_edges,
    languages: cap("languages", 12),
    packages: cap("packages", 12),
    entry_points: cap("entry_points", 15),
    hotspots: cap("hotspots", 12),
    boundaries: cap("boundaries", 12),
    layers: cap("layers", 12),
    routes: cap("routes", 12),
    note: "Architecture arrays are deliberately capped; use alonix-index-context for the full repository baseline.",
  }, null, 2);
}

function compactTrace(raw: string, query: string, functionName?: string): string {
  const root = asRecord(parseJson(raw));
  if (!root) return bounded(raw, 7 * 1024);
  const terms = [...(functionName ? [functionName] : []), ...extractQueryTerms(query)].map((term) => term.toLowerCase());
  const rank = (value: unknown): Array<JsonRecord & { _relevance: number; hop?: unknown }> => asArray(value).map((item) => {
    const record = asRecord(item) ?? {};
    const haystack = `${record.name ?? ""} ${record.qualified_name ?? ""}`.toLowerCase();
    const relevance = terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
    return { ...record, _relevance: relevance };
  }).sort((a, b) => b._relevance - a._relevance || Number((a as JsonRecord).hop ?? 0) - Number((b as JsonRecord).hop ?? 0));
  const compact = (value: unknown) => {
    const ranked = rank(value);
    const relevant = ranked.filter((item) => item._relevance > 0).slice(0, 20);
    const fallback = relevant.length ? [] : ranked.slice(0, 8);
    return [...relevant, ...fallback].map(({ _relevance, ...item }) => ({ ...item, relevance_hits: _relevance }));
  };
  const callees = compact(root.callees);
  const callers = compact(root.callers);
  return JSON.stringify({
    function: root.function,
    direction: root.direction,
    callees,
    callers,
    filtering: {
      original_callees: asArray(root.callees).length,
      shown_callees: callees.length,
      original_callers: asArray(root.callers).length,
      shown_callers: callers.length,
      note: "Edges matching concrete investigation terms are prioritized; unrelated accessors are omitted.",
    },
  }, null, 2);
}

function compactCodeSearch(raw: string, filePattern?: string): string {
  const root = asRecord(parseJson(raw));
  if (!root) return bounded(raw, 6 * 1024);
  const filterItems = (value: unknown, limit: number) => asArray(value).filter((item) => {
    const record = asRecord(item);
    const path = typeof record?.file_path === "string" ? record.file_path : typeof record?.path === "string" ? record.path : "";
    return !filePattern || !path || matchesFilePattern(path, filePattern);
  }).slice(0, limit);
  return JSON.stringify({
    results: filterItems(root.results, 20),
    raw_matches: filterItems(root.raw_matches, 20),
    total_grep_matches: root.total_grep_matches,
    total_results: root.total_results,
    elapsed_ms: root.elapsed_ms,
    note: "Indexed-code output is capped at 20 results and 20 raw matches.",
  }, null, 2);
}

function selectSnippetCandidates(filtered: ReturnType<typeof filterGraphSearch>, functionName?: string): Candidate[] {
  const combined = [...filtered.structured, ...filtered.semantic];
  const requested = functionName?.toLowerCase();
  const sorted = [...combined].sort((a, b) => {
    const aDirect = requested && (a.name.toLowerCase().includes(requested) || a.qualifiedName.toLowerCase().includes(requested)) ? 1 : 0;
    const bDirect = requested && (b.name.toLowerCase().includes(requested) || b.qualifiedName.toLowerCase().includes(requested)) ? 1 : 0;
    return bDirect - aDirect || b.lexicalScore - a.lexicalScore || (b.score ?? 0) - (a.score ?? 0);
  });
  const seen = new Set<string>();
  return sorted.filter((candidate) => {
    if (seen.has(candidate.qualifiedName)) return false;
    seen.add(candidate.qualifiedName);
    return true;
  }).slice(0, MAX_SNIPPETS);
}

export function validateReadOnlyCypher(query: string): string | null {
  if (query.length > 12_000) return "Optional Cypher was skipped because it exceeded the 12000-character safety limit.";
  const normalized = query.trim();
  if (!normalized) return null;
  const withoutLiterals = normalized
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/\"(?:\\.|[^\"\\])*\"/g, '\"\"')
    .replace(/`(?:``|[^`])*`/g, "``");
  if (!/^(MATCH|OPTIONAL\s+MATCH|WITH|UNWIND)\b/i.test(withoutLiterals)) return "Optional Cypher was skipped because it did not begin with an allowed read-only clause.";
  if (/\b(CREATE|MERGE|DELETE|DETACH|SET|REMOVE|DROP|LOAD\s+CSV|FOREACH|CALL|YIELD|SHOW|TERMINATE|GRANT|DENY|REVOKE|ALTER|RENAME|START|STOP)\b/i.test(withoutLiterals)) return "Optional Cypher was skipped because it contained a write-capable or procedure/admin clause.";
  return null;
}

function joinBudgeted(sections: string[], limit = INVESTIGATION_LIMIT): string {
  let output = "";
  for (const value of sections) {
    const separator = output ? "\n\n" : "";
    const remaining = limit - output.length - separator.length;
    if (remaining <= 0) break;
    if (value.length <= remaining) output += separator + value;
    else {
      output += separator + value.slice(0, Math.max(0, remaining - 96));
      output += "\n[CBM INVESTIGATION OUTPUT BUDGET REACHED; lower-priority content was omitted.]";
      break;
    }
  }
  return output;
}

export const project = tool({
  description: "Consolidated CBM project/index management. Listing and status are read-only. Creating a new index is never automatic: action=index requires an explicit user request plus user_authorized=true. Context, investigation, and memory may refresh only projects that are already indexed.",
  args: {
    action: s.enum(["list", "index", "status", "delete"]),
    project: s.string().optional(),
    repo_path: s.string().optional(),
    mode: s.enum(["fast", "moderate", "full"]).optional().default("fast"),
    user_authorized: s.boolean().optional().default(false),
  },
  async execute(args: any, context: ToolContext) {
    if (args.action === "list") return formatProjectList(await safeInvoke("list_projects", {}, context) || "No projects indexed yet.");
    if (args.action === "index") {
      if (args.user_authorized !== true) return "STOP. action=index requires user_authorized=true, which may be set only when the user explicitly requested creation or refresh of this CBM index.";
      if (!args.repo_path) return "STOP. action=index requires repo_path.";
      let path: string;
      try { path = getProjectRoot(args.repo_path); } catch (error) { return `STOP. Invalid project directory: ${error instanceof Error ? error.message : String(error)}`; }
      const current = assessIndexedFreshness(path);
      const requestedRefresh: Freshness = current.status === "fresh"
        ? { ...current, status: "stale", reason: "an explicit reindex was requested" }
        : current;
      try {
        const indexedProject = projectNameFromRoot(path);
        const repair = await repairIndexIfNeeded(
          path,
          requestedRefresh,
          () => invokeCbm("index_repository", { repo_path: path, mode: args.mode ?? "fast" }, { signal: context.abort }),
          () => verifyIndexedStructure(path, indexedProject, context),
        );
        return [repairSection(repair), section("CBM INDEX RESULT", repair.backendOutput || "A concurrent call completed the refresh."), freshnessSection(repair.freshness)].join("\n\n");
      }
      catch (error) {
        return `INDEX REFRESH FAILED\n\nWhat happened: CBM could not create a verified current index for ${path}.\nSafety outcome: this request did not continue with stale graph data.\nError: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    if (!args.project) return `STOP. action=${args.action} requires project.`;
    return section(args.action === "status" ? "CBM INDEX STATUS" : "CBM DELETE RESULT", await safeInvoke(args.action === "status" ? "index_status" : "delete_project", { project: args.project }, context));
  },
});

export const context = tool({
  description: "Get a mandatory high-information repository baseline in ONE call. Always returns architecture, graph schema, and current git-change blast radius; the agent cannot request a reduced subset. Use immediately after confirming the project is indexed.",
  args: { project: s.string() },
  async execute(args: any, context: ToolContext) {
    let health;
    try { health = await ensureQueryReady(args.project, context); }
    catch (error) {
      return `CBM CONTEXT FAILED\n\nWhat happened: the index could not be validated or repaired inside this tool call.\nSafety outcome: no architecture result was returned from an unverified index.\nError: ${error instanceof Error ? error.message : String(error)}`;
    }
    const changePromise = isGitRepo(health.rootPath)
      ? safeInvoke("detect_changes", { project: args.project }, context)
      : Promise.resolve(JSON.stringify({ status: "not_applicable", changed_files: [], changed_count: 0, impacted_symbols: [], reason: "The indexed project is not a Git worktree; Git change blast radius was not invoked." }));
    const [architecture, schema, changes] = await Promise.all([
      safeInvoke("get_architecture", { project: args.project }, context),
      safeInvoke("get_graph_schema", { project: args.project }, context),
      changePromise,
    ]);
    return [repairSection(health.repair), freshnessSection(health.freshness), section("ARCHITECTURE", architecture), section("GRAPH SCHEMA", schema), section("CURRENT CHANGE BLAST RADIUS", changes), "=== NEXT-STEP DIRECTIVE ===\nUse this baseline before further discovery. For a concrete feature, bug, or symbol question, call alonix-index-investigate once with the full intent instead of chaining filesystem grep/explore calls."].join("\n\n");
  },
});

export const investigate = tool({
  description: "Priority-budgeted code investigation in ONE call. Returns the requested function call chain and relevant source first, then filtered indexed-code and symbol evidence, then a compact architecture reminder. Weak semantic matches are discarded instead of dumped. The complete response is bounded so useful evidence is not buried by backend noise.",
  args: {
    project: s.string(),
    query: s.string().min(1),
    function_name: s.string().optional(),
    label: s.string().optional(),
    file_pattern: s.string().optional(),
    cypher: s.string().optional(),
  },
  async execute(args: any, context: ToolContext) {
    let health;
    try { health = await ensureQueryReady(args.project, context); }
    catch (error) {
      return `CBM INVESTIGATION FAILED\n\nWhat happened: the index could not be validated or repaired inside this tool call.\nSafety outcome: no investigation evidence was returned from an unverified index.\nError: ${error instanceof Error ? error.message : String(error)}`;
    }
    const searchArgs: Record<string, unknown> = { project: args.project, semantic_query: [args.query], limit: 50, offset: 0 };
    if (args.label) searchArgs.label = args.label;
    if (args.file_pattern) searchArgs.file_pattern = args.file_pattern;
    const codePattern = deriveCodePattern(args.query, args.function_name);
    const codeArgs: Record<string, unknown> = { project: args.project, pattern: codePattern };
    if (args.file_pattern) codeArgs.file_pattern = args.file_pattern;

    const exactArgs: Record<string, unknown> | null = args.function_name
      ? { project: args.project, name_pattern: `^${escapeRegex(args.function_name)}$`, limit: 12, offset: 0 }
      : null;
    if (exactArgs && args.label) exactArgs.label = args.label;
    const [architectureRaw, graphRaw, exactRaw, codeRaw] = await Promise.all([
      safeInvoke("get_architecture", { project: args.project }, context),
      safeInvoke("search_graph", searchArgs, context),
      exactArgs ? safeInvoke("search_graph", exactArgs, context) : Promise.resolve("{}"),
      safeInvoke("search_code", codeArgs, context),
    ]);
    const semanticRoot = asRecord(parseJson(graphRaw)) ?? {};
    const exactRoot = asRecord(parseJson(exactRaw)) ?? {};
    const mergedGraph = {
      ...semanticRoot,
      results: [...asArray(exactRoot.results), ...asArray(semanticRoot.results)],
      semantic_results: asArray(semanticRoot.semantic_results),
    };
    const filtered = filterGraphSearch(mergedGraph, args.query, args.function_name, args.file_pattern);
    const candidates = selectSnippetCandidates(filtered, args.function_name);
    const traceTarget = args.function_name || candidates[0]?.name;
    const [trace, snippetResults] = await Promise.all([
      traceTarget ? safeInvoke("trace_path", { project: args.project, function_name: traceTarget, direction: "both", max_depth: 3 }, context) : Promise.resolve("No sufficiently relevant function candidate was found for call-chain tracing."),
      Promise.all(candidates.map(async (candidate) => ({ candidate, output: await safeInvoke("get_code_snippet", { project: args.project, qualified_name: candidate.qualifiedName }, context) }))),
    ]);

    const outputSections = [
      repairSection(health.repair),
      freshnessSection(health.freshness),
      section("INVESTIGATION SUMMARY", JSON.stringify({
        requested_function: args.function_name || null,
        trace_target: traceTarget || null,
        derived_code_pattern: codePattern,
        source_candidates: candidates.map((candidate) => candidate.qualifiedName),
        weak_semantic_matches_omitted: filtered.omittedSemantic,
        structured_candidates_omitted: filtered.omittedStructured,
        file_pattern_enforced_in_wrapper: args.file_pattern || null,
      }, null, 2), 3 * 1024),
      section("PRIORITY CALL CHAIN", compactTrace(trace, args.query, args.function_name), 7 * 1024),
    ];
    if (snippetResults.length) {
      for (let index = 0; index < snippetResults.length; index += 1) {
        const item = snippetResults[index];
        outputSections.push(section(`PRIORITY SOURCE ${index + 1}: ${item.candidate.qualifiedName}`, item.output, 6 * 1024));
      }
    } else outputSections.push(section("PRIORITY SOURCE", "No candidate cleared lexical/semantic relevance filtering; no random source snippet was requested.", 2 * 1024));
    outputSections.push(
      section("FILTERED INDEXED CODE SEARCH", compactCodeSearch(codeRaw, args.file_pattern), 7 * 1024),
      section("FILTERED SYMBOL EVIDENCE", compactGraphOutput(filtered), 7 * 1024),
      section("COMPACT ARCHITECTURE REMINDER", compactArchitecture(architectureRaw), 6 * 1024),
    );
    if (args.cypher) {
      const validation = validateReadOnlyCypher(args.cypher);
      outputSections.push(section("OPTIONAL CYPHER", validation || await safeInvoke("query_graph", { project: args.project, query: args.cypher }, context), 4 * 1024));
    }
    outputSections.push("=== EXECUTION DIRECTIVE ===\nUse the priority call chain and source first. Treat omitted weak semantic matches as non-evidence. If a precise source gap remains, use alonix-read range requests rather than shell-based Get-Content/rg discovery. Do not restart broad exploration.");
    return joinBudgeted(outputSections);
  },
});

export const memory = tool({
  description: "Grouped CBM knowledge maintenance for ADRs and runtime traces. Use ADR actions to preserve architectural decisions; use ingest_traces to enrich static HTTP/call relationships with observed runtime behavior.",
  args: {
    action: s.enum(["adr_create", "adr_read", "adr_update", "adr_delete", "adr_list", "ingest_traces"]),
    project: s.string(), id: s.string().optional(), title: s.string().optional(), status: s.enum(["proposed", "accepted", "deprecated", "superseded"]).optional(), context: s.string().optional(), decision: s.string().optional(), consequences: s.string().optional(),
    traces: s.array(s.object({ source: s.string(), target: s.string(), method: s.string().optional(), timestamp: s.string().optional() })).optional(),
  },
  async execute(args: any, context: ToolContext) {
    let health;
    try { health = await ensureQueryReady(args.project, context); }
    catch (error) {
      return `CBM MEMORY OPERATION FAILED\n\nWhat happened: the index could not be validated or repaired inside this tool call.\nSafety outcome: no ADR or trace mutation was attempted against an unverified project.\nError: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (args.action === "ingest_traces") {
      if (!args.traces?.length) return "STOP. action=ingest_traces requires at least one trace.";
      if (args.traces.length > 1000) return "STOP. action=ingest_traces accepts at most 1000 traces per call.";
      for (let index = 0; index < args.traces.length; index += 1) {
        const trace = args.traces[index];
        if (!trace.source?.trim() || !trace.target?.trim()) return `STOP. trace #${index + 1} requires non-empty source and target.`;
        if (trace.timestamp && Number.isNaN(Date.parse(trace.timestamp))) return `STOP. trace #${index + 1} timestamp must be valid ISO-8601-compatible text.`;
      }
      return [repairSection(health.repair), section("TRACE INGEST RESULT", await safeInvoke("ingest_traces", { project: args.project, traces: args.traces }, context))].join("\n\n");
    }
    const action = args.action.replace("adr_", "");
    if (["read", "update", "delete"].includes(action) && !args.id?.trim()) return `STOP. action=${args.action} requires id.`;
    if (action === "create" && !args.title?.trim()) return "STOP. action=adr_create requires title.";
    if (["create", "update"].includes(action) && !args.status) return `STOP. action=${args.action} requires status.`;
    const adrArgs: Record<string, unknown> = { action, project: args.project };
    for (const key of ["id", "title", "status", "context", "decision", "consequences"] as const) if (args[key] !== undefined) adrArgs[key] = args[key];
    return [repairSection(health.repair), section("ADR RESULT", await safeInvoke("manage_adr", adrArgs, context))].join("\n\n");
  },
});
