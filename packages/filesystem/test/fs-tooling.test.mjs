import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FsToolingPlugin } from "../index.js";
import { MAX_TOTAL_READ_BYTES, waterfillBudgets } from "../lib/common.js";
import { atomicReplaceText, readTextStable } from "../lib/text-io.js";

let sessionCounter = 0;

function context(directory, sessionID = `test-session-${sessionCounter += 1}`) {
  return { directory, sessionID };
}

async function withFixture(run) {
  const directory = await mkdtemp(join(tmpdir(), "oc-fs-tooling-"));
  try {
    await mkdir(join(directory, "src"));
    await mkdir(join(directory, "test"));
    await writeFile(join(directory, "AGENTS.md"), "# Instructions\nBatch related work.\n", "utf8");
    await writeFile(join(directory, "README.md"), "# Fixture\nRepository overview.\n", "utf8");
    await writeFile(join(directory, "package.json"), JSON.stringify({ name: "fixture", main: "src/index.js" }), "utf8");
    await writeFile(join(directory, "src", "index.js"), "export const answer = 42;\n", "utf8");
    await writeFile(join(directory, "test", "index.test.js"), "// answer test\n", "utf8");
    await writeFile(join(directory, "one.txt"), "one\nshared\n", "utf8");
    await writeFile(join(directory, "two.txt"), "two\nshared\n", "utf8");
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function getTools(directory, options = {}) {
  const plugin = await FsToolingPlugin({ directory, ...options });
  return plugin.tool;
}

test("tool surface exposes the merged edit tool", async () => {
  await withFixture(async (directory) => {
    const tools = await getTools(directory);
    assert.deepEqual(Object.keys(tools).sort(), ["fs_edit_many", "fs_explore", "fs_read_many", "fs_search"]);
    assert.equal(tools.fs_write_many, undefined);
    assert.equal(tools.fs_patch_many, undefined);
  });
});

test("filesystem usage advisories preserve established read, repeated-tool, and CBM safeguards", async () => {
  await withFixture(async (directory) => {
    const tools = await getTools(directory);
    const readSession = context(directory, "usage-read-session");
    const read1 = await tools.fs_read_many.execute({ paths: ["one.txt"], base_dir: directory }, readSession);
    const read2 = await tools.fs_read_many.execute({ paths: ["two.txt"], base_dir: directory }, readSession);
    const read3 = await tools.fs_read_many.execute({ paths: ["README.md"], base_dir: directory }, readSession);
    assert.match(read1, /\[READ BATCH SIGNAL\] Only one unique file was requested\. Related source, tests, configuration, and callers can often fit in the same read\./);
    assert.match(read2, /\[READ BATCH SIGNAL\] This is another one-file read in the session; a broader related-file batch may provide more complete edit context\./);
    assert.match(read2, /\[NOTICE REPEATED-TOOL ADVICE\] Consecutive fs_read_many call #2\. If more paths are already known, combine them now instead of continuing serial reads\./);
    assert.match(read3, /\[READ BATCH SIGNAL\] This is one-file read #3 in the session; repeated narrow reads may indicate that related context is being discovered serially\./);
    assert.match(read3, /\[STRONG REPEATED-TOOL ADVICE\] Consecutive fs_read_many call #3\. If more paths are already known, combine them now instead of continuing serial reads\./);
    assert.doesNotMatch(read3, /TOOL USAGE (?:SIGNAL|WARNING)|CRITICAL READ BATCH WARNING/);

    const discoverySession = context(directory, "usage-discovery-session");
    await tools.fs_search.execute({ query: "answer", file_pattern: "**\/*.js", base_dir: directory }, discoverySession);
    const discovery2 = await tools.fs_explore.execute({ base_dir: directory }, discoverySession);
    const discovery3 = await tools.fs_search.execute({ query: "shared", file_pattern: "**\/*.txt", base_dir: directory }, discoverySession);
    assert.match(discovery2, /\[CBM ESCALATION WARNING\] Filesystem discovery call #2 detected\. Use cbm_project\(action="list"\) before another broad filesystem discovery call\./);
    assert.match(discovery3, /\[CRITICAL CBM ESCALATION\] Filesystem discovery call #3 detected\. Stop broad explore\/search loops\./);
    assert.match(discovery3, /Continue the full task—change the information source, not the scope\./);
  });
});

test("repeated-tool advisories retain exact tool-specific guidance and NOTICE-to-STRONG thresholds", async () => {
  await withFixture(async (directory) => {
    const tools = await getTools(directory);
    const editSession = context(directory, "usage-edit-session");
    await tools.fs_edit_many.execute({ actions: [{ path: "one.txt", operation: "patch", replacements: [{ search: "one", replace: "ONE" }] }], base_dir: directory }, editSession);
    const edit2 = await tools.fs_edit_many.execute({ actions: [{ path: "two.txt", operation: "patch", replacements: [{ search: "two", replace: "TWO" }] }], base_dir: directory }, editSession);
    const edit3 = await tools.fs_edit_many.execute({ actions: [{ path: "one.txt", operation: "patch", replacements: [{ search: "ONE", replace: "one" }] }], base_dir: directory }, editSession);
    assert.match(edit2, /\[NOTICE REPEATED-TOOL ADVICE\] Consecutive fs_edit_many call #2\. Combine independent files and repeated same-file actions into one ordered edit call when they are already known\./);
    assert.match(edit3, /\[STRONG REPEATED-TOOL ADVICE\] Consecutive fs_edit_many call #3\./);
  });
});

test("fs_edit_many action schema accepts valid chains and rejects malformed operation fields", async () => {
  await withFixture(async (directory) => {
    const tools = await getTools(directory);
    const schema = tools.fs_edit_many.args.actions;
    assert.equal(schema.safeParse([
      { path: "new.txt", operation: "create", content: "alpha" },
      { path: "new.txt", operation: "patch", replacements: [{ search: "alpha", replace: "ALPHA", expected_count: 1 }] },
    ]).success, true);
    assert.equal(schema.safeParse([{ path: "bad.txt", operation: "create" }]).success, false);
    assert.equal(schema.safeParse([{ path: "bad.txt", operation: "patch", content: "not replacements" }]).success, false);
    assert.equal(schema.safeParse([{ path: "bad.txt", operation: "overwrite", replacements: [{ search: "a", replace: "b" }] }]).success, false);
  });
});

test("fs_edit_many creates then patches the same new file in one atomic chain", async () => {
  await withFixture(async (directory) => {
    const tools = await getTools(directory);
    const output = await tools.fs_edit_many.execute({
      base_dir: directory,
      actions: [
        { path: "new.txt", operation: "create", content: "alpha\nshared\n" },
        { path: ".\\new.txt", operation: "patch", replacements: [
          { search: "alpha", replace: "ALPHA", expected_count: 1 },
          { search: "shared", replace: "verified", expected_count: 1 },
        ] },
      ],
    }, context(directory));
    assert.match(output, /EDIT RESULT: SUCCESS/);
    assert.match(output, /Canonical file transactions: 1/);
    assert.match(output, /Actions evaluated: 2/);
    assert.equal(await readFile(join(directory, "new.txt"), "utf8"), "ALPHA\nverified\n");
  });
});

test("fs_edit_many supports overwrite then patch on an existing file", async () => {
  await withFixture(async (directory) => {
    const tools = await getTools(directory);
    const output = await tools.fs_edit_many.execute({
      base_dir: directory,
      actions: [
        { path: "one.txt", operation: "overwrite", content: "fresh\nblock\n" },
        { path: "one.txt", operation: "patch", replacements: [{ search: "block", replace: "BLOCK", expected_count: 1 }] },
      ],
    }, context(directory));
    assert.match(output, /FILE UPDATED: one\.txt/);
    assert.match(output, /Actions evaluated: 2/);
    assert.equal(await readFile(join(directory, "one.txt"), "utf8"), "fresh\nBLOCK\n");
  });
});

test("fs_edit_many rolls back a failed same-file transaction and applies independent files", async () => {
  await withFixture(async (directory) => {
    const tools = await getTools(directory);
    const output = await tools.fs_edit_many.execute({
      base_dir: directory,
      actions: [
        { path: "one.txt", operation: "patch", replacements: [{ search: "one", replace: "ONE", expected_count: 1 }] },
        { path: "one.txt", operation: "patch", replacements: [{ search: "missing", replace: "bad", expected_count: 1 }] },
        { path: "two.txt", operation: "patch", replacements: [{ search: "two", replace: "TWO", expected_count: 1 }] },
      ],
    }, context(directory));
    assert.match(output, /EDIT RESULT: PARTIAL SUCCESS/);
    assert.match(output, /FILE NOT CHANGED: one\.txt/);
    assert.match(output, /Failed step: Action 2, patch replacement 1/);
    assert.match(output, /Expected: The search text must appear exactly 1 time\(s\)\./);
    assert.match(output, /Observed: The search text appeared 0 time\(s\)\./);
    assert.match(output, /Safety outcome: no part of this file transaction was written/);
    assert.match(output, /Diagnostic evidence \(informational only\)/);
    assert.match(output, /No approximate or fuzzy replacement was attempted/);
    assert.equal(await readFile(join(directory, "one.txt"), "utf8"), "one\nshared\n");
    assert.equal(await readFile(join(directory, "two.txt"), "utf8"), "TWO\nshared\n");
  });
});

test("fs_edit_many rejects create-on-existing and overwrite-on-missing without wasting independent work", async () => {
  await withFixture(async (directory) => {
    const tools = await getTools(directory);
    const output = await tools.fs_edit_many.execute({
      base_dir: directory,
      actions: [
        { path: "one.txt", operation: "create", content: "wrong" },
        { path: "missing.txt", operation: "overwrite", content: "wrong" },
        { path: "two.txt", operation: "patch", replacements: [{ search: "two", replace: "TWO", expected_count: 1 }] },
      ],
    }, context(directory));
    assert.match(output, /create requires a missing file/);
    assert.match(output, /overwrite requires an existing staged file/);
    assert.equal(await readFile(join(directory, "one.txt"), "utf8"), "one\nshared\n");
    assert.equal(await readFile(join(directory, "two.txt"), "utf8"), "TWO\nshared\n");
  });
});

test("fs_edit_many uses optional fingerprints as information-backed concurrency assertions", async () => {
  await withFixture(async (directory) => {
    const tools = await getTools(directory);
    const output = await tools.fs_edit_many.execute({
      base_dir: directory,
      actions: [{
        path: "one.txt",
        operation: "patch",
        expected_sha256: "deadbeef",
        replacements: [{ search: "one", replace: "ONE", expected_count: 1 }],
      }],
    }, context(directory));
    assert.match(output, /Expected: The staged file fingerprint must be deadbeef\./);
    assert.equal(await readFile(join(directory, "one.txt"), "utf8"), "one\nshared\n");
  });
});

test("fs_edit_many rejects a conflicting exact patch rebase and preserves concurrent content", async () => {
  await withFixture(async (directory) => {
    const target = join(directory, "one.txt");
    const tools = await getTools(directory, {
      beforeEditApply(group) {
        if (group.targetPath === target) writeFileSync(target, "concurrent user edit\n", "utf8");
      },
    });
    const output = await tools.fs_edit_many.execute({
      base_dir: directory,
      actions: [
        { path: "one.txt", operation: "patch", replacements: [{ search: "one", replace: "ONE", expected_count: 1 }] },
        { path: "two.txt", operation: "patch", replacements: [{ search: "two", replace: "TWO", expected_count: 1 }] },
      ],
    }, context(directory));
    assert.match(output, /exact patch rebase failed/);
    assert.match(output, /Diagnostic evidence \(informational only\)/);
    assert.match(output, /No approximate or fuzzy replacement was attempted/);
    assert.equal(await readFile(target, "utf8"), "concurrent user edit\n");
    assert.equal(await readFile(join(directory, "two.txt"), "utf8"), "TWO\nshared\n");
  });
});

test("fs_edit_many safely rebases a patch-only transaction over an unrelated concurrent edit", async () => {
  await withFixture(async (directory) => {
    const target = join(directory, "one.txt");
    const tools = await getTools(directory, {
      beforeEditApply(group) {
        if (group.targetPath === target) writeFileSync(target, "concurrent heading\none\nshared\n", "utf8");
      },
    });
    const output = await tools.fs_edit_many.execute({
      base_dir: directory,
      actions: [{ path: "one.txt", operation: "patch", replacements: [{ search: "one", replace: "ONE", expected_count: 1 }] }],
    }, context(directory));
    assert.match(output, /EDIT RESULT: SUCCESS/);
    assert.match(output, /patch-only transaction rebased against newer exact content/);
    assert.equal(await readFile(target, "utf8"), "concurrent heading\nONE\nshared\n");
  });
});

test("fs_edit_many rejects a raced create with different content and preserves the appeared file", async () => {
  await withFixture(async (directory) => {
    const target = join(directory, "new.txt");
    const tools = await getTools(directory, {
      beforeEditApply(group) {
        if (group.targetPath === target) writeFileSync(target, "other creator\n", "utf8");
      },
    });
    const output = await tools.fs_edit_many.execute({
      base_dir: directory,
      actions: [{ path: "new.txt", operation: "create", content: "ours\n" }],
    }, context(directory));
    assert.match(output, /file appeared after validation with different or unreadable content/);
    assert.equal(await readFile(target, "utf8"), "other creator\n");
  });
});

test("fs_edit_many classifies an identical raced create as unchanged", async () => {
  await withFixture(async (directory) => {
    const target = join(directory, "new.txt");
    const tools = await getTools(directory, {
      beforeEditApply(group) {
        if (group.targetPath === target) writeFileSync(target, "ours\n", "utf8");
      },
    });
    const output = await tools.fs_edit_many.execute({
      base_dir: directory,
      actions: [{ path: "new.txt", operation: "create", content: "ours\n" }],
    }, context(directory));
    assert.match(output, /EDIT RESULT: SUCCESS/);
    assert.match(output, /UNCHANGED \(1\)/);
    assert.match(output, /target appeared concurrently with identical final content/);
    assert.equal(await readFile(target, "utf8"), "ours\n");
  });
});

test("fs_edit_many recognizes exact no-op assertions and explicit already-applied replacements", async () => {
  await withFixture(async (directory) => {
    await writeFile(join(directory, "one.txt"), "status=new\n", "utf8");
    const tools = await getTools(directory);
    const output = await tools.fs_edit_many.execute({
      base_dir: directory,
      actions: [{ path: "one.txt", operation: "patch", replacements: [
        { search: "status=new", replace: "status=new", expected_count: 1 },
        { search: "status=old", replace: "status=new", expected_count: 1, allow_already_applied: true },
      ] }],
    }, context(directory));
    assert.match(output, /EDIT RESULT: SUCCESS/);
    assert.match(output, /UNCHANGED \(1\)/);
    assert.match(output, /exact no-op assertion/);
    assert.match(output, /already present exactly 1 time/);
  });
});

test("fs_edit_many retries a transient atomic write failure with bounded recovery", async () => {
  await withFixture(async (directory) => {
    let attempts = 0;
    const tools = await getTools(directory, {
      replaceWriter(path, content, mode) {
        attempts += 1;
        if (attempts === 1) throw Object.assign(new Error("temporary sharing violation"), { code: "EBUSY" });
        atomicReplaceText(path, content, mode);
      },
    });
    const output = await tools.fs_edit_many.execute({
      base_dir: directory,
      actions: [{ path: "one.txt", operation: "patch", replacements: [{ search: "one", replace: "ONE", expected_count: 1 }] }],
    }, context(directory));
    assert.equal(attempts, 2);
    assert.match(output, /transient EBUSY during atomic write attempt 1/);
    assert.equal(await readFile(join(directory, "one.txt"), "utf8"), "ONE\nshared\n");
  });
});

test("fs_edit_many preserves permissions when replacing an existing file", async () => {
  await withFixture(async (directory) => {
    const target = join(directory, "one.txt");
    const before = (await stat(target)).mode & 0o777;
    const tools = await getTools(directory);
    await tools.fs_edit_many.execute({
      base_dir: directory,
      actions: [{ path: "one.txt", operation: "patch", replacements: [{ search: "one", replace: "ONE", expected_count: 1 }] }],
    }, context(directory));
    assert.equal((await stat(target)).mode & 0o777, before);
  });
});

test("fs_read_many consolidates duplicate complete reads and lets complete reads supersede ranges", async () => {
  await withFixture(async (directory) => {
    const tools = await getTools(directory);
    const output = await tools.fs_read_many.execute({
      base_dir: directory,
      paths: ["one.txt", ".\\one.txt"],
      requests: [{ path: "one.txt", ranges: [{ start_line: 1, end_line: 1 }] }],
    }, context(directory));
    assert.equal(output.match(/one\.txt \(3 total lines/g)?.length, 1);
    assert.match(output, /duplicates complete read/);
    assert.match(output, /ranged request\(s\) already covered by returned complete-read region/);
    assert.match(output, /READ RESULT: SUCCESS/);
  });
});

test("fs_read_many accepts distinct partial ranges and consolidates identical normalized ranges", async () => {
  await withFixture(async (directory) => {
    await writeFile(join(directory, "ranges.txt"), Array.from({ length: 20 }, (_, index) => `line-${index + 1}`).join("\n"), "utf8");
    const tools = await getTools(directory);
    const output = await tools.fs_read_many.execute({
      base_dir: directory,
      requests: [
        { path: "ranges.txt", ranges: [{ start_line: 3, end_line: 5 }, { start_line: 5, end_line: 3 }] },
        { path: ".\\ranges.txt", ranges: [{ start_line: 15, end_line: 17 }] },
      ],
    }, context(directory));
    assert.match(output, /lines 3-5 of 20/);
    assert.match(output, /lines 15-17 of 20/);
    assert.match(output, /duplicate range 5-3 consolidated/);
  });
});

test("fs_read_many normalizes reversed ranges and shifts overflowing windows to the nearest edge", async () => {
  await withFixture(async (directory) => {
    await writeFile(join(directory, "ranges.txt"), Array.from({ length: 30 }, (_, index) => `line-${index + 1}`).join("\n"), "utf8");
    const tools = await getTools(directory);
    const output = await tools.fs_read_many.execute({
      base_dir: directory,
      requests: [{ path: "ranges.txt", ranges: [
        { start_line: 10, end_line: 1 },
        { start_line: 40, end_line: 49 },
      ] }],
    }, context(directory));
    assert.match(output, /lines 1-10 of 30 \(requested 10-1\)/);
    assert.match(output, /range normalized from 10-1/);
    assert.match(output, /lines 21-30 of 30 \(requested 40-49\)/);
    assert.match(output, /window shifted to available edge/);
  });
});

test("fs_read_many returns partial success summary for mixed readable and unavailable files", async () => {
  await withFixture(async (directory) => {
    const tools = await getTools(directory);
    const output = await tools.fs_read_many.execute({ paths: ["one.txt", "missing.txt"], base_dir: directory }, context(directory));
    assert.match(output, /READ RESULT: PARTIAL SUCCESS/);
    assert.match(output, /UNAVAILABLE TARGETS \(1\):/);
    assert.match(output, /missing\.txt/);
    assert.match(output, /Complete files: 1/);
  });
});

test("readTextStable retries transient read failures and reports recovery", () => {
  let fileAttempts = 0;
  const stableStat = { size: 5, mtimeMs: 10, isFile: () => true };
  const snapshot = readTextStable("virtual.txt", {
    attempts: 2,
    statReader: () => stableStat,
    fileReader: () => {
      fileAttempts += 1;
      if (fileAttempts === 1) throw Object.assign(new Error("temporarily busy"), { code: "EBUSY" });
      return Buffer.from("ready");
    },
    sleep: () => {},
  });
  assert.equal(snapshot.content, "ready");
  assert.equal(snapshot.stable, true);
  assert.equal(fileAttempts, 2);
  assert.ok(snapshot.recoveries.some((item) => item.includes("transient EBUSY")));
});

test("readTextStable returns latest evidence and first/latest fingerprints when bounded attempts never stabilize", () => {
  const contents = [Buffer.from("first"), Buffer.from("latest")];
  let statCall = 0;
  let readCall = 0;
  const snapshot = readTextStable("virtual.txt", {
    attempts: 2,
    statReader: () => {
      statCall += 1;
      const attempt = Math.ceil(statCall / 2);
      const before = statCall % 2 === 1;
      return { size: attempt === 1 ? 5 : 6, mtimeMs: attempt * 10 + (before ? 0 : 1), isFile: () => true };
    },
    fileReader: () => contents[readCall++],
    sleep: () => {},
  });
  assert.equal(snapshot.content, "latest");
  assert.equal(snapshot.stable, false);
  assert.equal(snapshot.attempts, 2);
  assert.equal(snapshot.snapshots.length, 2);
  assert.notEqual(snapshot.snapshots[0].fingerprint, snapshot.snapshots[1].fingerprint);
  assert.ok(snapshot.recoveries.some((item) => item.includes("metadata changed during read attempt 2")));
});

test("adaptive waterfill distributes every demanded budget byte without exceeding item needs", () => {
  const equal = waterfillBudgets([
    { key: "a", need: 100 },
    { key: "b", need: 100 },
    { key: "c", need: 100 },
  ], 10);
  assert.deepEqual([...equal.values()], [4, 3, 3]);
  assert.equal([...equal.values()].reduce((sum, value) => sum + value, 0), 10);

  const mixed = waterfillBudgets([
    { key: "small", need: 2 },
    { key: "large", need: 100 },
  ], 10);
  assert.equal(mixed.get("small"), 2);
  assert.equal(mixed.get("large"), 8);
});

test("fs_read_many adaptively returns a single file larger than the former per-file cap without truncation", async () => {
  await withFixture(async (directory) => {
    const content = Array.from({ length: 3000 }, (_, index) => `adaptive-${index + 1}-${"x".repeat(10)}`).join("\n");
    assert.ok(Buffer.byteLength(content) > 48 * 1024);
    assert.ok(Buffer.byteLength(content) < 150 * 1024);
    await writeFile(join(directory, "adaptive.txt"), content, "utf8");
    const tools = await getTools(directory);
    const output = await tools.fs_read_many.execute({ paths: ["adaptive.txt"], base_dir: directory }, context(directory));
    assert.match(output, /READ RESULT: SUCCESS/);
    assert.match(output, /adaptive-3000/);
    assert.match(output, /BOUNDED OR OMITTED EVIDENCE \(0\)/);
    assert.match(output, /Allocation: adaptive across all requested evidence/);
  });
});

test("fs_read_many satisfies small files first and redistributes the remaining shared budget to larger files", async () => {
  await withFixture(async (directory) => {
    const small = Array.from({ length: 100 }, (_, index) => `small-${index + 1}`).join("\n");
    const large = Array.from({ length: 5000 }, (_, index) => `redistributed-${index + 1}-${"r".repeat(8)}`).join("\n");
    await writeFile(join(directory, "small-budget.txt"), small, "utf8");
    await writeFile(join(directory, "large-budget.txt"), large, "utf8");
    const tools = await getTools(directory);
    const output = await tools.fs_read_many.execute({ paths: ["small-budget.txt", "large-budget.txt"], base_dir: directory }, context(directory));
    assert.match(output, /READ RESULT: SUCCESS/);
    assert.match(output, /100: small-100/);
    assert.match(output, /5000: redistributed-5000/);
    assert.match(output, new RegExp(`Shared total: ${MAX_TOTAL_READ_BYTES} bytes`));
    assert.match(output, /BOUNDED OR OMITTED EVIDENCE \(0\)/);
  });
});

test("fs_read_many returns separated head and tail evidence with exact omitted bounds", async () => {
  await withFixture(async (directory) => {
    const content = Array.from({ length: 12000 }, (_, index) => `large-${index + 1}-${"y".repeat(20)}`).join("\n");
    await writeFile(join(directory, "large.txt"), content, "utf8");
    const tools = await getTools(directory);
    const output = await tools.fs_read_many.execute({ paths: ["large.txt"], base_dir: directory }, context(directory));
    assert.match(output, /READ RESULT: PARTIAL SUCCESS/);
    assert.match(output, /1: large-1/);
    assert.match(output, /12000: large-12000/);
    assert.match(output, /OMITTED REGION: lines \d+-\d+; decoded bytes \d+-\d+; \d+ decoded byte\(s\) not returned/);
    assert.match(output, /TRUNCATION BOUNDS: returned head lines/);
    assert.match(output, /BOUNDED OR OMITTED EVIDENCE \(1\)/);
    assert.match(output, /Complete files: 0/);
    assert.match(output, /Partial files\/ranges: 1/);
  });
});

test("fs_read_many retains explicit ranges not covered by truncated complete evidence", async () => {
  await withFixture(async (directory) => {
    const content = Array.from({ length: 12000 }, (_, index) => `retain-${index + 1}-${"z".repeat(20)}`).join("\n");
    await writeFile(join(directory, "large.txt"), content, "utf8");
    const tools = await getTools(directory);
    const output = await tools.fs_read_many.execute({
      paths: ["large.txt"],
      requests: [{ path: "large.txt", ranges: [{ start_line: 6000, end_line: 6010 }] }],
      base_dir: directory,
    }, context(directory));
    assert.match(output, /uncovered requested ranges retained beside truncated complete evidence/);
    assert.match(output, /6000: retain-6000/);
    assert.match(output, /Reserved for uncovered explicit ranges: 24576 bytes/);
  });
});

test("fs_read_many decodes UTF-8 BOM and UTF-16 LE and BE text", async () => {
  await withFixture(async (directory) => {
    await writeFile(join(directory, "utf8bom.txt"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("hello utf8\n")]));
    await writeFile(join(directory, "utf16le.txt"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("hello le\n", "utf16le")]));
    const beSource = Buffer.from("hello be\n", "utf16le");
    const beBody = Buffer.alloc(beSource.length);
    for (let index = 0; index < beSource.length; index += 2) { beBody[index] = beSource[index + 1]; beBody[index + 1] = beSource[index]; }
    await writeFile(join(directory, "utf16be.txt"), Buffer.concat([Buffer.from([0xfe, 0xff]), beBody]));
    const tools = await getTools(directory);
    const output = await tools.fs_read_many.execute({ paths: ["utf8bom.txt", "utf16le.txt", "utf16be.txt"], base_dir: directory }, context(directory));
    assert.match(output, /hello utf8/);
    assert.match(output, /encoding=utf-8-bom/);
    assert.match(output, /hello le/);
    assert.match(output, /encoding=utf-16le/);
    assert.match(output, /hello be/);
    assert.match(output, /encoding=utf-16be/);
    assert.match(output, /READ RESULT: SUCCESS/);
  });
});

test("fs_read_many reports bounded missing-path candidates without substituting content", async () => {
  await withFixture(async (directory) => {
    await mkdir(join(directory, "config"));
    await writeFile(join(directory, "config", "user-config.ts"), "export const config = true;\n", "utf8");
    const tools = await getTools(directory);
    const output = await tools.fs_read_many.execute({ paths: ["user-config.ts"], base_dir: directory }, context(directory));
    assert.match(output, /READ RESULT: FAILED/);
    assert.match(output, /POSSIBLE PATHS FOR MISSING TARGETS \(1\)/);
    assert.match(output, /config\/user-config\.ts \(same basename\)/);
    assert.doesNotMatch(output, /export const config/);
  });
});

test("fs_read_many returns fingerprints and detects binary content", async () => {
  await withFixture(async (directory) => {
    await writeFile(join(directory, "binary.bin"), Buffer.from([0, 1, 2, 3, 255, 0]));
    const tools = await getTools(directory);
    const output = await tools.fs_read_many.execute({ paths: ["one.txt", "binary.bin"], base_dir: directory }, context(directory));
    assert.match(output, /sha256 [a-f0-9]{64}/);
    assert.match(output, /BINARY FILE/);
    assert.match(output, /READ RESULT: PARTIAL SUCCESS/);
  });
});

test("fs_search returns structured complete evidence and whole records", async () => {
  await withFixture(async (directory) => {
    const tools = await getTools(directory);
    const output = await tools.fs_search.execute({ query: "answer|shared", file_pattern: "**/*.{js,txt}", base_dir: directory }, context(directory));
    assert.match(output, /SEARCH RESULT: SUCCESS/);
    assert.match(output, /FILE DISCOVERY:/);
    assert.match(output, /CONTENT SCAN:/);
    assert.match(output, /Complete: yes/);
    assert.match(output, /EVIDENCE MEANING:/);
    assert.match(output, /src\\index\.js:1:export const answer/);
  });
});

test("fs_search distinguishes no matches from incomplete evidence", async () => {
  await withFixture(async (directory) => {
    const tools = await getTools(directory);
    const output = await tools.fs_search.execute({ query: "definitely-absent", file_pattern: "*.txt", base_dir: directory }, context(directory));
    assert.match(output, /SEARCH RESULT: SUCCESS/);
    assert.match(output, /No matches found/);
    assert.match(output, /Candidate enumeration and returned content evidence are complete/);
  });
});

test("fs_search preserves partial evidence and recovery signals from a self-healing fallback", async () => {
  await withFixture(async (directory) => {
    const tools = await getTools(directory, {
      searchFileEnumerator() {
        return {
          paths: ["one.txt", "two.txt"],
          complete: false,
          issues: ["ripgrep unavailable; native enumeration activated", "native enumeration reached its time budget"],
          source: "native fallback",
        };
      },
    });
    const output = await tools.fs_search.execute({ query: "shared", file_pattern: "*.txt", base_dir: directory }, context(directory));
    assert.match(output, /SEARCH RESULT: PARTIAL SUCCESS/);
    assert.match(output, /Method: native fallback/);
    assert.match(output, /shared/);
    assert.match(output, /Partial evidence was returned; absence is not established/);
    assert.match(output, /native enumeration activated/);
  });
});

test("fs_search reports invalid regex as failed evidence without throwing", async () => {
  await withFixture(async (directory) => {
    const tools = await getTools(directory);
    const output = await tools.fs_search.execute({ query: "[", file_pattern: "*.txt", base_dir: directory }, context(directory));
    assert.match(output, /SEARCH RESULT: FAILED/);
    assert.match(output, /invalid regular expression/);
    assert.match(output, /absence is not established/i);
  });
});

test("fs_explore adaptively shares its manifest budget without the former 48 KiB per-file ceiling", async () => {
  await withFixture(async (directory) => {
    const readme = Array.from({ length: 2400 }, (_, index) => `manifest-${index + 1}-${"m".repeat(8)}`).join("\n");
    assert.ok(Buffer.byteLength(readme) > 48 * 1024);
    assert.ok(Buffer.byteLength(readme) < 72 * 1024);
    await writeFile(join(directory, "README.md"), readme, "utf8");
    const tools = await getTools(directory);
    const output = await tools.fs_explore.execute({ base_dir: directory }, context(directory));
    assert.match(output, /EXPLORE RESULT: SUCCESS/);
    assert.match(output, /2400: manifest-2400/);
    assert.doesNotMatch(output, /MANIFEST TRUNCATED/);
  });
});

test("fs_explore reports component status and evidence-derived context candidates", async () => {
  await withFixture(async (directory) => {
    const tools = await getTools(directory);
    const output = await tools.fs_explore.execute({ base_dir: directory, query: "answer", file_pattern: "**/*.js" }, context(directory));
    assert.match(output, /EXPLORE RESULT: SUCCESS/);
    assert.match(output, /COMPONENT STATUS:/);
    assert.match(output, /Optional search: success/);
    assert.match(output, /CONTEXT CANDIDATES/);
    assert.match(output, /src\/index\.js: entry-point candidate, search candidate|src\/index\.js: search candidate, entry-point candidate/);
    assert.match(output, /test\/index\.test\.js: search candidate, test candidate|test\/index\.test\.js: test candidate, search candidate/);
    assert.match(output, /not asserted dependencies/);
    assert.match(output, /HOW TO INTERPRET CONTEXT CANDIDATES/);
  });
});
