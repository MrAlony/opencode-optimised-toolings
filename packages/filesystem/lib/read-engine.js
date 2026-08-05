import { existsSync } from "node:fs";
import {
  MAX_TOTAL_READ_BYTES,
  canonicalPathInfo,
  formatSize,
  waterfillBudgets,
} from "./common.js";
import {
  buildLineIndex,
  findMissingPathCandidates,
  rangeCoveredByRegions,
  readTextStable,
  renderBoundedSnapshot,
  renderRanges,
} from "./text-io.js";

function renderedNeed(snapshot) {
  if (snapshot.error || snapshot.binary) return 0;
  const { lines } = buildLineIndex(snapshot.content);
  return Buffer.byteLength(lines.map((line) => `${line.number}: ${line.text}`).join("\n"));
}

function formatStability(snapshot) {
  const signals = [];
  if ((snapshot.recoveries ?? []).length) signals.push(...snapshot.recoveries);
  if (snapshot.stable === false) {
    const first = snapshot.snapshots?.[0];
    const latest = snapshot.snapshots?.at(-1);
    signals.push(`content remained unstable after ${snapshot.attempts} bounded read attempt(s); latest snapshot returned`);
    if (first && latest) signals.push(`first snapshot sha256 ${first.fingerprint}; latest snapshot sha256 ${latest.fingerprint}`);
  } else if ((snapshot.attempts ?? 1) > 1) signals.push(`stable snapshot obtained on read attempt ${snapshot.attempts}`);
  return signals;
}

function formatComplete(path, snapshot, rendered) {
  if (snapshot.error) return `${path}\n  ERROR: ${snapshot.error}`;
  if (snapshot.binary) return `${path}\n  BINARY FILE: ${formatSize(snapshot.size)}; encoding=${snapshot.encoding}. Content was not decoded.`;
  const regions = rendered.regions.map((region) => `${region.kind} lines ${region.startLine}-${region.endLine}, decoded bytes ${region.startByte}-${Math.max(region.startByte, region.endByte - 1)}`).join("; ");
  const bounds = rendered.truncated
    ? `\n[TRUNCATION BOUNDS: returned ${regions};${rendered.omitted ? ` omitted lines ${rendered.omitted.startLine}-${rendered.omitted.endLine}, decoded bytes ${rendered.omitted.startByte}-${rendered.omitted.endByte}, ${rendered.omitted.bytes} decoded byte(s) / ${rendered.omitted.lines} line(s) not returned` : " an oversized single line was returned as a marked fragment; no line range is omitted"}.]`
    : "";
  const stability = formatStability(snapshot);
  return `${path} (${rendered.totalLines} total lines, ${formatSize(snapshot.size)} source bytes, encoding=${snapshot.encoding}, sha256 ${snapshot.fingerprint}, stable=${snapshot.stable}):\n${rendered.text}${bounds}${rendered.fragmented ? "\n[BOUNDARY SIGNAL: one oversized line was returned as a marked fragment.]" : ""}${stability.length ? `\n[READ RECOVERY: ${stability.join("; ")}]` : ""}`;
}

function formatRanges(path, snapshot, rendered, sourceLabel = "requested ranges") {
  if (snapshot.error) return `${path}\n  ERROR: ${snapshot.error}`;
  if (snapshot.binary) return `${path}\n  BINARY FILE: ${formatSize(snapshot.size)}; encoding=${snapshot.encoding}. Content was not decoded.`;
  const sections = rendered.sections.map((item) => {
    const signals = [];
    if (item.reversed) signals.push(`range normalized from ${item.requestedStart}-${item.requestedEnd}`);
    if (item.shifted) signals.push(`window shifted to available edge while preserving up to ${Math.abs(item.normalizedEnd - item.normalizedStart) + 1} requested line(s)`);
    if (item.lineCapped) signals.push("range capped at 800 lines");
    if (item.outputTruncated) signals.push("range output reached its allocated byte budget at a line boundary");
    return `--- lines ${item.actualStart}-${item.actualEnd} of ${rendered.totalLines} (requested ${item.requestedStart}-${item.requestedEnd}) ---\n${item.body}${signals.length ? `\n[RANGE SIGNALS: ${signals.join("; ")}]` : ""}`;
  });
  const stability = formatStability(snapshot);
  return `${path} (${sourceLabel}; ${formatSize(snapshot.size)}, encoding=${snapshot.encoding}, sha256 ${snapshot.fingerprint}, stable=${snapshot.stable}):\n${sections.join("\n\n")}${stability.length ? `\n[READ RECOVERY: ${stability.join("; ")}]` : ""}`;
}

export function executeReadMany(args, context, options = {}) {
  const base = args.base_dir ?? context.directory ?? options.directory;
  const completeByKey = new Map();
  const rangesByKey = new Map();
  const consolidated = [];
  for (const path of args.paths ?? []) {
    const info = canonicalPathInfo(base, path);
    if (completeByKey.has(info.key)) consolidated.push(`${path} duplicates complete read ${completeByKey.get(info.key).path}`);
    else completeByKey.set(info.key, { path, ...info });
  }
  const seenRanges = new Set();
  for (const request of args.requests ?? []) {
    const info = canonicalPathInfo(base, request.path);
    if (!rangesByKey.has(info.key)) rangesByKey.set(info.key, { path: request.path, ...info, ranges: [] });
    const group = rangesByKey.get(info.key);
    for (const range of request.ranges) {
      const low = Math.min(range.start_line, range.end_line);
      const high = Math.max(range.start_line, range.end_line);
      const rangeKey = `${info.key}:${low}:${high}`;
      if (seenRanges.has(rangeKey)) consolidated.push(`${request.path} duplicate range ${range.start_line}-${range.end_line} consolidated`);
      else {
        seenRanges.add(rangeKey);
        group.ranges.push(range);
      }
    }
  }

  const allKeys = new Set([...completeByKey.keys(), ...rangesByKey.keys()]);
  if (!allKeys.size) return "READ RESULT: FAILED\nNo unique complete or ranged read targets remained after consolidation.";
  const snapshots = new Map();
  const unavailable = [];
  const pathCandidates = [];
  for (const key of allKeys) {
    const item = completeByKey.get(key) ?? rangesByKey.get(key);
    const snapshot = readTextStable(item.targetPath);
    snapshots.set(key, snapshot);
    if (snapshot.error) {
      unavailable.push(`${item.path}: ${snapshot.error}`);
      if (!existsSync(item.targetPath)) {
        const candidates = findMissingPathCandidates(item.targetPath, base);
        if (candidates.length) pathCandidates.push(`${item.path}: ${candidates.map((candidate) => `${candidate.path} (${candidate.reason})`).join(", ")}`);
      }
    } else if (snapshot.binary) unavailable.push(`${item.path}: binary or unsupported encoding (${snapshot.encoding})`);
  }

  const completeNeeds = [];
  let uncoveredRangeReserve = 0;
  for (const [key] of completeByKey) {
    const snapshot = snapshots.get(key);
    if (snapshot.error || snapshot.binary) continue;
    const need = renderedNeed(snapshot);
    completeNeeds.push({ key, need });
    if (rangesByKey.has(key) && need > 48 * 1024) uncoveredRangeReserve += 24 * 1024;
  }
  uncoveredRangeReserve = Math.min(uncoveredRangeReserve, Math.floor(MAX_TOTAL_READ_BYTES * 0.35));
  const completeBudgetPool = Math.max(0, MAX_TOTAL_READ_BYTES - uncoveredRangeReserve);
  const completeBudgets = waterfillBudgets(completeNeeds, completeBudgetPool);
  const completeResults = new Map();
  let completeUsed = 0;
  for (const [key, item] of completeByKey) {
    const snapshot = snapshots.get(key);
    if (snapshot.error || snapshot.binary) continue;
    const rendered = renderBoundedSnapshot(snapshot, completeBudgets.get(key) ?? 0);
    completeResults.set(key, rendered);
    completeUsed += rendered.renderedBytes;
  }

  const remainingBudget = Math.max(0, MAX_TOTAL_READ_BYTES - completeUsed);
  const rangePlans = [];
  for (const [key, item] of rangesByKey) {
    const snapshot = snapshots.get(key);
    if (snapshot.error || snapshot.binary) continue;
    const complete = completeResults.get(key);
    const uncovered = complete && !complete.truncated
      ? []
      : complete
        ? item.ranges.filter((range) => !rangeCoveredByRegions(range, complete.regions))
        : item.ranges;
    const coveredCount = item.ranges.length - uncovered.length;
    if (coveredCount) consolidated.push(`${item.path}: ${coveredCount} ranged request(s) already covered by returned complete-read region(s)`);
    if (uncovered.length) {
      const requestedRangeNeed = renderRanges(snapshot, uncovered, MAX_TOTAL_READ_BYTES).bytesShown;
      rangePlans.push({ key, item, snapshot, ranges: uncovered, need: requestedRangeNeed });
    }
  }
  const rangeBudgets = waterfillBudgets(rangePlans.map((plan) => ({ key: plan.key, need: plan.need })), remainingBudget);
  const rangeResults = new Map();
  for (const plan of rangePlans) rangeResults.set(plan.key, renderRanges(plan.snapshot, plan.ranges, rangeBudgets.get(plan.key) ?? 0));

  const output = [];
  const read = [];
  const truncated = [];
  const recovery = [];
  for (const [key, item] of completeByKey) {
    const snapshot = snapshots.get(key);
    if (snapshot.error || snapshot.binary) {
      output.push(formatComplete(item.path, snapshot, {}));
      continue;
    }
    const rendered = completeResults.get(key);
    output.push(formatComplete(item.path, snapshot, rendered));
    read.push(`${item.path}: ${rendered.truncated ? "bounded head/tail complete-file evidence" : "complete file"}; returned_rendered_bytes=${rendered.renderedBytes}; source_bytes=${snapshot.size}; encoding=${snapshot.encoding}; sha256=${snapshot.fingerprint}`);
    if (rendered.truncated) truncated.push(rendered.omitted
      ? `${item.path}: omitted lines ${rendered.omitted.startLine}-${rendered.omitted.endLine}; decoded bytes ${rendered.omitted.startByte}-${rendered.omitted.endByte}; ${rendered.omitted.bytes} decoded byte(s) omitted`
      : `${item.path}: an oversized single line was returned as a marked fragment`);
    recovery.push(...formatStability(snapshot).map((signal) => `${item.path}: ${signal}`));
  }
  for (const plan of rangePlans) {
    const rendered = rangeResults.get(plan.key);
    output.push(formatRanges(plan.item.path, plan.snapshot, rendered, completeResults.has(plan.key) ? "uncovered requested ranges retained beside truncated complete evidence" : "requested ranges"));
    read.push(`${plan.item.path}: ${rendered.sections.length} ranged section(s); returned_rendered_bytes=${rendered.bytesShown}; encoding=${plan.snapshot.encoding}; sha256=${plan.snapshot.fingerprint}`);
    if (rendered.sections.some((section) => section.outputTruncated)) truncated.push(`${plan.item.path}: at least one retained range exceeded its allocated output budget`);
  }

  const unstable = [...snapshots.entries()].filter(([, snapshot]) => snapshot.stable === false).length;
  const status = unavailable.length || truncated.length || unstable ? read.length ? "PARTIAL SUCCESS" : "FAILED" : "SUCCESS";
  const meaning = status === "SUCCESS"
    ? `All ${read.length} requested text evidence item(s) were returned completely and stably.`
    : status === "PARTIAL SUCCESS"
      ? `Usable evidence was returned, but ${unavailable.length} target(s) were unavailable, ${truncated.length} item(s) were bounded, or ${unstable} source(s) remained unstable.`
      : "No requested text evidence could be returned safely.";
  output.push(
    `READ RESULT: ${status}`,
    `WHAT HAPPENED: ${meaning}`,
    `RETURNED EVIDENCE (${read.length}):\n${read.length ? read.map((item) => `- ${item}`).join("\n") : "- none"}`,
    `REQUEST CONSOLIDATION (${consolidated.length}):\n${consolidated.length ? consolidated.map((item) => `- ${item}`).join("\n") : "- No duplicate or already-covered requests."}`,
    `BOUNDED OR OMITTED EVIDENCE (${truncated.length}):\n${truncated.length ? truncated.map((item) => `- ${item}`).join("\n") : "- None; all returned text fit the shared budget."}`,
    `UNAVAILABLE TARGETS (${unavailable.length}):\n${unavailable.length ? unavailable.map((item) => `- ${item}`).join("\n") : "- None."}`,
    `POSSIBLE PATHS FOR MISSING TARGETS (${pathCandidates.length}):\n${pathCandidates.length ? pathCandidates.map((item) => `- ${item}`).join("\n") : "- None. Candidate content was never substituted for the requested path."}`,
    `READ RECOVERY (${recovery.length}):\n${recovery.length ? recovery.map((item) => `- ${item}`).join("\n") : "- No retry or stability recovery was needed."}`,
    `OUTPUT BUDGET:\n  Shared total: ${MAX_TOTAL_READ_BYTES} bytes\n  Complete-file pool: ${completeBudgetPool} bytes\n  Reserved for uncovered explicit ranges: ${uncoveredRangeReserve} bytes\n  Complete-file evidence used: ${completeUsed} bytes\n  Remaining range budget: ${remainingBudget} bytes\n  Allocation: adaptive across all requested evidence.`,
    `EDIT CONTEXT:\n  Complete files: ${[...completeResults.values()].filter((result) => !result.truncated).length}\n  Partial files/ranges: ${truncated.length}\n  Explicit ranged targets: ${rangePlans.length}\n  Unstable sources: ${unstable}\n  Unavailable targets: ${unavailable.length}`,
  );
  return output.join("\n\n");
}
