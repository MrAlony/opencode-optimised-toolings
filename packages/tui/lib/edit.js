const SECTION_LABEL = /^([A-Z][A-Z /]+) \((\d+)\):$/gm;

function field(lines, prefix) {
  return lines.find((line) => line.startsWith(prefix))?.slice(prefix.length) ?? "";
}

function parseFileDetail(block) {
  const lines = block.split(/\r?\n/);
  const head = lines[0]?.match(/^(FILE CREATED|FILE UPDATED|FILE ALREADY SATISFIED): (.+)$/);
  if (!head) return null;
  return {
    kind: head[1] === "FILE CREATED" ? "created" : head[1] === "FILE UPDATED" ? "updated" : "already-satisfied",
    path: head[2],
    actions: Number(field(lines, "  Actions evaluated: ")) || null,
    size: field(lines, "  Final text size: ") || null,
    sha256: field(lines, "  Final SHA-256: ") || null,
    aliases: field(lines, "  Equivalent requested paths: ")?.split(", ").filter(Boolean) ?? [],
    recovery: lines.filter((line) => line.startsWith("  Recovery used: ")).map((line) => line.slice(17)),
    noOps: lines.filter((line) => line.startsWith("  No-op confirmed: ")).map((line) => line.slice(19)),
  };
}

function parseRejected(block) {
  const lines = block.split(/\r?\n/);
  const head = lines[0]?.match(/^FILE NOT CHANGED: (.+)$/);
  if (!head) return null;
  return {
    path: head[1],
    failedStep: field(lines, "  Failed step: "),
    expected: field(lines, "  Expected: "),
    observed: field(lines, "  Observed: "),
    safety: field(lines, "  Safety outcome: "),
    raw: block,
  };
}

function fileBlocks(body, rejected = false) {
  const head = rejected ? /^FILE NOT CHANGED: /gm : /^FILE (?:CREATED|UPDATED|ALREADY SATISFIED): /gm;
  const matches = [...body.matchAll(head)];
  return matches.map((match, index) => body.slice(match.index, matches[index + 1]?.index ?? body.length).trim());
}

export function parseEditResult(text) {
  if (typeof text !== "string") return null;
  const header = text.match(/^EDIT RESULT: (SUCCESS|PARTIAL SUCCESS|FAILED)$/m);
  if (!header) return null;
  const result = { status: header[1], outcome: "", applied: [], unchanged: [], rejected: [], declared: {}, consistency: [], readWriteRecovery: [], technicalSummary: {}, safetyModel: "", notes: [], raw: text };
  const source = text.slice(header.index + header[0].length).trim();
  const labels = [...source.matchAll(SECTION_LABEL)];
  const firstSection = labels[0]?.index ?? source.length;
  const preface = source.slice(0, firstSection).trim();
  result.outcome = preface.match(/^WHAT HAPPENED: (.+)$/m)?.[1] ?? "";
  for (let index = 0; index < labels.length; index += 1) {
    const match = labels[index];
    const name = match[1];
    const declared = Number(match[2]);
    const body = source.slice(match.index + match[0].length, labels[index + 1]?.index ?? source.length).trim();
    result.declared[name] = declared;
    if (name === "APPLIED" || name === "UNCHANGED") {
      const list = name === "APPLIED" ? result.applied : result.unchanged;
      for (const block of fileBlocks(body)) { const item = parseFileDetail(block); if (item) list.push(item); }
      if (list.length !== declared) result.consistency.push(`${name.toLowerCase()}: declared ${declared}, parsed ${list.length}`);
    } else if (name === "REJECTED") {
      for (const block of fileBlocks(body, true)) { const item = parseRejected(block); if (item) result.rejected.push(item); }
      if (result.rejected.length !== declared) result.consistency.push(`rejected: declared ${declared}, parsed ${result.rejected.length}`);
    } else if (name === "READ/WRITE RECOVERY") {
      result.readWriteRecovery = body.split(/\r?\n/).filter((line) => line.startsWith("- ")).map((line) => line.slice(2)).filter((value) => value !== "none required");
    }
  }
  const technical = source.match(/TECHNICAL SUMMARY:\r?\n([\s\S]*?)(?:\r?\n\r?\n|$)/)?.[1] ?? "";
  for (const line of technical.split(/\r?\n/)) { const key = line.match(/^  ([^:]+): (.+)$/); if (key) result.technicalSummary[key[1]] = key[2]; }
  result.safetyModel = source.match(/^SAFETY MODEL: (.+)$/m)?.[1] ?? "";
  return result;
}
