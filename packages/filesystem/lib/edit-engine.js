import { existsSync, statSync } from "node:fs";
import { canonicalPathInfo, countOccurrences, formatSize, sha256, uniqueMessages } from "./common.js";
import { applyAtomicWithRetries, atomicCreateText, atomicReplaceText, readTextStable } from "./text-io.js";

function normalizeNewlines(value) {
  return value.replaceAll("\r\n", "\n");
}

function normalizeWhitespace(value) {
  return normalizeNewlines(value).split("\n").map((line) => line.trim()).join("\n");
}

function commonPrefixLength(left, right) {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;
  return index;
}

function commonSuffixLength(left, right, prefixLength = 0) {
  const limit = Math.min(left.length, right.length) - prefixLength;
  let length = 0;
  while (length < limit && left[left.length - 1 - length] === right[right.length - 1 - length]) length += 1;
  return length;
}

function characterEvidence(value, offset) {
  if (offset >= value.length) return { display: "<end of text>", codePoint: null };
  const point = value.codePointAt(offset);
  const character = String.fromCodePoint(point);
  const labels = new Map([[0x09, "TAB"], [0x0a, "LINE FEED"], [0x0d, "CARRIAGE RETURN"], [0x20, "SPACE"], [0xa0, "NO-BREAK SPACE"]]);
  return {
    display: labels.get(point) ?? JSON.stringify(character),
    codePoint: `U+${point.toString(16).toUpperCase().padStart(4, "0")}`,
  };
}

function comparisonFragment(value, offset, radius = 42) {
  const start = Math.max(0, offset - radius);
  const end = Math.min(value.length, offset + radius);
  return `${start > 0 ? "..." : ""}${JSON.stringify(value.slice(start, end)).slice(1, -1)}${end < value.length ? "..." : ""}`;
}

function sourceComparison(search, lines, candidates) {
  if (!candidates.length) return null;
  const normalizedSearch = normalizeNewlines(search);
  const lineCount = Math.max(1, normalizedSearch.split("\n").length);
  const ranked = candidates.map((candidate) => {
    const text = lines.slice(candidate.line - 1, candidate.line - 1 + lineCount).join("\n");
    const prefix = commonPrefixLength(normalizedSearch, text);
    const suffix = commonSuffixLength(normalizedSearch, text, prefix);
    return { line: candidate.line, text, prefix, suffix, similarity: prefix + suffix };
  }).sort((left, right) => right.similarity - left.similarity || left.line - right.line);
  const closest = ranked[0];
  const firstDifferenceOffset = closest.prefix;
  return {
    line: closest.line,
    searchCharacters: normalizedSearch.length,
    candidateCharacters: closest.text.length,
    searchUtf8Bytes: Buffer.byteLength(normalizedSearch),
    candidateUtf8Bytes: Buffer.byteLength(closest.text),
    sharedPrefixCharacters: closest.prefix,
    sharedSuffixCharacters: closest.suffix,
    firstDifferenceOffset,
    submittedCharacter: characterEvidence(normalizedSearch, firstDifferenceOffset),
    currentCharacter: characterEvidence(closest.text, firstDifferenceOffset),
    submittedFragment: comparisonFragment(normalizedSearch, firstDifferenceOffset),
    currentFragment: comparisonFragment(closest.text, firstDifferenceOffset),
    comparableCandidates: ranked.filter((item) => item.similarity === closest.similarity).length,
  };
}

function candidateEvidence(content, search, replace, expected, actual) {
  const lines = content.split(/\r?\n/);
  const searchLines = normalizeNewlines(search).split("\n").map((line) => line.trim()).filter(Boolean);
  const terms = searchLines.flatMap((line) => line.split(/[^A-Za-z0-9_$.-]+/)).filter((term) => term.length >= 4).slice(0, 8);
  const candidates = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const score = terms.reduce((sum, term) => sum + (line.includes(term) ? 1 : 0), 0);
    if (score > 0 || searchLines.some((part) => part && line.includes(part.slice(0, Math.min(part.length, 24))))) {
      candidates.push({ line: index + 1, score, text: line.length > 240 ? `${line.slice(0, 240)} [line truncated]` : line });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.line - b.line);
  const newlineNormalizedCount = countOccurrences(normalizeNewlines(content), normalizeNewlines(search));
  const whitespaceNormalizedCount = countOccurrences(normalizeWhitespace(content), normalizeWhitespace(search));
  const replacementCount = replace ? countOccurrences(content, replace) : 0;
  return {
    exactSearchCount: actual,
    expectedSearchCount: expected,
    exactReplacementCount: replacementCount,
    newlineNormalizedCount,
    whitespaceNormalizedCount,
    candidates: candidates.slice(0, 3),
    comparison: sourceComparison(search, lines, candidates),
    note: "Candidate evidence may or may not represent the intended edit target; no fuzzy replacement was applied.",
  };
}

function formatEvidence(evidence) {
  if (!evidence || typeof evidence !== "object") return evidence ? `  Technical detail: ${evidence}` : "";
  const replacementState = evidence.exactReplacementCount === evidence.expectedSearchCount
    ? `yes, exactly ${evidence.exactReplacementCount} time(s)`
    : evidence.exactReplacementCount > 0
      ? `partially or unexpectedly present ${evidence.exactReplacementCount} time(s)`
      : "no";
  const candidates = evidence.candidates.length
    ? evidence.candidates.map((item) => `    - Line ${item.line}: ${item.text}`).join("\n")
    : "    - None found within the bounded candidate scan.";
  const comparison = evidence.comparison
    ? [
        "  Current-source comparison (informational only):",
        `    - Closest candidate location: line ${evidence.comparison.line}`,
        `    - Submitted length: ${evidence.comparison.searchCharacters} character(s), ${evidence.comparison.searchUtf8Bytes} UTF-8 byte(s)`,
        `    - Current candidate length: ${evidence.comparison.candidateCharacters} character(s), ${evidence.comparison.candidateUtf8Bytes} UTF-8 byte(s)`,
        `    - Shared prefix: ${evidence.comparison.sharedPrefixCharacters} character(s)`,
        `    - Shared suffix: ${evidence.comparison.sharedSuffixCharacters} character(s)`,
        `    - First differing offset: ${evidence.comparison.firstDifferenceOffset}`,
        `    - Submitted character: ${evidence.comparison.submittedCharacter.display}${evidence.comparison.submittedCharacter.codePoint ? ` (${evidence.comparison.submittedCharacter.codePoint})` : ""}`,
        `    - Current character: ${evidence.comparison.currentCharacter.display}${evidence.comparison.currentCharacter.codePoint ? ` (${evidence.comparison.currentCharacter.codePoint})` : ""}`,
        `    - Submitted fragment: ${evidence.comparison.submittedFragment}`,
        `    - Current fragment: ${evidence.comparison.currentFragment}`,
        `    - Candidates with the same bounded similarity: ${evidence.comparison.comparableCandidates}`,
      ]
    : [];
  return [
    "  Diagnostic evidence (informational only):",
    `    - Exact search matches: ${evidence.exactSearchCount}`,
    `    - Expected exact matches: ${evidence.expectedSearchCount}`,
    `    - Matches after newline normalization: ${evidence.newlineNormalizedCount}`,
    `    - Matches after whitespace normalization: ${evidence.whitespaceNormalizedCount}`,
    `    - Replacement text already present: ${replacementState}`,
    "  Nearby candidate lines:",
    candidates,
    ...comparison,
    "  Interpretation: the target text may have changed, the wrong file/version may be selected, or the edit may already exist in a different form.",
    "  Safety rule: candidate evidence is uncertain. No approximate or fuzzy replacement was attempted.",
  ].join("\n");
}

function explainFailure(reason) {
  const exact = reason.match(/^action #(\d+) patch replacement #(\d+)(?: no-op assertion)? expected (\d+) exact match\(es\), found (\d+)$/);
  if (exact) return {
    failedStep: `Action ${exact[1]}, patch replacement ${exact[2]}`,
    expected: `The search text must appear exactly ${exact[3]} time(s).`,
    observed: `The search text appeared ${exact[4]} time(s).`,
  };
  const fingerprint = reason.match(/^action #(\d+) \(([^)]+)\) expected sha256 ([a-f0-9]+), found ([a-f0-9]+)$/i);
  if (fingerprint) return {
    failedStep: `Action ${fingerprint[1]}, ${fingerprint[2]}`,
    expected: `The staged file fingerprint must be ${fingerprint[3]}.`,
    observed: `The staged file fingerprint is ${fingerprint[4]}.`,
  };
  return { failedStep: "File transaction validation or atomic write", expected: "Every strict precondition and atomic-write safety check must pass.", observed: reason };
}

function formatRejected(item) {
  const explanation = explainFailure(item.reason);
  return [
    `FILE NOT CHANGED: ${item.path}`,
    `  Failed step: ${explanation.failedStep}`,
    `  Expected: ${explanation.expected}`,
    `  Observed: ${explanation.observed}`,
    "  Safety outcome: no part of this file transaction was written.",
    item.evidence ? formatEvidence(item.evidence) : "",
  ].filter(Boolean).join("\n");
}

function evaluateActions(initiallyExists, initialContent, actions) {
  let virtualExists = initiallyExists;
  let content = initialContent ?? "";
  const recovery = [];
  const noOps = [];
  for (const action of actions) {
    const operation = action.operation;
    if (action.expected_sha256 && sha256(content) !== action.expected_sha256) {
      return { failure: `action #${action.globalIndex} (${operation}) expected sha256 ${action.expected_sha256}, found ${sha256(content)}`, content, recovery, noOps };
    }
    if (operation === "create") {
      if (virtualExists) return { failure: `action #${action.globalIndex} create requires a missing file, but staged target already exists`, content, recovery, noOps };
      content = action.content;
      virtualExists = true;
      continue;
    }
    if (operation === "overwrite") {
      if (!virtualExists) return { failure: `action #${action.globalIndex} overwrite requires an existing staged file; an earlier create action can establish it`, content, recovery, noOps };
      content = action.content;
      continue;
    }
    if (!virtualExists) return { failure: `action #${action.globalIndex} patch requires an existing staged file; an earlier create action can establish it`, content, recovery, noOps };
    for (let replacementIndex = 0; replacementIndex < action.replacements.length; replacementIndex += 1) {
      const replacement = action.replacements[replacementIndex];
      const expected = replacement.expected_count ?? 1;
      const actual = countOccurrences(content, replacement.search);
      if (replacement.search === replacement.replace) {
        if (actual !== expected) {
          const evidence = candidateEvidence(content, replacement.search, replacement.replace, expected, actual);
          return { failure: `action #${action.globalIndex} patch replacement #${replacementIndex + 1} no-op assertion expected ${expected} exact match(es), found ${actual}`, evidence, content, recovery, noOps };
        }
        noOps.push(`action #${action.globalIndex} replacement #${replacementIndex + 1} was an exact no-op assertion`);
        continue;
      }
      if (actual !== expected) {
        const replacementCount = replacement.replace ? countOccurrences(content, replacement.replace) : 0;
        if (replacement.allow_already_applied === true && actual === 0 && replacement.replace && replacementCount === expected) {
          recovery.push(`action #${action.globalIndex} replacement #${replacementIndex + 1} was already present exactly ${expected} time(s)`);
          continue;
        }
        const evidence = candidateEvidence(content, replacement.search, replacement.replace, expected, actual);
        return { failure: `action #${action.globalIndex} patch replacement #${replacementIndex + 1} expected ${expected} exact match(es), found ${actual}`, evidence, content, recovery, noOps };
      }
      content = content.split(replacement.search).join(replacement.replace);
    }
  }
  return { content, virtualExists, recovery, noOps };
}

export function executeEditMany(args, context, options = {}) {
  const base = args.base_dir ?? context.directory ?? options.directory;
  const replaceWriter = options.replaceWriter ?? atomicReplaceText;
  const createWriter = options.createWriter ?? atomicCreateText;
  const beforeApply = options.beforeEditApply ?? (() => {});
  const groups = new Map();
  args.actions.forEach((action, index) => {
    const info = canonicalPathInfo(base, action.path);
    if (!groups.has(info.key)) groups.set(info.key, { ...info, displayPath: action.path, aliases: new Set(), actions: [] });
    const group = groups.get(info.key);
    group.aliases.add(action.path);
    group.actions.push({ ...action, globalIndex: index + 1 });
  });

  const staged = [];
  const rejected = [];
  const unchanged = [];
  const recoveries = [];
  for (const group of groups.values()) {
    const initial = readTextStable(group.targetPath);
    const initiallyExists = !initial.error;
    if (initial.binary) {
      rejected.push({ path: group.displayPath, reason: "initial target is binary and cannot participate in text edits" });
      continue;
    }
    if (initial.error && existsSync(group.targetPath)) {
      rejected.push({ path: group.displayPath, reason: `initial read failed: ${initial.error}` });
      continue;
    }
    const originalContent = initiallyExists ? initial.content : null;
    const originalMode = initiallyExists ? statSync(group.targetPath).mode & 0o777 : 0o600;
    const evaluated = evaluateActions(initiallyExists, originalContent, group.actions);
    recoveries.push(...(initial.recoveries ?? []).map((item) => `${group.displayPath}: ${item}`));
    if (evaluated.failure) {
      rejected.push({ path: group.displayPath, reason: evaluated.failure, evidence: evaluated.evidence ?? null });
    } else if (initiallyExists && evaluated.content === originalContent) {
      unchanged.push({ path: group.displayPath, actions: group.actions.length, fingerprint: sha256(evaluated.content), recovery: evaluated.recovery, noOps: evaluated.noOps });
    } else {
      staged.push({ ...group, initiallyExists, originalContent, originalMode, content: evaluated.content, recovery: evaluated.recovery, noOps: evaluated.noOps, patchOnly: group.actions.every((action) => action.operation === "patch") });
    }
  }

  const applied = [];
  for (const group of staged) {
    beforeApply(group);
    if (group.initiallyExists) {
      let baseContent = group.originalContent;
      let finalContent = group.content;
      let rebases = 0;
      const verify = () => {
        const current = readTextStable(group.targetPath);
        if (current.error || current.binary) return { ok: false, reason: `pre-write recheck failed: ${current.error ?? "target became binary"}` };
        if (current.content === baseContent) return { ok: true };
        if (!group.patchOnly || rebases >= 2) return { ok: false, reason: "file changed after validation; staged transaction was not applied" };
        const rebased = evaluateActions(true, current.content, group.actions);
        if (rebased.failure) return { ok: false, reason: `File changed after validation and exact patch rebase failed: ${rebased.failure}`, evidence: rebased.evidence ?? null };
        baseContent = current.content;
        finalContent = rebased.content;
        group.content = rebased.content;
        group.recovery.push(`patch-only transaction rebased against newer exact content (rebase ${rebases + 1})`);
        group.recovery.push(...rebased.recovery);
        rebases += 1;
        return { ok: true };
      };
      const result = applyAtomicWithRetries(() => replaceWriter(group.targetPath, finalContent, group.originalMode), verify);
      group.recovery.push(...result.recovery);
      if (result.applied) {
        applied.push({ path: group.displayPath, kind: "updated", actions: group.actions.length, bytes: Buffer.byteLength(finalContent), fingerprint: sha256(finalContent), aliases: [...group.aliases], recovery: uniqueMessages(group.recovery), noOps: group.noOps });
      } else rejected.push({ path: group.displayPath, reason: result.reason, evidence: result.evidence ?? null });
    } else {
      const verify = () => {
        if (!existsSync(group.targetPath)) return { ok: true };
        const current = readTextStable(group.targetPath);
        if (!current.error && !current.binary && current.content === group.content) return { ok: false, identical: true, reason: "target appeared concurrently with identical final content" };
        return { ok: false, reason: "file appeared after validation with different or unreadable content; create transaction was not applied" };
      };
      const initialVerification = verify();
      if (initialVerification.identical) {
        unchanged.push({ path: group.displayPath, actions: group.actions.length, fingerprint: sha256(group.content), recovery: [initialVerification.reason], noOps: group.noOps });
        continue;
      }
      const result = applyAtomicWithRetries(() => createWriter(group.targetPath, group.content, 0o600), verify);
      group.recovery.push(...result.recovery);
      if (result.applied) applied.push({ path: group.displayPath, kind: "created", actions: group.actions.length, bytes: Buffer.byteLength(group.content), fingerprint: sha256(group.content), aliases: [...group.aliases], recovery: uniqueMessages(group.recovery), noOps: group.noOps });
      else {
        const after = verify();
        if (after.identical) unchanged.push({ path: group.displayPath, actions: group.actions.length, fingerprint: sha256(group.content), recovery: [after.reason, ...group.recovery], noOps: group.noOps });
        else rejected.push({ path: group.displayPath, reason: result.reason });
      }
    }
  }

  const status = rejected.length === 0 ? "SUCCESS" : applied.length || unchanged.length ? "PARTIAL SUCCESS" : "FAILED";
  const detail = (item) => {
    const lines = [
      `${item.kind === "created" ? "FILE CREATED" : item.kind === "updated" ? "FILE UPDATED" : "FILE ALREADY SATISFIED"}: ${item.path}`,
      `  Actions evaluated: ${item.actions}`,
      item.bytes === undefined ? "" : `  Final text size: ${formatSize(item.bytes)}`,
      `  Final SHA-256: ${item.fingerprint}`,
      item.aliases?.length > 1 ? `  Equivalent requested paths: ${item.aliases.join(", ")}` : "",
      ...(item.recovery ?? []).map((entry) => `  Recovery used: ${entry}`),
      ...(item.noOps ?? []).map((entry) => `  No-op confirmed: ${entry}`),
    ];
    return lines.filter(Boolean).join("\n");
  };
  const outcome = status === "SUCCESS"
    ? `All ${groups.size} file transaction(s) completed safely.`
    : status === "PARTIAL SUCCESS"
      ? `${applied.length + unchanged.length} file transaction(s) completed safely; ${rejected.length} failed independently.`
      : `No file transaction was applied because all ${rejected.length} failed strict validation or atomic-write safety checks.`;
  return [
    `EDIT RESULT: ${status}`,
    `WHAT HAPPENED: ${outcome}`,
    `APPLIED (${applied.length}):\n${applied.length ? applied.map(detail).join("\n\n") : "- none"}`,
    `UNCHANGED (${unchanged.length}):\n${unchanged.length ? unchanged.map(detail).join("\n\n") : "- none"}`,
    `REJECTED (${rejected.length}):\n${rejected.length ? rejected.map(formatRejected).join("\n\n") : "- none"}`,
    `READ/WRITE RECOVERY (${recoveries.length}):\n${recoveries.length ? uniqueMessages(recoveries).map((item) => `- ${item}`).join("\n") : "- none required"}`,
    `TECHNICAL SUMMARY:\n  Requested actions: ${args.actions.length}\n  Canonical file transactions: ${groups.size}\n  Applied: ${applied.length}\n  Already satisfied: ${unchanged.length}\n  Rejected: ${rejected.length}`,
    "SAFETY MODEL: actions for one canonical file are evaluated as one transaction and written at most once. A rejected file stays unchanged; independent valid files may still complete.",
  ].join("\n\n");
}
