import {
  chmodSync,
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { TextDecoder } from "node:util";
import { basename, dirname, join, relative } from "node:path";
import {
  BINARY_SAMPLE_BYTES,
  basenameParts,
  boundedLevenshtein,
  formatSize,
  isTransientError,
  looksBinary,
  normalizeSlashes,
  pathExists,
  retryTransient,
  sha256,
  sleepSync,
  uniqueMessages,
} from "./common.js";

const STABLE_READ_ATTEMPTS = 3;
const MAX_PATH_CANDIDATES = 6;
const MAX_PATH_SCAN_ENTRIES = 1200;
let atomicWriteCounter = 0;

function decodeUtf16Be(buffer) {
  const evenLength = buffer.length - (buffer.length % 2);
  const swapped = Buffer.alloc(evenLength);
  for (let index = 0; index < evenLength; index += 2) {
    swapped[index] = buffer[index + 1];
    swapped[index + 1] = buffer[index];
  }
  return swapped.toString("utf16le");
}

export function decodeTextBuffer(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { text: buffer.subarray(3).toString("utf8"), encoding: "utf-8-bom", bomBytes: 3 };
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { text: buffer.subarray(2).toString("utf16le"), encoding: "utf-16le", bomBytes: 2 };
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return { text: decodeUtf16Be(buffer.subarray(2)), encoding: "utf-16be", bomBytes: 2 };
  }
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(buffer), encoding: "utf-8", bomBytes: 0 };
  } catch {
    if (looksBinary(buffer.subarray(0, Math.min(buffer.length, BINARY_SAMPLE_BYTES)))) {
      return { binary: true, encoding: "binary-or-unsupported" };
    }
    return { text: buffer.toString("utf8"), encoding: "utf-8-with-replacement", bomBytes: 0, decodingWarning: true };
  }
}

function sameStat(left, right) {
  return left.size === right.size && left.mtimeMs === right.mtimeMs;
}

export function readTextStable(path, {
  attempts = STABLE_READ_ATTEMPTS,
  statReader = statSync,
  fileReader = readFileSync,
  sleep = sleepSync,
} = {}) {
  const recoveries = [];
  const snapshots = [];
  let latest;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const before = retryTransient(() => statReader(path));
      recoveries.push(...before.recoveries);
      if (!before.value.isFile()) return { error: "Path is not a regular file.", path, recoveries };
      const read = retryTransient(() => fileReader(path));
      recoveries.push(...read.recoveries);
      const after = retryTransient(() => statReader(path));
      recoveries.push(...after.recoveries);
      const decoded = decodeTextBuffer(read.value);
      if (decoded.binary) return { binary: true, path, size: before.value.size, encoding: decoded.encoding, recoveries };
      latest = {
        content: decoded.text,
        buffer: read.value,
        size: read.value.length,
        path,
        encoding: decoded.encoding,
        decodingWarning: decoded.decodingWarning ?? false,
        fingerprint: sha256(decoded.text),
        stat: after.value,
      };
      snapshots.push({ attempt, size: read.value.length, fingerprint: latest.fingerprint, stable: sameStat(before.value, after.value) });
      if (sameStat(before.value, after.value)) {
        return { ...latest, stable: true, attempts: attempt, recoveries: uniqueMessages(recoveries), snapshots };
      }
      recoveries.push(`file metadata changed during read attempt ${attempt}`);
      if (attempt < attempts) sleep(15 * attempt);
    } catch (error) {
      if (error.code === "ENOENT") return { error: error.message, code: error.code, path, recoveries, snapshots };
      if (isTransientError(error) && attempt < attempts) {
        recoveries.push(`transient ${error.code} prevented read attempt ${attempt}`);
        sleep(20 * attempt);
        continue;
      }
      return { error: error.message, code: error.code, path, recoveries, snapshots };
    }
  }
  return latest
    ? { ...latest, stable: false, attempts, recoveries: uniqueMessages(recoveries), snapshots }
    : { error: "Unable to obtain a text snapshot.", path, recoveries, snapshots };
}

export function buildLineIndex(content) {
  const rawLines = content.split(/\r?\n/);
  const lines = [];
  let byteOffset = 0;
  for (let index = 0; index < rawLines.length; index += 1) {
    const text = rawLines[index];
    const textBytes = Buffer.byteLength(text);
    const separatorBytes = index < rawLines.length - 1 ? 1 : 0;
    lines.push({ number: index + 1, text, startByte: byteOffset, endByte: byteOffset + textBytes, recordEndByte: byteOffset + textBytes + separatorBytes });
    byteOffset += textBytes + separatorBytes;
  }
  return { lines, decodedBytes: byteOffset };
}

function takeHead(lines, budget) {
  const selected = [];
  let bytes = 0;
  for (const line of lines) {
    const recordBytes = Buffer.byteLength(`${line.number}: ${line.text}${selected.length || line.number < lines.length ? "\n" : ""}`);
    if (selected.length && bytes + recordBytes > budget) break;
    if (!selected.length && recordBytes > budget) {
      const prefix = Buffer.from(`${line.number}: ${line.text}`).subarray(0, Math.max(0, budget)).toString("utf8");
      return { lines: [{ ...line, rendered: `${prefix} [line fragment]` }], bytes: Buffer.byteLength(prefix), fragmented: true };
    }
    selected.push({ ...line, rendered: `${line.number}: ${line.text}` });
    bytes += recordBytes;
  }
  return { lines: selected, bytes, fragmented: false };
}

function takeTail(lines, budget, minimumLine) {
  const selected = [];
  let bytes = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line.number < minimumLine) break;
    const recordBytes = Buffer.byteLength(`${line.number}: ${line.text}${selected.length ? "\n" : ""}`);
    if (selected.length && bytes + recordBytes > budget) break;
    if (!selected.length && recordBytes > budget) {
      const full = Buffer.from(`${line.number}: ${line.text}`);
      const suffix = full.subarray(Math.max(0, full.length - budget)).toString("utf8");
      return { lines: [{ ...line, rendered: `[line fragment] ${suffix}` }], bytes: Buffer.byteLength(suffix), fragmented: true };
    }
    selected.unshift({ ...line, rendered: `${line.number}: ${line.text}` });
    bytes += recordBytes;
  }
  return { lines: selected, bytes, fragmented: false };
}

export function renderBoundedSnapshot(snapshot, budget) {
  const { lines, decodedBytes } = buildLineIndex(snapshot.content);
  const fullRendered = lines.map((line) => `${line.number}: ${line.text}`).join("\n");
  const fullRenderedBytes = Buffer.byteLength(fullRendered);
  if (fullRenderedBytes <= budget) {
    return {
      truncated: false,
      text: fullRendered,
      totalLines: lines.length,
      decodedBytes,
      renderedBytes: fullRenderedBytes,
      regions: [{ kind: "full", startLine: 1, endLine: lines.length, startByte: 0, endByte: decodedBytes }],
      omitted: null,
    };
  }
  const headBudget = Math.max(1, Math.floor(budget * 0.68));
  const tailBudget = Math.max(1, budget - headBudget);
  const head = takeHead(lines, headBudget);
  const headEnd = head.lines.at(-1)?.number ?? 0;
  const tail = takeTail(lines, tailBudget, headEnd + 1);
  const tailStart = tail.lines[0]?.number ?? lines.length + 1;
  const headText = head.lines.map((line) => line.rendered).join("\n");
  const tailText = tail.lines.map((line) => line.rendered).join("\n");
  const omittedStartLine = headEnd + 1;
  const omittedEndLine = tailStart - 1;
  const omittedStartByte = lines[omittedStartLine - 1]?.startByte ?? decodedBytes;
  const omittedEndByte = omittedEndLine >= omittedStartLine ? lines[omittedEndLine - 1]?.recordEndByte ?? omittedStartByte : omittedStartByte;
  const separator = omittedEndLine >= omittedStartLine
    ? `\n\n[OMITTED REGION: lines ${omittedStartLine}-${omittedEndLine}; decoded bytes ${omittedStartByte}-${Math.max(omittedStartByte, omittedEndByte - 1)}; ${Math.max(0, omittedEndByte - omittedStartByte)} decoded byte(s) not returned]\n\n`
    : "\n";
  return {
    truncated: true,
    text: `${headText}${separator}${tailText}`,
    totalLines: lines.length,
    decodedBytes,
    renderedBytes: Buffer.byteLength(headText) + Buffer.byteLength(tailText),
    regions: [
      ...(head.lines.length ? [{ kind: "head", startLine: head.lines[0].number, endLine: headEnd, startByte: 0, endByte: head.lines.at(-1).recordEndByte }] : []),
      ...(tail.lines.length ? [{ kind: "tail", startLine: tailStart, endLine: tail.lines.at(-1).number, startByte: tail.lines[0].startByte, endByte: decodedBytes }] : []),
    ],
    omitted: omittedEndLine >= omittedStartLine ? {
      startLine: omittedStartLine,
      endLine: omittedEndLine,
      startByte: omittedStartByte,
      endByte: Math.max(omittedStartByte, omittedEndByte - 1),
      bytes: Math.max(0, omittedEndByte - omittedStartByte),
      lines: omittedEndLine - omittedStartLine + 1,
    } : null,
    fragmented: head.fragmented || tail.fragmented,
  };
}

export function normalizeRange(startLine, endLine, totalLines) {
  const low = Math.min(startLine, endLine);
  const high = Math.max(startLine, endLine);
  const reversed = startLine > endLine;
  const requestedSpan = high - low + 1;
  const span = Math.min(requestedSpan, 800, Math.max(1, totalLines));
  let actualStart;
  let actualEnd;
  if (totalLines <= 0) {
    actualStart = 0;
    actualEnd = 0;
  } else if (low > totalLines || high > totalLines) {
    actualEnd = totalLines;
    actualStart = Math.max(1, actualEnd - span + 1);
  } else {
    actualStart = low;
    actualEnd = Math.min(totalLines, actualStart + span - 1);
  }
  return {
    requestedStart: startLine,
    requestedEnd: endLine,
    normalizedStart: low,
    normalizedEnd: high,
    actualStart,
    actualEnd,
    reversed,
    shifted: actualStart !== low || actualEnd !== high,
    lineCapped: requestedSpan > 800,
  };
}

export function renderRanges(snapshot, ranges, budget) {
  const { lines, decodedBytes } = buildLineIndex(snapshot.content);
  const sections = [];
  let remaining = budget;
  for (const request of ranges) {
    if (remaining <= 0) break;
    const range = normalizeRange(request.start_line, request.end_line, lines.length);
    const selected = range.actualStart > 0 ? lines.slice(range.actualStart - 1, range.actualEnd) : [];
    const raw = selected.map((line) => `${line.number}: ${line.text}`).join("\n");
    const rawBuffer = Buffer.from(raw);
    let body = raw;
    let outputTruncated = false;
    if (rawBuffer.length > remaining) {
      const candidate = rawBuffer.subarray(0, remaining).toString("utf8");
      const boundary = candidate.lastIndexOf("\n");
      body = boundary > 0 ? candidate.slice(0, boundary) : `${candidate} [range fragment]`;
      outputTruncated = true;
    }
    sections.push({ ...range, body, outputTruncated });
    remaining -= Buffer.byteLength(body);
  }
  return { sections, totalLines: lines.length, decodedBytes, bytesShown: budget - remaining };
}

export function rangeCoveredByRegions(range, regions) {
  const low = Math.min(range.start_line, range.end_line);
  const high = Math.max(range.start_line, range.end_line);
  return regions.some((region) => low >= region.startLine && high <= region.endLine);
}

function collectCandidatePaths(root, maxEntries = MAX_PATH_SCAN_ENTRIES) {
  const paths = [];
  function visit(dirPath, depth) {
    if (depth > 4 || paths.length >= maxEntries) return;
    let entries;
    try { entries = readdirSync(dirPath, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if ([".git", "node_modules", "target", "dist", "build", ".cache"].includes(entry.name)) continue;
      const absPath = join(dirPath, entry.name);
      if (entry.isDirectory()) visit(absPath, depth + 1);
      else if (entry.isFile()) paths.push(absPath);
      if (paths.length >= maxEntries) break;
    }
  }
  visit(root, 0);
  return paths;
}

export function findMissingPathCandidates(missingPath, root) {
  const wanted = basenameParts(missingPath);
  const candidates = [];
  for (const candidate of collectCandidatePaths(root)) {
    const current = basenameParts(candidate);
    let reason = null;
    let score = 999;
    if (current.name.toLowerCase() === wanted.name.toLowerCase()) {
      reason = "same basename";
      score = 0;
    } else if (current.stem.toLowerCase() === wanted.stem.toLowerCase()) {
      reason = "same filename stem";
      score = 1;
    } else {
      const distance = boundedLevenshtein(current.stem.toLowerCase(), wanted.stem.toLowerCase());
      if (distance <= Math.max(2, Math.floor(wanted.stem.length * 0.25))) {
        reason = `similar filename stem (distance ${distance})`;
        score = 2 + distance;
      }
    }
    if (reason) candidates.push({ path: normalizeSlashes(relative(root, candidate)), reason, score });
  }
  return candidates.sort((a, b) => a.score - b.score || a.path.localeCompare(b.path)).slice(0, MAX_PATH_CANDIDATES);
}

function writeTempFile(targetPath, content, mode) {
  mkdirSync(dirname(targetPath), { recursive: true });
  const tempPath = join(dirname(targetPath), `.${basename(targetPath)}.oc-edit-${process.pid}-${Date.now()}-${atomicWriteCounter += 1}.tmp`);
  let descriptor;
  try {
    descriptor = openSync(tempPath, "wx", mode || 0o600);
    writeFileSync(descriptor, content, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(tempPath, mode || 0o600);
    return tempPath;
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch {}
    }
    try { unlinkSync(tempPath); } catch {}
    throw error;
  }
}

export function atomicReplaceText(targetPath, content, mode) {
  const tempPath = writeTempFile(targetPath, content, mode);
  try {
    renameSync(tempPath, targetPath);
  } catch (error) {
    try { unlinkSync(tempPath); } catch {}
    throw error;
  }
}

export function atomicCreateText(targetPath, content, mode = 0o600) {
  const tempPath = writeTempFile(targetPath, content, mode);
  try {
    linkSync(tempPath, targetPath);
    unlinkSync(tempPath);
  } catch (error) {
    try { unlinkSync(tempPath); } catch {}
    throw error;
  }
}

export function applyAtomicWithRetries(operation, verify, { attempts = 3 } = {}) {
  const recovery = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const verification = verify();
    if (!verification.ok) return { applied: false, ...verification, recovery };
    try {
      operation();
      return { applied: true, recovery };
    } catch (error) {
      if (!isTransientError(error) || attempt === attempts) return { applied: false, reason: `atomic write failed: ${error.message}`, recovery };
      const delay = [20, 60, 140][attempt - 1];
      recovery.push(`transient ${error.code} during atomic write attempt ${attempt}; retried after ${delay} ms`);
      sleepSync(delay);
    }
  }
  return { applied: false, reason: "atomic write attempts exhausted", recovery };
}

export function describeSnapshot(snapshot) {
  if (snapshot.error) return snapshot.error;
  if (snapshot.binary) return `binary or unsupported encoding (${snapshot.encoding})`;
  return `${formatSize(snapshot.size)}, ${snapshot.encoding}, sha256 ${snapshot.fingerprint}, stable=${snapshot.stable}`;
}

export function existingText(path) {
  if (!pathExists(path)) return null;
  return readTextStable(path);
}
