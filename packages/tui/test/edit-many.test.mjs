import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeEditMany } from "../../filesystem/lib/edit-engine.js";
import { parseEditResult } from "../lib/edit-many.js";

test("parseEditResult handles a real created file report", () => {
  const dir = mkdtempSync(join(tmpdir(), "tui-edit-"));
  try {
    const report = executeEditMany({ actions: [{ path: "new.txt", operation: "create", content: "hello\n" }] }, { directory: dir });
    const parsed = parseEditResult(report);
    assert.equal(parsed.status, "SUCCESS");
    assert.equal(parsed.applied.length, 1);
    assert.equal(parsed.applied[0].kind, "created");
    assert.equal(parsed.applied[0].actions, 1);
    assert.equal(parsed.applied[0].sha256.length, 64);
    assert.equal(parsed.technicalSummary.Applied, "1");
    assert.equal(parsed.technicalSummary["Requested actions"], "1");
    assert.ok(parsed.safetyModel.includes("written at most once"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseEditResult splits applied and rejected transactions", () => {
  const dir = mkdtempSync(join(tmpdir(), "tui-edit-2-"));
  try {
    writeFileSync(join(dir, "a.txt"), "one two\n", "utf8");
    writeFileSync(join(dir, "b.txt"), "present\n", "utf8");
    const report = executeEditMany(
      {
        actions: [
          { path: "a.txt", operation: "patch", replacements: [{ search: "two", replace: "TWO" }] },
          { path: "b.txt", operation: "patch", replacements: [{ search: "missing", replace: "x" }] },
        ],
      },
      { directory: dir }
    );
    const parsed = parseEditResult(report);
    assert.equal(parsed.status, "PARTIAL SUCCESS");
    assert.equal(parsed.applied.length, 1);
    assert.equal(parsed.applied[0].kind, "updated");
    assert.equal(parsed.applied[0].path.endsWith("a.txt"), true);
    assert.equal(parsed.rejected.length, 1);
    assert.match(parsed.rejected[0].failedStep, /Action 2, patch replacement 1/);
    assert.equal(parsed.rejected[0].path.endsWith("b.txt"), true);
    assert.match(parsed.outcome, /1 file transaction\(s\) completed safely; 1 failed independently/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseEditResult captures unchanged no-op transactions", () => {
  const dir = mkdtempSync(join(tmpdir(), "tui-edit-3-"));
  try {
    writeFileSync(join(dir, "a.txt"), "same\n", "utf8");
    const report = executeEditMany({ actions: [{ path: "a.txt", operation: "patch", replacements: [{ search: "same", replace: "same" }] }] }, { directory: dir });
    const parsed = parseEditResult(report);
    assert.equal(parsed.status, "SUCCESS");
    assert.equal(parsed.unchanged.length, 1);
    assert.equal(parsed.unchanged[0].kind, "already-satisfied");
    assert.ok(parsed.unchanged[0].noOps.length >= 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseEditResult keeps every file block in a multi-file section", () => {
  const parsed = parseEditResult(`EDIT RESULT: SUCCESS\n\nWHAT HAPPENED: 3 file transaction(s) completed safely.\n\nAPPLIED (3):\nFILE UPDATED: C:/repo/a.js\n  Actions evaluated: 1\n  Final text size: 1 KB\n  Final SHA-256: aaaa\n\nFILE CREATED: C:/repo/b.js\n  Actions evaluated: 1\n  Final text size: 2 KB\n  Final SHA-256: bbbb\n\nFILE UPDATED: C:/repo/c.js\n  Actions evaluated: 2\n  Final text size: 3 KB\n  Final SHA-256: cccc\n\nUNCHANGED (0):\n- none\n\nREJECTED (0):\n- none\n\nREAD/WRITE RECOVERY (0):\n- none required`)
  assert.equal(parsed.applied.length, 3)
  assert.deepEqual(parsed.applied.map((item) => item.path), ["C:/repo/a.js", "C:/repo/b.js", "C:/repo/c.js"])
  assert.deepEqual(parsed.consistency, [])
})

test("parseEditResult tolerates empty sections and non-reports", () => {
  const fixture = [
    "EDIT RESULT: SUCCESS",
    "WHAT HAPPENED: All 0 file transaction(s) completed safely.",
    "APPLIED (0):\n- none",
    "UNCHANGED (0):\n- none",
    "REJECTED (0):\n- none",
    "READ/WRITE RECOVERY (0):\n- none required",
    "TECHNICAL SUMMARY:\n  Requested actions: 0\n  Canonical file transactions: 0\n  Applied: 0\n  Already satisfied: 0\n  Rejected: 0",
    "SAFETY MODEL: actions for one canonical file are evaluated as one transaction and written at most once. A rejected file stays unchanged; independent valid files may still complete.",
  ].join("\n\n");
  const parsed = parseEditResult(fixture);
  assert.equal(parsed.status, "SUCCESS");
  assert.equal(parsed.applied.length, 0);
  assert.equal(parsed.unchanged.length, 0);
  assert.equal(parsed.rejected.length, 0);
  assert.equal(parseEditResult("nope"), null);
  assert.equal(parseEditResult(undefined), null);
});
