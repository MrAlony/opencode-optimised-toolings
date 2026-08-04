import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { formatSize, normalizeSlashes } from "./common.js";
import { readTextStable } from "./text-io.js";

const MAX_SEARCH_CHARS = 64 * 1024;
const MAX_SEARCH_MATCHES = 200;
const MAX_SEARCH_FILES = 25_000;
const MAX_SEARCH_FILE_BYTES = 4 * 1024 * 1024;
const SEARCH_DEADLINE_MS = 15_000;
const SKIP_DIRECTORIES = new Set([".git", ".opencode", ".next", ".cache", "node_modules", "target", "dist", "build", "coverage", "__pycache__"]);

function globToRegExp(glob) {
  let pattern = normalizeSlashes(glob.trim());
  if (!pattern.includes("/")) pattern = `**/${pattern}`;
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        index += 1;
        if (pattern[index + 1] === "/") {
          index += 1;
          source += "(?:.*/)?";
        } else source += ".*";
      } else source += "[^/]*";
    } else if (char === "?") source += "[^/]";
    else if (char === "{") {
      const end = pattern.indexOf("}", index + 1);
      if (end === -1) source += "\\{";
      else {
        const alternatives = pattern.slice(index + 1, end).split(",").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
        source += `(?:${alternatives.join("|")})`;
        index = end;
      }
    } else source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${source}$`, process.platform === "win32" ? "i" : "");
}

export function enumerateFilesNative(base, filePattern, deadline) {
  const matcher = globToRegExp(filePattern);
  const paths = [];
  const issues = [];
  let complete = true;
  function visit(directory) {
    if (!complete) return;
    if (Date.now() > deadline) {
      complete = false;
      issues.push("native enumeration reached its time budget");
      return;
    }
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); }
    catch (error) {
      issues.push(`${normalizeSlashes(relative(base, directory) || ".")}: ${error.message}`);
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) {
        const relativePath = normalizeSlashes(relative(base, path));
        if (matcher.test(relativePath)) paths.push(relativePath);
        if (paths.length >= MAX_SEARCH_FILES) {
          complete = false;
          issues.push(`native enumeration reached the ${MAX_SEARCH_FILES}-file safety cap`);
          return;
        }
      }
      if (!complete) return;
    }
  }
  visit(base);
  return { paths, complete, issues, source: "native fallback" };
}

export function enumerateFiles(base, filePattern, deadline) {
  try {
    const output = execFileSync("rg", ["--files", "-g", filePattern], {
      cwd: base,
      encoding: "utf8",
      timeout: Math.max(1, Math.min(8000, deadline - Date.now())),
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
    return { paths: output.split(/\r?\n/).filter(Boolean).map(normalizeSlashes), complete: true, issues: [], source: "ripgrep" };
  } catch (error) {
    if (error.status === 1) return { paths: [], complete: true, issues: [], source: "ripgrep" };
    const fallback = enumerateFilesNative(base, filePattern, deadline);
    fallback.issues.unshift(`ripgrep unavailable or unsuccessful (${error.code ?? error.signal ?? error.message}); native enumeration activated`);
    return fallback;
  }
}

function compileRegex(query) {
  let source = query;
  let flags = "";
  if (source.startsWith("(?i)")) {
    source = source.slice(4);
    flags = "i";
  }
  return new RegExp(source, flags);
}

function wholeRecords(records, characterBudget) {
  const kept = [];
  let used = 0;
  for (const record of records) {
    const addition = kept.length ? `\n${record}` : record;
    if (used + addition.length > characterBudget) break;
    kept.push(record);
    used += addition.length;
  }
  return { text: kept.join("\n"), count: kept.length, truncated: kept.length < records.length };
}

export function performSearch(base, query, filePattern, fileEnumerator = enumerateFiles) {
  const started = Date.now();
  const deadline = started + SEARCH_DEADLINE_MS;
  let regex;
  try { regex = compileRegex(query); }
  catch (error) {
    return {
      status: "FAILED", query, filePattern, paths: [], matches: [], durationMs: Date.now() - started,
      enumeration: { source: "not started", complete: false, issues: [] },
      scan: { complete: false, filesScanned: 0, skippedBinary: 0, skippedLarge: 0, readErrors: 0 },
      issues: [`invalid regular expression: ${error.message}`], recovery: [],
    };
  }
  const enumeration = fileEnumerator(base, filePattern, deadline);
  const matches = [];
  const issues = [...enumeration.issues];
  const recovery = [];
  let filesScanned = 0;
  let skippedBinary = 0;
  let skippedLarge = 0;
  let readErrors = 0;
  let scanComplete = enumeration.complete;
  for (const relativePath of enumeration.paths) {
    if (Date.now() > deadline) {
      scanComplete = false;
      issues.push("content scan reached its time budget");
      break;
    }
    const path = resolve(base, relativePath);
    try {
      if (statSync(path).size > MAX_SEARCH_FILE_BYTES) {
        skippedLarge += 1;
        scanComplete = false;
        continue;
      }
      const snapshot = readTextStable(path);
      recovery.push(...(snapshot.recoveries ?? []).map((item) => `${relativePath}: ${item}`));
      if (snapshot.binary) {
        skippedBinary += 1;
        continue;
      }
      if (snapshot.error) {
        readErrors += 1;
        scanComplete = false;
        issues.push(`${relativePath}: ${snapshot.error}`);
        continue;
      }
      if (!snapshot.stable) scanComplete = false;
      filesScanned += 1;
      const lines = snapshot.content.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        regex.lastIndex = 0;
        if (!regex.test(lines[index])) continue;
        const line = lines[index].length > 300 ? `${lines[index].slice(0, 300)} [line truncated]` : lines[index];
        matches.push(`.\\${relativePath.replaceAll("/", "\\")}:${index + 1}:${line}`);
      }
    } catch (error) {
      readErrors += 1;
      scanComplete = false;
      issues.push(`${relativePath}: ${error.message}`);
    }
  }
  if (skippedLarge) issues.push(`${skippedLarge} file(s) exceeded the ${formatSize(MAX_SEARCH_FILE_BYTES)} per-file scan cap`);
  const complete = enumeration.complete && scanComplete;
  return {
    status: complete ? "SUCCESS" : enumeration.paths.length || matches.length ? "PARTIAL SUCCESS" : "FAILED",
    query, filePattern, paths: enumeration.paths, matches, enumeration,
    scan: { complete: scanComplete, filesScanned, skippedBinary, skippedLarge, readErrors },
    issues, recovery, durationMs: Date.now() - started,
  };
}

export function formatSearchResult(result) {
  const paths = wholeRecords(result.paths, Math.floor(MAX_SEARCH_CHARS * 0.35));
  const matches = wholeRecords(result.matches.slice(0, MAX_SEARCH_MATCHES), Math.floor(MAX_SEARCH_CHARS * 0.65));
  const matchTruncated = result.matches.length > matches.count;
  const evidenceComplete = result.enumeration.complete && result.scan.complete && !paths.truncated && !matchTruncated;
  const evidence = evidenceComplete
    ? "Candidate enumeration and returned content evidence are complete within configured bounds."
    : "Partial evidence was returned; absence is not established for portions affected by timeout, caps, truncation, unstable reads, or read failures.";
  const meaning = result.status === "SUCCESS"
    ? `Search completed within all configured bounds. ${result.matches.length} content match(es) were found.`
    : result.status === "PARTIAL SUCCESS"
      ? `Search returned usable evidence, but at least one timeout, cap, truncation, unstable read, or file error prevents claiming complete absence.`
      : "Search could not establish usable complete evidence.";
  return [
    `SEARCH RESULT: ${result.status}`,
    `WHAT HAPPENED: ${meaning}`,
    `FILE DISCOVERY:\n  Method: ${result.enumeration.source}\n  Complete: ${result.enumeration.complete ? "yes" : "no"}\n  Matching file candidates found: ${result.paths.length}\n  File paths returned below: ${paths.count}`,
    `CONTENT SCAN:\n  Complete: ${result.scan.complete ? "yes" : "no"}\n  Files scanned: ${result.scan.filesScanned}\n  Matches found: ${result.matches.length}\n  Matches returned below: ${matches.count}\n  Binary files skipped: ${result.scan.skippedBinary}\n  Oversized files skipped: ${result.scan.skippedLarge}\n  Read errors: ${result.scan.readErrors}`,
    `DURATION: ${result.durationMs} ms`,
    `EVIDENCE MEANING: ${evidence}`,
    `LIMITS AND RECOVERY:\n${result.issues.length || result.recovery.length ? [...result.issues, ...result.recovery].map((item) => `- ${item}`).join("\n") : "- None; no fallback, retry, or configured limit affected the result."}`,
    `=== MATCHING FILES: ${result.filePattern} ===\n${paths.text || "No files matched."}${paths.truncated ? "\n[FILE LIST TRUNCATED AT A COMPLETE RECORD BOUNDARY]" : ""}`,
    `=== CONTENT MATCHES: ${result.query} ===\n${matches.text || "No matches found."}${matchTruncated ? "\n[MATCH LIST TRUNCATED AT A COMPLETE RECORD BOUNDARY]" : ""}`,
  ].join("\n\n");
}
