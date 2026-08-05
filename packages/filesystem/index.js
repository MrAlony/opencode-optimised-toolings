import { tool } from "@opencode-ai/plugin";
import { executeEditMany } from "./lib/edit-engine.js";
import { executeExplore } from "./lib/explore-engine.js";
import { executeReadMany } from "./lib/read-engine.js";
import { enumerateFiles, formatSearchResult, performSearch } from "./lib/search-engine.js";
import { atomicCreateText, atomicReplaceText } from "./lib/text-io.js";

const MAX_BATCH_PATHS = 10;
const MAX_RANGE_REQUESTS = 20;
const sessionUsage = new Map();

function sessionState(context) {
  const id = context.sessionID || "unknown-session";
  if (!sessionUsage.has(id)) {
    sessionUsage.set(id, { lastTool: null, streak: 0, calls: {}, inefficientReads: 0, discoveryCalls: 0 });
  }
  return sessionUsage.get(id);
}

function usageSignals(context, toolName, { oneFile = false } = {}) {
  const state = sessionState(context);
  state.streak = state.lastTool === toolName ? state.streak + 1 : 1;
  state.lastTool = toolName;
  state.calls[toolName] = (state.calls[toolName] || 0) + 1;
  if (toolName === "alonix-read-many" && oneFile) state.inefficientReads += 1;
  if (toolName === "alonix-search" || toolName === "alonix-explore") state.discoveryCalls += 1;
  const signals = [];

  if (oneFile) {
    const level = state.inefficientReads;
    const text = level === 1
      ? "Only one unique file was requested. Related source, tests, configuration, and callers can often fit in the same read."
      : level === 2
        ? "This is another one-file read in the session; a broader related-file batch may provide more complete edit context."
        : `This is one-file read #${level} in the session; repeated narrow reads may indicate that related context is being discovered serially.`;
    signals.push(`[READ BATCH SIGNAL] ${text}`);
  }

  if (state.streak >= 2) {
    const guidance = {
      "alonix-read-many": "If more paths are already known, combine them now instead of continuing serial reads.",
      "alonix-search": "Combine filename and content discovery into this one call; use alonix-explore once for broad repository context, then act on the returned results.",
      "alonix-explore": "Do not repeatedly re-explore the same project. Use the structure, manifests, entry candidates, and search results already returned; switch to precise batched reads or implementation.",
      "alonix-edit-many": "Combine independent files and repeated same-file actions into one ordered edit call when they are already known.",
    };
    const label = state.streak === 2 ? "NOTICE REPEATED-TOOL ADVICE" : "STRONG REPEATED-TOOL ADVICE";
    signals.push(`[${label}] Consecutive ${toolName} call #${state.streak}. ${guidance[toolName] ?? "Consolidate already-known independent work when the tool supports it."}`);
  }

  if (state.discoveryCalls === 2) {
    signals.push("[CBM ESCALATION WARNING] Filesystem discovery call #2 detected. Use alonix-index-project(action=\"list\") before another broad filesystem discovery call. If the repository is indexed, switch to alonix-index-context or one complete alonix-index-investigate call; otherwise continue with precise filesystem evidence.");
  } else if (state.discoveryCalls >= 3) {
    signals.push(`[CRITICAL CBM ESCALATION] Filesystem discovery call #${state.discoveryCalls} detected. Stop broad explore/search loops. Use alonix-index-project(action=\"list\") now; for an indexed repository the NEXT discovery call should be alonix-index-context or alonix-index-investigate. If it is not indexed, index it once with alonix-index-project(action=\"index\") or explain why precise filesystem follow-up is genuinely required. Continue the full task—change the information source, not the scope.`);
  }

  return signals;
}

const replacementSchema = tool.schema.object({
  search: tool.schema.string().min(1).describe("Exact text to replace"),
  replace: tool.schema.string().describe("Replacement text"),
  expected_count: tool.schema.number().int().min(1).optional().default(1).describe("Required exact match count against staged content"),
  allow_already_applied: tool.schema.boolean().optional().default(false).describe("When true, a missing search may be treated as already satisfied only if replacement text appears exactly expected_count times"),
});

export const FsToolingPlugin = async ({
  directory,
  replaceWriter = atomicReplaceText,
  createWriter = atomicCreateText,
  beforeEditApply = () => {},
  searchFileEnumerator = enumerateFiles,
}) => ({
  tool: {
    "alonix-explore": tool({
      description: "Consolidated repository exploration with component-level status, bounded tree/manifests/entry candidates, optional self-healing search, and neutral context candidates. Partial evidence remains visible when one component fails.",
      args: {
        base_dir: tool.schema.string().optional().describe("Project or subdirectory to explore"),
        query: tool.schema.string().optional().describe("Optional regex search included with the baseline"),
        file_pattern: tool.schema.string().optional().describe("Optional glob restricting the query"),
      },
      async execute(args, context) {
        const output = executeExplore(args, context, { directory, searchFileEnumerator });
        return [...usageSignals(context, "alonix-explore"), output].join("\n\n");
      },
    }),

    "alonix-read-many": tool({
      description: "Read complete files and/or exact ranges with adaptive output allocation, encoding detection, stable-read recovery, head/tail truncation bounds, missing-path candidates, and canonical duplicate consolidation. Complete reads supersede only ranges actually covered by returned complete evidence.",
      args: {
        paths: tool.schema.array(tool.schema.string()).min(1).max(MAX_BATCH_PATHS).optional().describe("1-10 complete-file paths"),
        requests: tool.schema.array(tool.schema.object({
          path: tool.schema.string().describe("Text file path"),
          ranges: tool.schema.array(tool.schema.object({
            start_line: tool.schema.number().int().min(1).describe("1-based endpoint; reversed endpoints are normalized"),
            end_line: tool.schema.number().int().min(1).describe("1-based endpoint; reversed endpoints are normalized"),
          })).min(1).describe("Distinct ranges from this file"),
        })).min(1).max(MAX_RANGE_REQUESTS).optional().describe("Up to 20 file/range requests"),
        base_dir: tool.schema.string().optional().describe("Base directory for relative paths"),
      },
      async execute(args, context) {
        const output = executeReadMany(args, context, { directory });
        const uniqueRequested = new Set([...(args.paths ?? []), ...(args.requests ?? []).map((request) => request.path)]).size;
        return [...usageSignals(context, "alonix-read-many", { oneFile: uniqueRequested === 1 }), output].join("\n\n");
      },
    }),

    "alonix-edit-many": tool({
      description: "Create new files, overwrite existing files, and apply strict exact patches through ordered per-file transactions. Safe recovery includes exact patch-only rebasing, identical create-race recognition, transient atomic-write retries, exact no-op assertions, optional already-applied recognition, and neutral near-match evidence for rejected patches.",
      args: {
        actions: tool.schema.array(tool.schema.discriminatedUnion("operation", [
          tool.schema.object({
            path: tool.schema.string().describe("Missing target file; repeated canonical paths continue the same ordered transaction"),
            operation: tool.schema.literal("create"),
            content: tool.schema.string().describe("Initial complete content"),
            expected_sha256: tool.schema.string().optional().describe("Optional staged-content fingerprint assertion"),
          }),
          tool.schema.object({
            path: tool.schema.string().describe("Existing staged file; repeated canonical paths continue the same ordered transaction"),
            operation: tool.schema.literal("overwrite"),
            content: tool.schema.string().describe("Replacement complete content"),
            expected_sha256: tool.schema.string().optional().describe("Optional staged-content fingerprint assertion"),
          }),
          tool.schema.object({
            path: tool.schema.string().describe("Existing staged file; repeated canonical paths continue the same ordered transaction"),
            operation: tool.schema.literal("patch"),
            replacements: tool.schema.array(replacementSchema).min(1).describe("Ordered exact replacements"),
            expected_sha256: tool.schema.string().optional().describe("Optional staged-content fingerprint assertion"),
          }),
        ])).min(1).describe("Globally ordered actions grouped into per-file atomic-write transactions"),
        base_dir: tool.schema.string().optional().describe("Base directory for relative paths"),
      },
      async execute(args, context) {
        const output = executeEditMany(args, context, { directory, replaceWriter, createWriter, beforeEditApply });
        return [...usageSignals(context, "alonix-edit-many"), output].join("\n\n");
      },
    }),

    "alonix-search": tool({
      description: "Combined filename glob and content regex search with structured evidence status, whole-record truncation, stable text decoding, bounded execution, and automatic native fallback when ripgrep is missing, fails, or times out.",
      args: {
        query: tool.schema.string().min(1).describe("Required regex content query"),
        base_dir: tool.schema.string().optional().describe("Base directory to search"),
        file_pattern: tool.schema.string().min(1).describe("Required glob pattern, e.g. '**/*.{ts,tsx}'"),
      },
      async execute(args, context) {
        const base = args.base_dir ?? context.directory ?? directory;
        const output = formatSearchResult(performSearch(base, args.query, args.file_pattern, searchFileEnumerator));
        return [...usageSignals(context, "alonix-search"), output].join("\n\n");
      },
    }),
  },
});
