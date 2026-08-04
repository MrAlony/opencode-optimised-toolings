import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export const MAX_TOTAL_READ_BYTES = 192 * 1024;
export const MAX_RANGE_REQUESTS = 20;
export const MAX_LINES_PER_RANGE = 800;
export const BINARY_SAMPLE_BYTES = 8192;
export const TRANSIENT_CODES = new Set(["EACCES", "EBUSY", "EMFILE", "ENFILE", "EPERM"]);

export function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

export function formatSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

export function normalizeSlashes(value) {
  return value.replaceAll("\\", "/");
}

export function canonicalPathInfo(base, inputPath) {
  const absPath = resolve(base, inputPath);
  let targetPath = absPath;
  try {
    targetPath = realpathSync.native(absPath);
  } catch {
    try {
      targetPath = join(realpathSync.native(dirname(absPath)), basename(absPath));
    } catch {}
  }
  const key = process.platform === "win32" ? targetPath.toLowerCase() : targetPath;
  return { absPath, targetPath, key };
}

export function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function isTransientError(error) {
  return Boolean(error && TRANSIENT_CODES.has(error.code));
}

export function retryTransient(operation, { attempts = 3, delays = [20, 60, 140] } = {}) {
  const recoveries = [];
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return { value: operation(attempt), recoveries };
    } catch (error) {
      lastError = error;
      if (!isTransientError(error) || attempt === attempts) throw Object.assign(error, { recoveryAttempts: recoveries });
      const delay = delays[Math.min(attempt - 1, delays.length - 1)];
      recoveries.push(`transient ${error.code} on attempt ${attempt}; retried after ${delay} ms`);
      sleepSync(delay);
    }
  }
  throw lastError;
}

export function looksBinary(buffer) {
  if (buffer.length === 0) return false;
  let suspicious = 0;
  for (const byte of buffer) {
    if (byte === 0) return true;
    if (byte < 7 || (byte > 13 && byte < 32)) suspicious += 1;
  }
  return suspicious / buffer.length > 0.08;
}

export function pathExists(path) {
  try { return existsSync(path); } catch { return false; }
}

export function waterfillBudgets(items, totalBudget) {
  const budgets = new Map();
  let remaining = Math.max(0, totalBudget);
  let pending = items.map((item) => ({ ...item, need: Math.max(0, item.need) }));
  while (pending.length) {
    const share = Math.floor(remaining / pending.length);
    const satisfied = pending.filter((item) => item.need <= share);
    if (!satisfied.length) {
      const remainder = remaining - share * pending.length;
      pending.forEach((item, index) => budgets.set(item.key, share + (index < remainder ? 1 : 0)));
      remaining = 0;
      break;
    }
    for (const item of satisfied) {
      budgets.set(item.key, item.need);
      remaining -= item.need;
    }
    const satisfiedKeys = new Set(satisfied.map((item) => item.key));
    pending = pending.filter((item) => !satisfiedKeys.has(item.key));
  }
  return budgets;
}

export function countOccurrences(content, search) {
  if (!search) return 0;
  let count = 0;
  let index = 0;
  while ((index = content.indexOf(search, index)) !== -1) {
    count += 1;
    index += search.length;
  }
  return count;
}

export function uniqueMessages(messages) {
  return [...new Set(messages.filter(Boolean))];
}

export function basenameParts(path) {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return { name, stem: dot > 0 ? name.slice(0, dot) : name, extension: dot > 0 ? name.slice(dot) : "" };
}

export function boundedLevenshtein(a, b, limit = 80) {
  const left = a.slice(0, limit);
  const right = b.slice(0, limit);
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1));
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length];
}
