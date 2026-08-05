const SECTION_LABEL = /^([A-Z][A-Z /]+) \((\d+)\):/;

function parseReturnedBlocks(text, reportStart) {
  const prefix = text.slice(0, reportStart).trim();
  if (!prefix) return [];
  const header = /^(.+?) \(((?:\d+ total lines|requested ranges|uncovered requested ranges retained beside truncated complete evidence)[^\r\n]*encoding=[^,\r\n]+, sha256 ([0-9a-f]+), stable=(true|false))\):$/gm;
  const matches = [...prefix.matchAll(header)];
  return matches.map((match, index) => {
    const body = prefix.slice(match.index + match[0].length, matches[index + 1]?.index ?? prefix.length).replace(/^\r?\n/, "").trimEnd();
    const allLines = body.split(/\r?\n/);
    const signals = allLines.filter((line) => /^\[(?:TRUNCATION BOUNDS|BOUNDARY SIGNAL|READ RECOVERY|RANGE SIGNALS):/.test(line));
    const contentLines = allLines.filter((line) => !/^\[(?:TRUNCATION BOUNDS|BOUNDARY SIGNAL|READ RECOVERY|RANGE SIGNALS):/.test(line));
    const kind = /^\d+ total lines/.test(match[2]) ? "complete" : "ranged";
    return {
      path: match[1],
      kind,
      descriptor: match[2],
      sha256: match[3],
      stable: match[4] === "true",
      contentLines,
      signals,
    };
  });
}

// Parses the exact report produced by packages/filesystem/lib/read-engine.js.
// Returned source evidence appears before the summary report, so it is parsed
// separately and attached to each file instead of being discarded as metadata.
export function parseReadResult(text) {
  if (typeof text !== "string") return null;
  const header = text.match(/^READ RESULT: (SUCCESS|PARTIAL SUCCESS|FAILED)$/m);
  if (!header) return null;
  const result = {
    status: header[1], outcome: "", files: [], evidence: [], consolidation: [], omitted: [], unavailable: [], possiblePaths: [], recovery: [], budget: {}, editContext: {}, notes: [], raw: text,
  };
  result.evidence = parseReturnedBlocks(text, header.index);
  const sections = text.slice(header.index + header[0].length).split(/\r?\n\r?\n/);
  for (const section of sections) {
    if (!section) continue;
    const label = section.match(SECTION_LABEL);
    if (label) {
      const name = label[1];
      const body = section.slice(label[0].length);
      const values = body.split(/\r?\n/).filter((line) => line.startsWith("- ")).map((line) => line.slice(2));
      if (name === "RETURNED EVIDENCE") {
        for (const value of values) {
          if (value === "none") continue;
          const complete = value.match(/^(.+?): (bounded head\/tail complete-file evidence|complete file); returned_rendered_bytes=(\d+); source_bytes=(\d+); encoding=([^;]+); sha256=([0-9a-f]+)$/);
          if (complete) {
            result.files.push({ path: complete[1], kind: "complete", bounded: complete[2].startsWith("bounded"), returnedRenderedBytes: Number(complete[3]), sourceBytes: Number(complete[4]), encoding: complete[5], sha256: complete[6] });
            continue;
          }
          const ranged = value.match(/^(.+?): (\d+) ranged section\(s\); returned_rendered_bytes=(\d+); encoding=([^;]+); sha256=([0-9a-f]+)$/);
          if (ranged) {
            result.files.push({ path: ranged[1], kind: "ranged", ranges: Number(ranged[2]), returnedRenderedBytes: Number(ranged[3]), encoding: ranged[4], sha256: ranged[5] });
            continue;
          }
          result.files.push({ path: value, kind: "unknown" });
        }
      } else if (name === "REQUEST CONSOLIDATION") result.consolidation = values.filter((value) => value !== "No duplicate or already-covered requests.");
      else if (name === "BOUNDED OR OMITTED EVIDENCE") {
        for (const value of values) {
          if (value === "None; all returned text fit the shared budget.") continue;
          const omitted = value.match(/^(.+?): omitted lines (\d+)-(\d+); decoded bytes (\d+)-(\d+); (\d+) decoded byte\(s\) omitted$/);
          if (omitted) result.omitted.push({ path: omitted[1], lines: `${omitted[2]}-${omitted[3]}`, bytes: Number(omitted[6]) });
          else result.omitted.push({ path: value.split(": ")[0] ?? value, note: value });
        }
      } else if (name === "UNAVAILABLE TARGETS") {
        for (const value of values) {
          if (value === "None.") continue;
          const index = value.indexOf(": ");
          result.unavailable.push(index >= 0 ? { path: value.slice(0, index), reason: value.slice(index + 2) } : { path: value, reason: "" });
        }
      } else if (name === "POSSIBLE PATHS FOR MISSING TARGETS") result.possiblePaths = values.filter((value) => !value.startsWith("None."));
      else if (name === "READ RECOVERY") result.recovery = values.filter((value) => value !== "No retry or stability recovery was needed.");
      continue;
    }
    if (section.startsWith("WHAT HAPPENED: ")) result.outcome = section.slice("WHAT HAPPENED: ".length);
    else if (section.startsWith("OUTPUT BUDGET:")) {
      for (const line of section.split(/\r?\n/).slice(1)) { const key = line.match(/^  ([^:]+): (.+)$/); if (key) result.budget[key[1]] = key[2]; }
    } else if (section.startsWith("EDIT CONTEXT:")) {
      for (const line of section.split(/\r?\n/).slice(1)) { const key = line.match(/^  ([^:]+): (.+)$/); if (key) result.editContext[key[1]] = key[2]; }
    } else result.notes.push(section.trim());
  }
  const unused = [...result.evidence];
  for (const file of result.files) {
    const index = unused.findIndex((item) => item.path === file.path && item.kind === file.kind);
    if (index >= 0) file.evidence = unused.splice(index, 1)[0];
  }
  return result;
}
