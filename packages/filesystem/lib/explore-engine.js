import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { formatSize, normalizeSlashes, waterfillBudgets } from "./common.js";
import { buildLineIndex, readTextStable, renderBoundedSnapshot } from "./text-io.js";
import { formatSearchResult, performSearch } from "./search-engine.js";

const MAX_TREE_ENTRIES = 500;
const MAX_TREE_CHARS = 36 * 1024;
const IMPORTANT_FILE_BUDGET = 80 * 1024;
const IMPORTANT_NAMES = ["AGENTS.md", "CLAUDE.md", "README.md", "README.rst", "package.json", "pyproject.toml", "Cargo.toml", "go.mod", "requirements.txt", "tsconfig.json", "CMakeLists.txt", "Makefile", "Dockerfile", "docker-compose.yml", "compose.yml"];
const ENTRY_NAMES = new Set(["index.js", "index.ts", "index.tsx", "main.js", "main.ts", "main.tsx", "main.py", "main.rs", "main.go", "app.js", "app.ts", "app.tsx", "server.js", "server.ts", "cli.js", "cli.ts"]);
const SKIP = new Set([".git", ".opencode", ".next", ".cache", "node_modules", "target", "dist", "build", "coverage", "__pycache__"]);

function metadata(root) {
  const value = statSync(root);
  const markers = [".git", "package.json", "Cargo.toml", "pyproject.toml", "go.mod", "CMakeLists.txt"].filter((name) => existsSync(join(root, name)));
  return `Root: ${root}\nName: ${basename(root)}\nType: ${value.isDirectory() ? "directory" : "file"}\nModified: ${value.mtime.toISOString()}\nDetected markers: ${markers.length ? markers.join(", ") : "none"}`;
}

function tree(root) {
  const lines = [];
  const files = [];
  const entries = [];
  let directories = 0;
  let truncated = false;
  function visit(directory, depth, prefix) {
    if (depth > 3 || truncated) return;
    let children;
    try { children = readdirSync(directory, { withFileTypes: true }).filter((entry) => !SKIP.has(entry.name)).sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name)); }
    catch (error) {
      lines.push(`${prefix}[ERROR: ${error.message}]`);
      return;
    }
    for (let index = 0; index < children.length; index += 1) {
      if (lines.length >= MAX_TREE_ENTRIES || lines.join("\n").length >= MAX_TREE_CHARS) {
        truncated = true;
        return;
      }
      const child = children[index];
      const last = index === children.length - 1;
      const path = join(directory, child.name);
      const relativePath = normalizeSlashes(relative(root, path));
      lines.push(`${prefix}${last ? "└── " : "├── "}${child.name}${child.isDirectory() ? "/" : ""}`);
      if (child.isDirectory()) {
        directories += 1;
        visit(path, depth + 1, prefix + (last ? "    " : "│   "));
      } else {
        files.push(relativePath);
        if (ENTRY_NAMES.has(child.name) || /^route\.(js|jsx|ts|tsx)$/.test(child.name)) entries.push(relativePath);
      }
    }
  }
  visit(root, 0, "");
  return { lines, files, entries, directories, truncated };
}

function importantFiles(root) {
  const found = [];
  for (const directory of [root, join(root, "docs"), join(root, ".github")]) {
    for (const name of IMPORTANT_NAMES) {
      const path = join(directory, name);
      try { if (statSync(path).isFile() && !found.includes(path)) found.push(path); } catch {}
    }
  }
  return found.slice(0, 10);
}

function contextCandidates(project, important, search, root) {
  const candidates = new Map();
  const add = (path, reason) => {
    if (!path) return;
    if (!candidates.has(path)) candidates.set(path, new Set());
    candidates.get(path).add(reason);
  };
  important.forEach((path) => add(normalizeSlashes(relative(root, path)), "instruction or manifest"));
  project.entries.forEach((path) => add(path, "entry-point candidate"));
  search?.paths?.slice(0, 8).forEach((path) => add(path, "search candidate"));
  project.files.forEach((path) => { if (/((^|\/)tests?\/|\.(test|spec)\.)/i.test(path)) add(path, "test candidate"); });
  return [...candidates].slice(0, 16).map(([path, reasons]) => `- ${path}: ${[...reasons].join(", ")}`);
}

export function executeExplore(args, context, options = {}) {
  const root = resolve(args.base_dir ?? context.directory ?? options.directory);
  let projectMetadata;
  try { projectMetadata = metadata(root); }
  catch (error) { return `EXPLORE RESULT: FAILED\nCOMPONENTS:\n- Metadata: failed (${error.message})`; }
  const project = tree(root);
  const important = importantFiles(root);
  const manifestOutput = [];
  let manifestPartial = false;
  const manifestSnapshots = important.map((path) => ({ path, snapshot: readTextStable(path) }));
  const manifestBudgets = waterfillBudgets(
    manifestSnapshots
      .filter(({ snapshot }) => !snapshot.error && !snapshot.binary)
      .map(({ path, snapshot }) => ({
        key: path,
        need: Buffer.byteLength(buildLineIndex(snapshot.content).lines.map((line) => `${line.number}: ${line.text}`).join("\n")),
      })),
    IMPORTANT_FILE_BUDGET,
  );
  for (const { path, snapshot } of manifestSnapshots) {
    if (snapshot.error || snapshot.binary) {
      manifestPartial = true;
      manifestOutput.push(`${normalizeSlashes(relative(root, path))}: ${snapshot.error ?? "binary or unsupported encoding"}`);
      continue;
    }
    const rendered = renderBoundedSnapshot(snapshot, manifestBudgets.get(path) ?? 0);
    if (rendered.truncated || !snapshot.stable) manifestPartial = true;
    manifestOutput.push(`${normalizeSlashes(relative(root, path))} (${formatSize(snapshot.size)}, encoding=${snapshot.encoding}, sha256 ${snapshot.fingerprint}):\n${rendered.text}${rendered.truncated ? `\n[MANIFEST TRUNCATED: omitted lines ${rendered.omitted.startLine}-${rendered.omitted.endLine}, ${rendered.omitted.bytes} decoded byte(s)]` : ""}`);
  }
  const search = args.query ? performSearch(root, args.query, args.file_pattern ?? "**/*", options.searchFileEnumerator) : null;
  const partial = project.truncated || manifestPartial || (search && search.status !== "SUCCESS");
  const candidates = contextCandidates(project, important, search, root);
  return [
    `EXPLORE RESULT: ${partial ? "PARTIAL SUCCESS" : "SUCCESS"}`,
    `WHAT HAPPENED: ${partial ? "A usable project baseline was returned, but one or more components reached a bound or could not be read completely." : "The bounded project baseline completed without known gaps."}`,
    `COMPONENT STATUS:\n- Project metadata: complete\n- Structure tree: ${project.truncated ? "partial; configured tree bounds were reached" : "complete"} (${project.files.length} files, ${project.directories} directories shown)\n- Instructions and manifests: ${manifestPartial ? "partial; at least one candidate was bounded, unstable, binary, or unreadable" : "complete"} (${important.length} candidate(s))\n- Optional search: ${search ? search.status.toLowerCase() : "not requested"}`,
    `=== PROJECT METADATA ===\n\n${projectMetadata}`,
    `=== PROJECT STRUCTURE (fixed depth 3) ===\n\n${project.lines.join("\n") || "(empty)"}\n\nSummary: ${project.directories} directories and ${project.files.length} files shown${project.truncated ? "; tree truncated at configured bounds" : ""}.`,
    `=== ENTRY-POINT CANDIDATES ===\n\n${project.entries.length ? project.entries.slice(0, 40).join("\n") : "No conventional entry-point names found in the displayed tree."}`,
    `=== IMPORTANT INSTRUCTIONS AND MANIFESTS ===\n\n${manifestOutput.length ? manifestOutput.join("\n\n") : "No standard instruction or manifest files found at the project root."}`,
    ...(search ? [`=== OPTIONAL SEARCH EVIDENCE ===\n\n${formatSearchResult(search)}`] : []),
    `=== CONTEXT CANDIDATES ===\n\n${candidates.length ? candidates.join("\n") : "- none identified within the bounded exploration"}`,
    "HOW TO INTERPRET CONTEXT CANDIDATES: These paths are evidence-derived starting points from manifests, conventional entry names, search results, and nearby tests. They are not asserted dependencies and should not be treated as proof of a relationship.",
  ].join("\n\n");
}
