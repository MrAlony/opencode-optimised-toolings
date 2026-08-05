import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

const WINDOWS_REPLACE_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function retrySync(operation, attempts = 6) {
  let last;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { return operation(); }
    catch (error) {
      last = error;
      if (!WINDOWS_REPLACE_CODES.has(error?.code) || attempt === attempts - 1) throw error;
      sleepSync(20 * (attempt + 1));
    }
  }
  throw last;
}

export function readJson(path, fallback = undefined) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { if (fallback !== undefined && error?.code === "ENOENT") return fallback; throw new Error(`Could not parse ${path}: ${error.message}`); }
}

export function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const nonce = `${process.pid}.${randomBytes(4).toString("hex")}`;
  const temporary = `${path}.${nonce}.tmp`;
  const displaced = `${path}.${nonce}.old`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  let movedExisting = false;
  try {
    if (existsSync(path)) {
      retrySync(() => renameSync(path, displaced));
      movedExisting = true;
    }
    retrySync(() => renameSync(temporary, path));
    if (movedExisting) rmSync(displaced, { force: true });
  } catch (error) {
    rmSync(temporary, { force: true });
    if (movedExisting && !existsSync(path) && existsSync(displaced)) {
      try { retrySync(() => renameSync(displaced, path)); }
      catch (rollbackError) {
        throw new AggregateError([error, rollbackError], `Could not replace ${path} and could not restore the previous file`);
      }
    }
    throw error;
  } finally {
    if (existsSync(displaced) && existsSync(path)) rmSync(displaced, { force: true });
  }
}
