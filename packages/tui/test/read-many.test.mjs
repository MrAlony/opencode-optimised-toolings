import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeReadMany } from "../../filesystem/lib/read-engine.js";
import { parseReadResult } from "../lib/read-many.js";

test("parseReadResult handles a real complete read report", () => {
  const dir = mkdtempSync(join(tmpdir(), "tui-read-"));
  try {
    writeFileSync(join(dir, "a.txt"), "alpha\nbeta\ngamma\n", "utf8");
    writeFileSync(join(dir, "b.txt"), "x".repeat(120), "utf8");
    const report = executeReadMany({ paths: ["a.txt", "b.txt"] }, { directory: dir });
    const parsed = parseReadResult(report);
    assert.equal(parsed.status, "SUCCESS");
    assert.equal(parsed.files.length, 2);
    assert.equal(parsed.files[0].kind, "complete");
    assert.equal(parsed.files[0].bounded, false);
    assert.match(parsed.files[0].path, /a\.txt$/);
    assert.equal(parsed.files[0].sha256.length, 64);
    assert.ok(parsed.budget["Shared total"].includes("bytes"));
    assert.equal(parsed.editContext["Complete files"], "2");
    assert.match(parsed.outcome, /returned completely and stably/);
    assert.equal(parsed.evidence.length, 2);
    assert.match(parsed.files[0].evidence.contentLines.join("\n"), /alpha/);
    assert.equal(parsed.files[0].evidence.stable, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseReadResult surfaces bounded evidence and omitted ranges", () => {
  const dir = mkdtempSync(join(tmpdir(), "tui-read-trunc-"));
  try {
    writeFileSync(join(dir, "big.txt"), `${"0123456789".repeat(40000)}\n`, "utf8");
    const report = executeReadMany({ paths: ["big.txt"] }, { directory: dir });
    const parsed = parseReadResult(report);
    assert.equal(parsed.status, "PARTIAL SUCCESS");
    assert.equal(parsed.files.length, 1);
    assert.equal(parsed.files[0].bounded, true);
    assert.ok(parsed.omitted.length >= 1);
    assert.ok(parsed.omitted[0].bytes > 0 || Boolean(parsed.omitted[0].note));
    assert.ok(parsed.files[0].evidence.contentLines.length > 0);
    assert.ok(parsed.files[0].evidence.signals.some((line) => /TRUNCATION BOUNDS|BOUNDARY SIGNAL/.test(line)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseReadResult parses ranged section evidence", () => {
  const dir = mkdtempSync(join(tmpdir(), "tui-read-rng-"));
  try {
    const lines = Array.from({ length: 500 }, (_, index) => `line ${index}`);
    writeFileSync(join(dir, "r.txt"), lines.join("\n"), "utf8");
    const report = executeReadMany({ requests: [{ path: "r.txt", ranges: [{ start_line: 5, end_line: 8 }] }] }, { directory: dir });
    const parsed = parseReadResult(report);
    assert.equal(parsed.status, "SUCCESS");
    assert.equal(parsed.files.length, 1);
    assert.equal(parsed.files[0].kind, "ranged");
    assert.equal(parsed.files[0].ranges, 1);
    assert.match(parsed.files[0].evidence.contentLines.join("\n"), /5: line 4/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseReadResult reports unavailable targets", () => {
  const dir = mkdtempSync(join(tmpdir(), "tui-read-miss-"));
  try {
    const report = executeReadMany({ paths: ["nope.txt"] }, { directory: dir });
    const parsed = parseReadResult(report);
    assert.equal(parsed.status, "FAILED");
    assert.equal(parsed.unavailable.length, 1);
    assert.ok(parsed.unavailable[0].reason.length > 0);
    assert.equal(parsed.files.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseReadResult handles the no-targets failure report", () => {
  const parsed = parseReadResult("READ RESULT: FAILED\nNo unique complete or ranged read targets remained after consolidation.");
  assert.equal(parsed.status, "FAILED");
  assert.equal(parsed.files.length, 0);
  assert.ok(parsed.notes.length >= 1);
});

test("parseReadResult returns null for non-report output", () => {
  assert.equal(parseReadResult("Error: something else entirely"), null);
  assert.equal(parseReadResult(undefined), null);
  assert.equal(parseReadResult(""), null);
});
