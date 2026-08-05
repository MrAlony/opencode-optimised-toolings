const SECTION_LABEL = /^([A-Z][A-Z /]+) \((\d+)\):/;

function parseFileDetail(block) {
  const lines = block.split(/\r?\n/);
  const head = lines[0]?.match(/^(FILE CREATED|FILE UPDATED|FILE ALREADY SATISFIED): (.+)$/);
  if (!head) return null;
  const item = {
    kind: head[1] === "FILE CREATED" ? "created" : head[1] === "FILE UPDATED" ? "updated" : "already-satisfied",
    path: head[2],
    actions: null,
    size: null,
    sha256: null,
    aliases: null,
    recovery: [],
    noOps: [],
  };
  for (const line of lines.slice(1)) {
    if (line.startsWith("  Actions evaluated: ")) item.actions = Number(line.slice(21));
    else if (line.startsWith("  Final text size: ")) item.size = line.slice(19);
    else if (line.startsWith("  Final SHA-256: ")) item.sha256 = line.slice(17);
    else if (line.startsWith("  Equivalent requested paths: ")) item.aliases = line.slice(30).split(", ");
    else if (line.startsWith("  Recovery used: ")) item.recovery.push(line.slice(17));
    else if (line.startsWith("  No-op confirmed: ")) item.noOps.push(line.slice(19));
  }
  return item;
}

function parseRejected(block) {
  const lines = block.split(/\r?\n/);
  const head = lines[0]?.match(/^FILE NOT CHANGED: (.+)$/);
  if (!head) return null;
  const item = { path: head[1], failedStep: "", expected: "", observed: "", safety: "", raw: block };
  for (const line of lines.slice(1)) {
    if (line.startsWith("  Failed step: ")) item.failedStep = line.slice(15);
    else if (line.startsWith("  Expected: ")) item.expected = line.slice(12);
    else if (line.startsWith("  Observed: ")) item.observed = line.slice(12);
    else if (line.startsWith("  Safety outcome: ")) item.safety = line.slice(18);
  }
  return item;
}

// Parses the exact report produced by packages/filesystem/lib/edit-engine.js
// executeEditMany. Returns null when the text is not an edit report so the TUI
// renderer can fall back to the generic card. The tool output contract is
// never changed; this only reads it.
export function parseEditResult(text) {
  if (typeof text !== "string") return null;
  const header = text.match(/^EDIT RESULT: (SUCCESS|PARTIAL SUCCESS|FAILED)$/m);
  if (!header) return null;
  const result = {
    status: header[1],
    outcome: "",
    applied: [],
    unchanged: [],
    rejected: [],
    readWriteRecovery: [],
    technicalSummary: {},
    safetyModel: "",
    notes: [],
    raw: text,
  };
  const sections = text.slice(header.index + header[0].length).split(/\r?\n\r?\n/);
  for (const section of sections) {
    if (!section) continue;
    const label = section.match(SECTION_LABEL);
    if (label) {
      const name = label[1];
      const body = section.slice(label[0].length).replace(/^\r?\n/, "");
      if (name === "APPLIED" || name === "UNCHANGED") {
        if (body.trim() === "- none") continue;
        const list = name === "APPLIED" ? result.applied : result.unchanged;
        for (const block of body.split(/\r?\n\r?\n/)) {
          const parsed = parseFileDetail(block);
          if (parsed) list.push(parsed);
        }
      } else if (name === "REJECTED") {
        if (body.trim() === "- none") continue;
        for (const block of body.split(/\r?\n\r?\n/)) {
          const parsed = parseRejected(block);
          if (parsed) result.rejected.push(parsed);
        }
      } else if (name === "READ/WRITE RECOVERY") {
        result.readWriteRecovery = body
          .split(/\r?\n/)
          .filter((line) => line.startsWith("- "))
          .map((line) => line.slice(2))
          .filter((value) => value !== "none required");
      }
      continue;
    }
    if (section.startsWith("WHAT HAPPENED: ")) {
      result.outcome = section.slice("WHAT HAPPENED: ".length);
    } else if (section.startsWith("TECHNICAL SUMMARY:")) {
      for (const line of section.split(/\r?\n/).slice(1)) {
        const key = line.match(/^  ([^:]+): (.+)$/);
        if (key) result.technicalSummary[key[1]] = key[2];
      }
    } else if (section.startsWith("SAFETY MODEL: ")) {
      result.safetyModel = section.slice("SAFETY MODEL: ".length);
    } else {
      result.notes.push(section.trim());
    }
  }
  return result;
}
